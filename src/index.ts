/** Host plugin for Mix routing and session-scoped image analysis. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage, type ContentBlock, type GenerateOptions, type UserMessage } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { defineTool, type PostToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import {
  analyzeAttachment,
  analyzeMessageImages,
  createAnalysisContext,
  explicitlyReferencesImage,
  MixedAdapter,
  parseImageReferenceDecision,
  requestBatchText,
  renderVisionPrompt,
} from './bridge.ts'
import { UnconfiguredVisionBackend } from './backend.ts'
import {
  Config as ConfigSchema,
  MIX_MODEL,
  MIX_PROVIDER,
  resolveConfig,
  RoutingSettingsSchema,
  type Config as PluginConfig,
} from './config.ts'
import { CallHistory, type VisionCallRecord, type VisionCallSuccess } from './history.ts'
import {
  createHistoryHandlers,
  createGenerationHandlers,
  createGenerationSetupHandlers,
  createSettingsHandlers,
  createVisionSetupHandlers,
  type HttpRequest,
  type HttpResponse,
} from './http.ts'
import { generateText, LlmVisionBackend } from './llm-backend.ts'
import { listSelectableModels } from './model-catalog.ts'
import { VISION_MIX_SETTINGS_NAMESPACE, createSettingsController } from './settings.ts'
import { GenerationHistory, GenerationId, type GenerationRecord } from './generation-history.ts'
import type { ImageGenerationBackend } from './image-generation-backend.ts'
import { OpenAiImageBackend } from './openai-image-backend.ts'
import type { ImageGenerationQuality, ImageGenerationSize, ImageOutputFormat } from './config.ts'
import { VisionSetupService } from './vision-setup.ts'
import { testGenerationRoute } from './generation-setup.ts'

export const name = 'dsh-vision-mix'
export const inject = ['agents', 'attachments', 'llm', 'settings', 'tools']
export const Config = ConfigSchema
export type Config = PluginConfig
export type {
  GeneratedImage, ImageEditRequest, ImageGenerationBackend, ImageGenerationRequest,
} from './image-generation-backend.ts'

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const GENERATED_IMAGE_TOOLS = new Set(['vision_mix_image_generate', 'vision_mix_image_edit'])

interface GeneratedImageValue {
  operation: 'generate' | 'edit'
  prompt: string
  image: {
    attachmentId: string
    mediaType: Exclude<ImageMediaType, 'image/gif'>
    bytes: number
    width: number
    height: number
    name?: string
  }
}

const IMAGE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    operation: { type: 'string' as const, enum: ['generate', 'edit'], required: true },
    prompt: { type: 'string' as const, required: true },
    image: {
      type: 'object' as const,
      required: true,
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' as const, required: true },
        mediaType: { type: 'string' as const, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
        bytes: { type: 'integer' as const, required: true },
        width: { type: 'integer' as const, required: true },
        height: { type: 'integer' as const, required: true },
        name: { type: 'string' as const },
      },
    },
  },
} as const

function generatedImageContent(value: GeneratedImageValue): ContentBlock[] {
  const ref: ImageAttachmentRef = {
    attachmentId: AttachmentId(value.image.attachmentId),
    mediaType: value.image.mediaType,
    bytes: value.image.bytes,
    width: value.image.width,
    height: value.image.height,
    ...(value.image.name === undefined ? {} : { name: value.image.name }),
  }
  return [
    { type: 'text', text: `<generated-image operation="${value.operation}" attachment_id="${ref.attachmentId}">${value.prompt}</generated-image>` },
    { type: 'image', attachment: ref },
  ]
}

function generatedValue(operation: 'generate' | 'edit', prompt: string, ref: ImageAttachmentRef): GeneratedImageValue {
  if (ref.mediaType === 'image/gif') throw new TypeError('vision-mix: generated images cannot use GIF')
  return {
    operation,
    prompt,
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    },
  }
}

interface WebRouteRegistry {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: HttpRequest, response: HttpResponse) => void | Promise<void>
  }): () => void
}

interface PendingVisionStep {
  agent: Agent
  messages: UserMessage[]
}

function webRouteRegistry(ctx: Context): WebRouteRegistry | undefined {
  const services = ctx as unknown as { webServer?: WebRouteRegistry; httpServer?: WebRouteRegistry }
  return services.webServer ?? services.httpServer
}

function imageAttachments(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const block of blocks) {
    if (block.type === 'image') refs.push(block.attachment)
    else if (block.type === 'tool-result') refs.push(...imageAttachments(block.content))
  }
  return refs
}

function toolContext(exec: ToolExecution): string {
  let args: string
  try {
    args = JSON.stringify(exec.arguments)
  } catch {
    args = '[unavailable]'
  }
  return `Tool: ${exec.name}\nArguments: ${args}`
}

async function toolVisionRequest(ctx: Context, config: ReturnType<typeof resolveConfig>, exec: ToolExecution): Promise<string> {
  const fallback = [
    'Describe this tool-produced image for the agent.',
    'Focus on visible text, page structure, interaction state, errors, and abnormalities relevant to the tool call.',
    toolContext(exec),
  ].join('\n')
  if (config.intentModel === undefined) return fallback
  const generated = await generateText(ctx, config.intentModel, [{
    content: [{
      type: 'text',
      text: [
        'Write one concise image-analysis request for a vision model.',
        'Return only the request. Do not claim to have seen the image.',
        toolContext(exec),
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'vision-mix' },
  }], exec.signal)
  return generated
}

function containsImage(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.content.some(block => block.type === 'image'))
}

function latestSuccessfulCall(records: readonly VisionCallRecord[]): VisionCallSuccess | undefined {
  return records.find((record): record is VisionCallSuccess => record.status === 'success')
}

async function referencesRecentImage(
  ctx: Context,
  config: ReturnType<typeof resolveConfig>,
  request: string,
  recent: VisionCallSuccess,
  signal?: AbortSignal,
): Promise<boolean> {
  if (explicitlyReferencesImage(request)) return true
  if (config.intentModel === undefined) return false
  try {
    const generated = await generateText(ctx, config.intentModel, [{
      content: [{
        type: 'text',
        text: [
          'Decide whether the current user message asks to inspect or elaborate on the most recent image in this conversation.',
          'A continuation such as "explain more", "what else is visible", or a pronoun referring to the pictured subject counts as an image reference.',
          'Ordinary conversation about an unrelated topic does not.',
          'Reply with ONLY JSON: {"referencesImage":true} or {"referencesImage":false}.',
          '',
          `Most recent image title: ${recent.title}`,
          `Most recent image analysis: ${recent.result}`,
          `Current user message: ${request}`,
        ].join('\n'),
      }],
      source: { kind: 'plugin', plugin: 'vision-mix' },
    }], signal)
    return parseImageReferenceDecision(generated)
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    return false
  }
}

/** Register the fixed Mix route, user/tool image ingress, tool, and session-history routes. */
export function apply(ctx: Context, input: PluginConfig): void {
  let config = resolveConfig(input)
  let backend = config.imageModel === undefined
    ? new UnconfiguredVisionBackend()
    : new LlmVisionBackend(ctx, config.imageModel)
  let imageGenerationBackend: ImageGenerationBackend | undefined = config.generationModel === undefined
    ? undefined
    : new OpenAiImageBackend(ctx, config.generationModel)
  let settingsSource: () => PluginConfig = () => input
  installSettingsSection(ctx, VISION_MIX_SETTINGS_NAMESPACE, RoutingSettingsSchema, input, {
    setSource: (source) => { settingsSource = source },
    validate: settings => { resolveConfig(settings) },
    onChange: () => {
      config = resolveConfig(settingsSource())
      backend = config.imageModel === undefined
        ? new UnconfiguredVisionBackend()
        : new LlmVisionBackend(ctx, config.imageModel)
      imageGenerationBackend = config.generationModel === undefined
        ? undefined
        : new OpenAiImageBackend(ctx, config.generationModel)
    },
  })
  const history = new CallHistory(join(resolveDshHome(), 'vision-mix', 'v1', 'calls'))
  const generationHistory = new GenerationHistory(join(resolveDshHome(), 'vision-mix', 'v1', 'generations'))
  const dependencies = () => ({ backend, attachments: ctx.attachments, history })
  const pendingVisionSteps = new Map<string, PendingVisionStep>()

  ctx.llm.registerAdapter([MIX_PROVIDER], new MixedAdapter(ctx, () => config, async (options: GenerateOptions) => {
    if (options.sessionId === undefined) return false
    const key = String(options.sessionId)
    const pending = pendingVisionSteps.get(key)
    if (pending === undefined) return false
    pendingVisionSteps.delete(key)
    options.signal?.throwIfAborted()

    const contexts = []
    try {
      contexts.push(...await analyzeMessageImages({
        sessionId: pending.agent.id,
        messages: pending.messages,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, dependencies()))
      if (contexts.length === 0 && !containsImage(pending.messages)) {
        const recent = latestSuccessfulCall(await history.list(pending.agent.id))
        const request = requestBatchText(pending.messages)
        if (recent !== undefined && await referencesRecentImage(ctx, config, request, recent, options.signal)) {
          const analyzed = await analyzeAttachment({
            sessionId: pending.agent.id,
            origin: 'message',
            attachment: recent.attachment,
            prompt: renderVisionPrompt(request),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }, dependencies())
          contexts.push(createAnalysisContext(analyzed.title, analyzed.result, recent.attachment))
        }
      }
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error
      contexts.push(createUserMessage({
        content: [{ type: 'text', text: `<img-caption-error>${String(error)}</img-caption-error>` }],
        source: { kind: 'plugin', plugin: 'vision-mix' },
      }))
    }
    if (contexts.length === 0) return false
    for (const context of contexts) pending.agent.steer(context)
    return true
  }))

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const enteredIds = new Set(decision.messages.map(message => message.id))
    const currentUserMessages = messages.filter(message =>
      message.source.kind === 'user' && enteredIds.has(message.id))
    if (agent.options.provider === MIX_PROVIDER && agent.options.model === MIX_MODEL
      && currentUserMessages.length > 0) {
      pendingVisionSteps.set(String(agent.id), { agent, messages: currentUserMessages })
    }
    return decision
  }, { prepend: true })

  ctx.on('agent/disposed', ({ agent }) => {
    pendingVisionSteps.delete(String(agent.id))
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (!config.autoAnalyzeToolImages || exec.agent === undefined || result.isError
      || decision.kind !== 'accept' || exec.name === 'vision_mix_image_query'
      || GENERATED_IMAGE_TOOLS.has(exec.name)) return decision
    const content = decision.content ?? result.content
    const attachments = imageAttachments(content)
    if (attachments.length === 0) return decision
    const question = await toolVisionRequest(ctx, config, exec)
    const contexts = []
    for (const attachment of attachments) {
      try {
        const analyzed = await analyzeAttachment({
          sessionId: exec.agent.id,
          origin: 'tool-result',
          attachment,
          prompt: renderVisionPrompt(question),
          signal: exec.signal,
        }, dependencies())
        contexts.push(createAnalysisContext(analyzed.title, analyzed.result, attachment))
      } catch (error: unknown) {
        if (exec.signal.aborted) return decision
        contexts.push(createUserMessage({
          content: [{ type: 'text', text: `<img-caption-error>${String(error)}</img-caption-error>` }],
          source: { kind: 'plugin', plugin: 'vision-mix' },
        }))
      }
    }
    return {
      ...decision,
      additionalContexts: [...(decision.additionalContexts ?? []), ...contexts],
    }
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'vision_mix_image_query',
    description: 'Analyze a local image with the configured image model and answer one question about it.',
    parameters: {
      image_path: { type: 'string', required: true, description: 'Absolute path to an image file' },
      question: { type: 'string', required: true, description: 'Question or extraction request for the image' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('vision-mix: image_query requires a session-owned agent call')
      if (!isAbsolute(args.image_path)) throw new Error('vision-mix: image_path must be absolute')
      const mediaType = MEDIA_TYPES[extname(args.image_path).toLowerCase()]
      if (mediaType === undefined) throw new Error(`vision-mix: unsupported image type: ${args.image_path}`)
      const data = await readFile(args.image_path)
      const attachment = await ctx.attachments.saveImage({ data, mediaType, name: basename(args.image_path) })
      const analyzed = await analyzeAttachment({
        sessionId: exec.agent.id,
        origin: 'tool',
        attachment,
        prompt: renderVisionPrompt(args.question.trim() || 'Describe the image in detail.'),
        signal: exec.signal,
      }, dependencies())
      return analyzed.result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_mix_attachment_query',
    description: 'Reopen one DSH-uploaded image by its attachment_id and answer a new pixel-level question. The attachment must belong to the current session.',
    parameters: {
      attachment_id: { type: 'string', required: true, description: 'Opaque attachment_id such as sha256:… from an image-attachment or img-caption context' },
      question: { type: 'string', required: true, description: 'Question or extraction request for the stored image' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('vision-mix: attachment_query requires a session-owned agent call')
      const record = (await history.list(exec.agent.id)).find(item =>
        String(item.attachment.attachmentId) === args.attachment_id)
      if (record === undefined) {
        throw new Error(`vision-mix: attachment "${args.attachment_id}" is not available in this session`)
      }
      const analyzed = await analyzeAttachment({
        sessionId: exec.agent.id,
        origin: 'tool',
        attachment: record.attachment,
        prompt: renderVisionPrompt(args.question.trim() || 'Describe the image in detail.'),
        signal: exec.signal,
      }, dependencies())
      return analyzed.result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_mix_image_generate',
    description: 'Generate a new image from a detailed prompt with the image model configured in Vision Mix. Returns a durable DSH attachment that is shown in the conversation.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed visual description of the image to create' },
      size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'], description: 'Output dimensions; defaults to Vision Mix settings' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: 'Output quality; defaults to Vision Mix settings' },
      output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Stored image format; defaults to Vision Mix settings' },
    },
    output: {
      schema: IMAGE_OUTPUT_SCHEMA,
      render: (_args, value) => generatedImageContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('vision-mix: image_generate requires a session-owned agent call')
      const active = imageGenerationBackend
      if (active === undefined) throw new Error('vision-mix: configure an image generation model in Vision Mix settings first')
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new TypeError('vision-mix: image generation prompt must be non-empty')
      const size = (args.size ?? config.generationDefaults.size) as ImageGenerationSize
      const quality = (args.quality ?? config.generationDefaults.quality) as ImageGenerationQuality
      const outputFormat = (args.output_format ?? config.generationDefaults.outputFormat) as ImageOutputFormat
      const createdAt = Date.now()
      const base = {
        id: GenerationId(randomUUID()),
        sessionId: exec.agent.id,
        createdAt,
        operation: 'generate' as const,
        backendId: active.id,
        model: active.model,
        prompt,
        sourceAttachments: [],
        size,
        quality,
        outputFormat,
      }
      try {
        const generated = await active.generate({ prompt, size, quality, outputFormat, signal: exec.signal })
        const extension = outputFormat === 'jpeg' ? 'jpg' : outputFormat
        const outputAttachment = await ctx.attachments.saveImage({
          data: generated.data,
          mediaType: generated.mediaType,
          name: `vision-mix-${createdAt}.${extension}`,
        })
        await generationHistory.append({
          ...base,
          durationMs: Date.now() - createdAt,
          status: 'success',
          outputAttachment,
        })
        return generatedValue('generate', prompt, outputAttachment)
      } catch (error: unknown) {
        await generationHistory.append({
          ...base,
          durationMs: Date.now() - createdAt,
          status: 'error',
          error: String(error),
        })
        throw error
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_mix_image_edit',
    description: 'Edit a current-session image attachment with the configured image model. Use the attachment_id from a prior image or generated-image context; the edited image is returned as a new durable attachment.',
    parameters: {
      attachment_id: { type: 'string', required: true, description: 'Current-session DSH attachment_id to edit' },
      prompt: { type: 'string', required: true, description: 'Detailed instructions describing the desired changes' },
      size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'], description: 'Output dimensions; defaults to Vision Mix settings' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: 'Output quality; defaults to Vision Mix settings' },
      output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Stored image format; defaults to Vision Mix settings' },
    },
    output: {
      schema: IMAGE_OUTPUT_SCHEMA,
      render: (_args, value) => generatedImageContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('vision-mix: image_edit requires a session-owned agent call')
      const active = imageGenerationBackend
      if (active === undefined) throw new Error('vision-mix: configure an image generation model in Vision Mix settings first')
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new TypeError('vision-mix: image edit prompt must be non-empty')
      const [visionRecords, generationRecords] = await Promise.all([
        history.list(exec.agent.id), generationHistory.list(exec.agent.id),
      ])
      const sourceAttachment = visionRecords.find(record => String(record.attachment.attachmentId) === args.attachment_id)?.attachment
        ?? generationRecords.find((record): record is Extract<GenerationRecord, { status: 'success' }> =>
          record.status === 'success' && String(record.outputAttachment.attachmentId) === args.attachment_id)?.outputAttachment
      if (sourceAttachment === undefined) {
        throw new Error(`vision-mix: attachment "${args.attachment_id}" is not available for editing in this session`)
      }
      const stored = await ctx.attachments.readImage(sourceAttachment, exec.signal)
      const size = (args.size ?? config.generationDefaults.size) as ImageGenerationSize
      const quality = (args.quality ?? config.generationDefaults.quality) as ImageGenerationQuality
      const outputFormat = (args.output_format ?? config.generationDefaults.outputFormat) as ImageOutputFormat
      const createdAt = Date.now()
      const base = {
        id: GenerationId(randomUUID()),
        sessionId: exec.agent.id,
        createdAt,
        operation: 'edit' as const,
        backendId: active.id,
        model: active.model,
        prompt,
        sourceAttachments: [sourceAttachment],
        size,
        quality,
        outputFormat,
      }
      try {
        const generated = await active.edit({ images: [stored], prompt, size, quality, outputFormat, signal: exec.signal })
        const extension = outputFormat === 'jpeg' ? 'jpg' : outputFormat
        const outputAttachment = await ctx.attachments.saveImage({
          data: generated.data,
          mediaType: generated.mediaType,
          name: `vision-mix-edit-${createdAt}.${extension}`,
        })
        await generationHistory.append({
          ...base,
          durationMs: Date.now() - createdAt,
          status: 'success',
          outputAttachment,
        })
        return generatedValue('edit', prompt, outputAttachment)
      } catch (error: unknown) {
        await generationHistory.append({
          ...base,
          durationMs: Date.now() - createdAt,
          status: 'error',
          error: String(error),
        })
        throw error
      }
    },
  }))

  const historyHandlers = createHistoryHandlers({ history, attachments: ctx.attachments })
  const generationHandlers = createGenerationHandlers({ history: generationHistory, attachments: ctx.attachments })
  const settingsHandlers = createSettingsHandlers(createSettingsController({
    current: () => config,
    settings: ctx.settings,
  }), { list: () => listSelectableModels(ctx) })
  const visionSetupHandlers = createVisionSetupHandlers(new VisionSetupService(ctx))
  const generationSetupHandlers = createGenerationSetupHandlers({ test: route => testGenerationRoute(ctx, route) })
  let activeRegistry: WebRouteRegistry | undefined
  const mountRoutes = (routeCtx: Context): void => {
    const registry = webRouteRegistry(routeCtx)
    if (registry === undefined || activeRegistry !== undefined) return
    activeRegistry = registry
    routeCtx.effect(() => {
      const dispose = [
        registry.register({ kind: 'exact', path: '/vision-mix/calls', handler: historyHandlers.calls }),
        registry.register({ kind: 'prefix', path: '/vision-mix/image', handler: historyHandlers.image }),
        registry.register({ kind: 'exact', path: '/vision-mix/generations', handler: generationHandlers.generations }),
        registry.register({ kind: 'prefix', path: '/vision-mix/generated-image', handler: generationHandlers.image }),
        registry.register({ kind: 'exact', path: '/vision-mix/settings', handler: settingsHandlers.settings }),
        registry.register({ kind: 'exact', path: '/vision-mix/models', handler: settingsHandlers.models }),
        registry.register({ kind: 'exact', path: '/vision-mix/vision-setup', handler: visionSetupHandlers.setup }),
        registry.register({ kind: 'exact', path: '/vision-mix/generation-setup', handler: generationSetupHandlers.test }),
      ]
      return () => {
        for (const unregister of dispose.reverse()) unregister()
        if (activeRegistry === registry) activeRegistry = undefined
      }
    }, 'vision-mix: web routes')
  }
  ctx.inject(['webServer'], mountRoutes)
  ctx.inject(['httpServer'], mountRoutes)
}
