import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  deepEqualJson, settingsNamespace, type SettingsNamespace, type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoute } from './config.ts'

const RED_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==',
  'base64',
)

interface SettingsDescriptorLike {
  ns: string
  revision: number
  value: unknown
}

interface CapabilityEdit {
  ns: SettingsNamespace
  path: string[]
  before: unknown
  after: unknown
  beforePresent: boolean
}

/** Result displayed after one image-capability setup action. */
export interface VisionSetupResult {
  action: 'test' | 'enable' | 'auto'
  route: ModelRoute
  imageEnabled: boolean
  selected: boolean
  message: string
  response?: string
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`vision-mix: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) current = object(current, `settings path ${path.join('.')}`)[segment]
  return current
}

function hasOwn(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key)
}

function descriptor(ctx: Context, ns: SettingsNamespace): SettingsDescriptorLike {
  const found = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === ns)
  if (found === undefined) throw new Error(`vision-mix: settings namespace "${ns}" is unavailable`)
  return found
}

function capabilityEdit(ctx: Context, route: ModelRoute): CapabilityEdit {
  const directory = ctx.llm.listConfigurableProviders().find(entry => entry.provider === route.provider)
  if (directory === undefined) {
    throw new Error(`vision-mix: provider "${route.provider}" cannot be edited from DSH Models settings`)
  }
  const ns = settingsNamespace(directory.settingsNs)
  const snapshot = descriptor(ctx, ns)
  const profile = object(valueAt(snapshot.value, directory.settingsPath), `profile for provider "${route.provider}"`)
  if (Array.isArray(profile.models)) {
    const models = profile.models.map((entry, index) => ({ ...object(entry, `model ${index + 1}`) }))
    const index = models.findIndex(model => model.id === route.model)
    if (index < 0) throw new Error(`vision-mix: model "${route.model}" is not present in provider "${route.provider}" settings`)
    const current = models[index]!
    models[index] = { ...current, input: ['text', 'image'] }
    return {
      ns,
      path: [...directory.settingsPath, 'models'],
      before: structuredClone(profile.models),
      after: models,
      beforePresent: true,
    }
  }
  const overrides = profile.modelOverrides === undefined
    ? {}
    : object(profile.modelOverrides, `model overrides for provider "${route.provider}"`)
  const current = overrides[route.model] === undefined
    ? {}
    : object(overrides[route.model], `model override for "${route.model}"`)
  return {
    ns,
    path: [...directory.settingsPath, 'modelOverrides'],
    before: structuredClone(overrides),
    after: { ...structuredClone(overrides), [route.model]: { ...structuredClone(current), input: ['text', 'image'] } },
    beforePresent: hasOwn(profile, 'modelOverrides'),
  }
}

async function applyEdit(ctx: Context, edit: CapabilityEdit): Promise<void> {
  const snapshot = descriptor(ctx, edit.ns)
  await ctx.settings.mutate(edit.ns, [{ op: 'set', path: edit.path, value: edit.after }], snapshot.revision)
}

async function rollbackEdit(ctx: Context, edit: CapabilityEdit): Promise<void> {
  const snapshot = descriptor(ctx, edit.ns)
  const current = valueAt(snapshot.value, edit.path)
  if (!deepEqualJson(current, edit.after)) {
    throw new Error('vision-mix: provider settings changed during the image test; refusing to overwrite the newer edit')
  }
  const op: SettingsPathOp = edit.beforePresent
    ? { op: 'set', path: edit.path, value: edit.before }
    : { op: 'unset', path: edit.path }
  await ctx.settings.mutate(edit.ns, [op], snapshot.revision)
}

async function selectImageModel(ctx: Context, route: ModelRoute): Promise<void> {
  const ns = settingsNamespace('vision-mix')
  const snapshot = descriptor(ctx, ns)
  await ctx.settings.mutate(ns, [{ op: 'set', path: ['imageModel'], value: route }], snapshot.revision)
}

async function probeImage(ctx: Context, route: ModelRoute, signal?: AbortSignal): Promise<string> {
  const attachment: ImageAttachmentRef = await ctx.attachments.saveImage({
    data: RED_TEST_PNG,
    mediaType: 'image/png',
    name: 'vision-mix-image-capability-test.png',
  })
  let output = ''
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [
        { type: 'text', text: 'This is a solid-color image capability test. Inspect the pixels and reply with only the color name.' },
        { type: 'image', attachment },
      ],
      source: { kind: 'plugin', plugin: 'vision-mix' },
    })],
    ...(signal === undefined ? {} : { signal }),
  })) {
    if (chunk.type === 'text-delta') output += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(`vision-mix: image capability test failed: ${chunk.reason.failure.message}`)
    }
  }
  const response = output.trim()
  if (!/(?:\bred\b|红(?:色)?)/iu.test(response)) {
    throw new Error(`vision-mix: the model accepted an image but did not identify the red test tile; response: ${response || '[empty]'}`)
  }
  return response
}

/** Configuration-time image capability workflow with rollback on tests and failed automatic setup. */
export class VisionSetupService {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly ctx: Context) {}

  private serial<T>(route: ModelRoute, task: () => Promise<T>): Promise<T> {
    const key = `${route.provider}\0${route.model}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.queues.set(key, next)
    return next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) })
  }

  /** Test with a temporary image declaration and always restore the previous Provider settings. */
  test(route: ModelRoute, signal?: AbortSignal): Promise<VisionSetupResult> {
    return this.serial(route, async () => {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      const alreadyEnabled = info.inputModalities?.includes('image') === true
      const edit = alreadyEnabled ? undefined : capabilityEdit(this.ctx, route)
      if (edit !== undefined) await applyEdit(this.ctx, edit)
      try {
        const response = await probeImage(this.ctx, route, signal)
        return {
          action: 'test', route, imageEnabled: alreadyEnabled, selected: false,
          message: alreadyEnabled
            ? '图片测试通过；该模型已经声明 image 能力。'
            : '图片测试通过；临时能力声明已回滚，点击“强制启用”或“一键自动配置”可正式保存。',
          response,
        }
      } finally {
        if (edit !== undefined) await rollbackEdit(this.ctx, edit)
      }
    })
  }

  /** Persist image capability without making a paid model request, then select the route. */
  enable(route: ModelRoute): Promise<VisionSetupResult> {
    return this.serial(route, async () => {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model)
      const edit = info.inputModalities?.includes('image') === true ? undefined : capabilityEdit(this.ctx, route)
      if (edit !== undefined) await applyEdit(this.ctx, edit)
      try {
        await selectImageModel(this.ctx, route)
      } catch (error: unknown) {
        if (edit !== undefined) await rollbackEdit(this.ctx, edit)
        throw error
      }
      return {
        action: 'enable', route, imageEnabled: true, selected: true,
        message: '已强制声明 image 能力，并设为 Vision Mix 图片模型。此操作没有验证中转站是否真的支持图片。',
      }
    })
  }

  /** Persist a temporary declaration only after a real image test succeeds; failed tests roll back. */
  auto(route: ModelRoute, signal?: AbortSignal): Promise<VisionSetupResult> {
    return this.serial(route, async () => {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      const alreadyEnabled = info.inputModalities?.includes('image') === true
      const edit = alreadyEnabled ? undefined : capabilityEdit(this.ctx, route)
      if (edit !== undefined) await applyEdit(this.ctx, edit)
      try {
        const response = await probeImage(this.ctx, route, signal)
        await selectImageModel(this.ctx, route)
        return {
          action: 'auto', route, imageEnabled: true, selected: true,
          message: '真实图片测试通过，已保存 image 能力并设为 Vision Mix 图片模型。',
          response,
        }
      } catch (error: unknown) {
        if (edit !== undefined) await rollbackEdit(this.ctx, edit)
        throw error
      }
    })
  }
}
