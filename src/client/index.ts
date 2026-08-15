/** Browser plugin for Vision Mix routing settings and session-scoped vision history. */
import type { Context } from '@deepseek-ai/cordis'
import { Button, IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type {
  ImageGenerationQuality, ImageGenerationSize, ImageOutputFormat, ModelRoute, ResolvedConfig,
} from '../config.ts'
import { attachmentLocator, callsUrl, groupCalls, imageUrl, parseCallsPayload, type VisionCallView } from './model.ts'
import { generatedImageUrl, generationsUrl, parseGenerationsPayload, type GenerationView } from './generation-model.ts'
import {
  parseGenerationSetupPayload, parseModelCatalog, parseRouteValue, parseSettingsPayload, parseVisionSetupPayload, routeValue,
  type VisionMixSettingsPayload, type ModelCatalogPayload, type SelectableModelGroupView,
} from './settings-model.ts'
import css from './VisionMix.module.css'

interface TabDescriptor {
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number
  single?: boolean
  component: (props: { scope: { sessionId: string; cwd?: string } }) => unknown
}

interface BetterSidebarService { registerTab(descriptor: TabDescriptor): () => void }
interface SlotService {
  inject(name: string, register: () => unknown): void
  register(options: Record<string, unknown>, component: (props: unknown) => unknown): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { betterSidebar: BetterSidebarService; slots: SlotService }
}

export const inject = ['slots']

function visionMixIcon(size = 16): ReactNode {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true,
  },
  createElement('path', { d: 'M1.25 12.25H14.75', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }),
  createElement('path', { d: 'M2.5 12.25V9.75M13.5 12.25V9.75M2.5 9.75H13.5', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  createElement('path', { d: 'M4 9.75C4 6.45 5.62 4 8 4C10.38 4 12 6.45 12 9.75M5.75 9.75V5.25M10.25 9.75V5.25', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  createElement('path', { d: 'M1.25 14.25H14.75', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }))
}

/** Register the Vision Mix sidebar history tabs and routing settings section. */
export function apply(ctx: Context): void {
  ctx.inject(['betterSidebar'], (sidebarCtx: Context) => {
    sidebarCtx.effect(() => sidebarCtx.betterSidebar.registerTab({
      id: 'vision-mix:vision-calls', title: () => '识图记录', icon: visionMixIcon,
      order: 55, single: true,
      component: props => createElement(VisionCallsView, { sessionId: props.scope.sessionId }),
    }))
    sidebarCtx.effect(() => sidebarCtx.betterSidebar.registerTab({
      id: 'vision-mix:generation-calls', title: () => '生图记录', icon: visionMixIcon,
      order: 56, single: true,
      component: props => createElement(GenerationCallsView, { sessionId: props.scope.sessionId }),
    }))
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'vision-mix', order: 16, label: () => 'Vision Mix',
    icon: visionMixIcon, inject: () => ({}),
  }, VisionMixSettingsView))
}

function routeExists(groups: SelectableModelGroupView[], route: ModelRoute, imageOnly: boolean): boolean {
  return groups.some(group => group.id === route.provider && group.models.some(model =>
    model.id === route.model && (!imageOnly || model.inputModalities?.includes('image') === true)))
}

function modelLabel(groups: SelectableModelGroupView[], route: ModelRoute | undefined, emptyLabel = '未配置'): string {
  if (route === undefined) return emptyLabel
  const model = groups.find(group => group.id === route.provider)?.models.find(candidate => candidate.id === route.model)
  return model === undefined
    ? `当前不可用：${route.provider}/${route.model}`
    : `${model.name} (${route.provider}/${route.model})`
}

function ModelPicker(props: {
  label: string
  route: ModelRoute | undefined
  groups: SelectableModelGroupView[]
  onChange: (route: ModelRoute | undefined) => void
  disabled: boolean
  imageOnly?: boolean
  optional?: boolean
  emptyLabel?: string
  help: string
}): ReactNode {
  const { label, route, groups, onChange, disabled, help } = props
  const [open, setOpen] = useState(false)
  const imageOnly = props.imageOnly === true
  const filtered = groups.map(group => ({
    ...group,
    models: group.models.filter(model => !imageOnly || model.inputModalities?.includes('image') === true),
  })).filter(group => group.models.length > 0)
  const items: MenuEntry[] = []
  if (props.optional === true) items.push({ id: '', label: props.emptyLabel ?? '未配置' })
  if (route !== undefined && !routeExists(groups, route, imageOnly)) {
    items.push({ id: routeValue(route), label: modelLabel(groups, route), disabled: true })
  }
  for (const group of filtered) {
    items.push({ type: 'label', id: `provider:${group.id}`, text: group.name })
    for (const model of group.models) {
      const candidate = { provider: group.id, model: model.id }
      items.push({ id: routeValue(candidate), label: `${model.name} (${group.id}/${model.id})` })
    }
  }
  const selected = route === undefined ? '' : routeValue(route)
  const anchor = createElement('button', {
    type: 'button', className: css.pickerTrigger, disabled,
    'aria-haspopup': 'menu', 'aria-expanded': open,
    onClick: () => { setOpen(value => !value) },
  },
  createElement('span', { className: css.pickerText }, modelLabel(groups, route, props.emptyLabel)),
  createElement(IconChevronDownOutline14, { className: css.pickerChevron }))

  return createElement('div', { className: css.field },
    createElement('div', { className: css.fieldLabel }, label),
    createElement(Menu, {
      open, anchor, items, selectedId: selected, portal: true, className: css.pickerMenu!,
      onClose: () => { setOpen(false) },
      onSelect: (value: string) => {
        setOpen(false)
        onChange(value === '' ? undefined : parseRouteValue(value))
      },
    }),
    createElement('p', { className: css.help }, help))
}

function GenerationModelPicker(props: {
  route: ModelRoute | undefined
  providers: Array<{ id: string; name: string }>
  onChange: (route: ModelRoute | undefined) => void
  disabled: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const available = props.route === undefined || props.providers.some(provider => provider.id === props.route?.provider)
  const label = props.route === undefined
    ? '未启用'
    : `${props.route.model} (${props.route.provider})${available ? '' : ' · 当前不可用'}`
  const items: MenuEntry[] = [{ id: '', label: '未启用' }]
  if (props.route !== undefined && !available) items.push({ id: routeValue(props.route), label, disabled: true })
  for (const provider of props.providers) {
    const route = { provider: provider.id, model: 'gpt-image-2' }
    items.push({ id: routeValue(route), label: `gpt-image-2 (${provider.name} / ${provider.id})` })
  }
  const anchor = createElement('button', {
    type: 'button', className: css.pickerTrigger, disabled: props.disabled,
    'aria-haspopup': 'menu', 'aria-expanded': open,
    onClick: () => { setOpen(value => !value) },
  }, createElement('span', { className: css.pickerText }, label),
  createElement(IconChevronDownOutline14, { className: css.pickerChevron }))
  return createElement('div', { className: css.field },
    createElement('div', { className: css.fieldLabel }, '图片生成模型'),
    createElement(Menu, {
      open, anchor, items, selectedId: props.route === undefined ? '' : routeValue(props.route),
      portal: true, className: css.pickerMenu!, onClose: () => { setOpen(false) },
      onSelect: (value: string) => { setOpen(false); props.onChange(value === '' ? undefined : parseRouteValue(value)) },
    }),
    createElement('p', { className: css.help }, 'Provider 来自“设置 → 模型”，密钥和 Base URL 沿用该 Provider；不会在此重复保存。'))
}

function OptionPicker<T extends string>(props: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled: boolean
  help: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = props.options.find(option => option.value === props.value)?.label ?? props.value
  const anchor = createElement('button', {
    type: 'button', className: css.pickerTrigger, disabled: props.disabled,
    'aria-haspopup': 'menu', 'aria-expanded': open,
    onClick: () => { setOpen(value => !value) },
  }, createElement('span', { className: css.pickerText }, selected),
  createElement(IconChevronDownOutline14, { className: css.pickerChevron }))
  return createElement('div', { className: css.field },
    createElement('div', { className: css.fieldLabel }, props.label),
    createElement(Menu, {
      open, anchor, items: props.options.map(option => ({ id: option.value, label: option.label })),
      selectedId: props.value, portal: true, className: css.pickerMenu!, onClose: () => { setOpen(false) },
      onSelect: (value: string) => { setOpen(false); props.onChange(value as T) },
    }),
    createElement('p', { className: css.help }, props.help))
}

function VisionMixSettingsView(): ReactNode {
  const [snapshot, setSnapshot] = useState<VisionMixSettingsPayload | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalogPayload | null>(null)
  const [routing, setRouting] = useState<ResolvedConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [setupRoute, setSetupRoute] = useState<ModelRoute | null>(null)
  const [setupBusy, setSetupBusy] = useState<'test' | 'enable' | 'auto' | null>(null)
  const [setupResponse, setSetupResponse] = useState<string | null>(null)
  const [generationTestBusy, setGenerationTestBusy] = useState(false)
  const [generationTestPreview, setGenerationTestPreview] = useState<string | null>(null)

  const load = async (signal?: AbortSignal): Promise<void> => {
    const request = signal === undefined ? {} : { signal }
    const [settingsResponse, modelsResponse] = await Promise.all([
      fetch('/vision-mix/settings', request), fetch('/vision-mix/models', request),
    ])
    if (!settingsResponse.ok || !modelsResponse.ok) {
      throw new Error(`Vision Mix HTTP ${settingsResponse.status}/${modelsResponse.status}`)
    }
    const parsedSettings = parseSettingsPayload(await settingsResponse.json())
    setSnapshot(parsedSettings)
    setRouting(parsedSettings.routing)
    setSetupRoute(current => current ?? parsedSettings.routing.imageModel ?? null)
    setCatalog(parseModelCatalog(await modelsResponse.json()))
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(String(reason))
    })
    return () => { controller.abort() }
  }, [])

  const save = async (): Promise<void> => {
    if (snapshot === null || routing === null || saving) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/vision-mix/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, routing }),
      })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(String((body as { error?: unknown }).error ?? `HTTP ${response.status}`))
      const parsed = parseSettingsPayload(body)
      setSnapshot(parsed)
      setRouting(parsed.routing)
      setNotice('路由已保存，下一次模型、识图或生图调用立即生效。')
    } catch (reason: unknown) {
      setError(String(reason))
      await load().catch(() => undefined)
    } finally {
      setSaving(false)
    }
  }

  const runVisionSetup = async (action: 'test' | 'enable' | 'auto'): Promise<void> => {
    if (setupRoute === null || setupBusy !== null) return
    setSetupBusy(action)
    setError(null)
    setNotice(null)
    setSetupResponse(null)
    try {
      const response = await fetch('/vision-mix/vision-setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, route: setupRoute }),
      })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(String((body as { error?: unknown }).error ?? `HTTP ${response.status}`))
      const result = parseVisionSetupPayload(body)
      setNotice(result.message)
      setSetupResponse(result.response ?? null)
      await load()
    } catch (reason: unknown) {
      setError(String(reason))
      await load().catch(() => undefined)
    } finally {
      setSetupBusy(null)
    }
  }

  const testGenerationSetup = async (): Promise<void> => {
    const route = routing?.generationModel
    if (route === undefined || generationTestBusy) return
    setGenerationTestBusy(true)
    setGenerationTestPreview(null)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/vision-mix/generation-setup', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route }),
      })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(String((body as { error?: unknown }).error ?? `HTTP ${response.status}`))
      const result = parseGenerationSetupPayload(body)
      setNotice(`${result.message} 点击“保存路由”后用于 Agent 生图。`)
      setGenerationTestPreview(result.previewDataUrl ?? null)
    } catch (reason: unknown) {
      setError(String(reason))
    } finally {
      setGenerationTestBusy(false)
    }
  }

  if (snapshot === null || catalog === null || routing === null) {
    return createElement('div', { className: css.settingsSection }, error ?? '正在加载 Vision Mix 设置…')
  }
  const disabled = saving || !snapshot.available || !snapshot.writable
  return createElement('div', { className: css.settingsSection },
    createElement('div', { className: css.sectionHeading }, visionMixIcon(20),
      createElement('h2', { className: css.sectionTitle }, 'Vision Mix')),
    createElement('p', { className: css.intro },
      'Mix 是固定的虚拟模型。这里只选择“设置 → 模型”中已经配置好的模型，不重复保存 API 地址或密钥。'),
    error === null ? null : createElement('p', { role: 'alert', className: css.error }, error),
    notice === null ? null : createElement('p', { className: css.notice }, notice),
    createElement('section', { className: css.module },
      createElement('div', { className: css.moduleTitle }, '识图模型接入'),
      createElement('p', { className: css.help },
        '中转站模型经常只被 DSH 识别为文本模型。这里可以真实发送一张红色测试图，并安全写入模型的 image 能力声明。'),
      createElement(ModelPicker, {
        label: '待接入模型', route: setupRoute ?? undefined, groups: catalog.groups,
        disabled: disabled || setupBusy !== null,
        help: '列表来自“设置 → 模型”，包括尚未声明 image 能力的文本模型。测试会产生一次很小的模型请求。',
        onChange: value => { if (value !== undefined) setSetupRoute(value) },
      }),
      createElement('div', { className: css.setupActions },
        createElement(Button, {
          variant: 'outline', disabled: disabled || setupRoute === null || setupBusy !== null,
          onClick: () => { void runVisionSetup('test') },
        }, setupBusy === 'test' ? '正在测试…' : '仅测试图片能力'),
        createElement(Button, {
          variant: 'outline', disabled: disabled || setupRoute === null || setupBusy !== null,
          onClick: () => { void runVisionSetup('enable') },
        }, setupBusy === 'enable' ? '正在保存…' : '强制启用 image'),
        createElement(Button, {
          variant: 'primary', disabled: disabled || setupRoute === null || setupBusy !== null,
          onClick: () => { void runVisionSetup('auto') },
        }, setupBusy === 'auto' ? '正在自动配置…' : '一键测试并配置')),
      createElement('p', { className: css.help },
        '“仅测试”会临时声明 image 并在测试后回滚；“强制启用”不调用 API；“一键测试并配置”只有测试成功才保留声明并设为图片模型。'),
      setupResponse === null ? null : createElement('div', { className: css.probeResult },
        createElement('span', { className: css.fieldLabel }, '模型测试回答'),
        createElement('code', null, setupResponse))),
    createElement('section', { className: css.module },
      createElement('div', { className: css.moduleTitle }, '基础设置'),
      createElement('p', { className: css.help }, '图片模型列表只显示明确声明支持 image 输入的已配置模型。'),
      createElement(ModelPicker, {
        label: '基础模型', route: routing.baseModel, groups: catalog.groups, disabled,
        help: '无图片时直接使用；识图完成后也由它继续推理和回复。',
        onChange: value => {
          if (value !== undefined) setRouting(previous => previous === null ? previous : { ...previous, baseModel: value })
        },
      }),
      createElement(ModelPicker, {
        label: '图片模型', route: routing.imageModel, groups: catalog.groups, disabled, imageOnly: true,
        optional: true, emptyLabel: '未配置',
        help: '处理用户上传图片、工具截图和本地图片识别。',
        onChange: value => {
          setRouting(previous => {
            if (previous === null) return previous
            if (value !== undefined) return { ...previous, imageModel: value }
            const { imageModel: _imageModel, ...withoutImage } = previous
            return withoutImage
          })
        },
      }),
      createElement('details', { className: css.advanced },
        createElement('summary', { className: css.advancedSummary }, '高级设置'),
        createElement('div', { className: css.advancedBody },
          createElement(ModelPicker, {
            label: '意图识别模型', route: routing.intentModel, groups: catalog.groups, disabled, optional: true,
            emptyLabel: '不使用（固定规则）',
            help: '仅在工具确实返回图片后，把工具名称和参数整理成识图问题；不判断图片是否存在。',
            onChange: value => {
              setRouting(previous => {
                if (previous === null) return previous
                if (value !== undefined) return { ...previous, intentModel: value }
                const { intentModel: _intentModel, ...withoutIntent } = previous
                return withoutIntent
              })
            },
          }),
          createElement('label', { className: css.toggleRow },
            createElement('span', null, '自动识别 Agent 工具返回的截图或图片'),
            createElement('input', {
              className: css.toggle, type: 'checkbox', checked: routing.autoAnalyzeToolImages, disabled,
              onChange: (event: { target: { checked: boolean } }) => {
                setRouting(previous => previous === null ? previous : { ...previous, autoAnalyzeToolImages: event.target.checked })
              },
            }))))),
    createElement('section', { className: css.module },
      createElement('div', { className: css.moduleTitle }, '图片生成与编辑'),
      createElement('p', { className: css.help },
        '启用后，Agent 可调用 vision_mix_image_generate 和 vision_mix_image_edit；生成图直接保存为当前会话附件。'),
      createElement(GenerationModelPicker, {
        route: routing.generationModel,
        providers: catalog.generationProviders,
        disabled,
        onChange: value => {
          setRouting(previous => {
            if (previous === null) return previous
            if (value !== undefined) return { ...previous, generationModel: value }
            const { generationModel: _generationModel, ...withoutGeneration } = previous
            return withoutGeneration
          })
        },
      }),
      createElement('div', { className: css.setupActions },
        createElement(Button, {
          variant: 'outline', disabled: disabled || routing.generationModel === undefined || generationTestBusy,
          onClick: () => { void testGenerationSetup() },
        }, generationTestBusy ? '正在生成测试图…' : '测试生图 API')),
      createElement('p', { className: css.help },
        '测试固定使用 low / 1024×1024 PNG，会产生一次实际生图费用。识图模型和这里的 Provider、Base URL、API Key 可以完全不同。'),
      generationTestPreview === null ? null : createElement('img', {
        className: css.generationTestImage, src: generationTestPreview, alt: '生图 API 测试结果',
      }),
      createElement('details', { className: css.advanced },
        createElement('summary', { className: css.advancedSummary }, '默认输出参数'),
        createElement('div', { className: css.advancedBody },
          createElement(OptionPicker, {
            label: '尺寸', value: routing.generationDefaults.size, disabled,
            options: [
              { value: 'auto', label: '自动' }, { value: '1024x1024', label: '1024 × 1024（方形）' },
              { value: '1536x1024', label: '1536 × 1024（横向）' }, { value: '1024x1536', label: '1024 × 1536（纵向）' },
            ],
            help: '工具调用没有显式指定尺寸时使用。',
            onChange: value => { setRouting(previous => previous === null ? previous : {
              ...previous, generationDefaults: { ...previous.generationDefaults, size: value as ImageGenerationSize },
            }) },
          }),
          createElement(OptionPicker, {
            label: '质量', value: routing.generationDefaults.quality, disabled,
            options: [
              { value: 'auto', label: '自动' }, { value: 'low', label: '低' },
              { value: 'medium', label: '中' }, { value: 'high', label: '高' },
            ],
            help: '质量越高，通常耗时和费用越高。',
            onChange: value => { setRouting(previous => previous === null ? previous : {
              ...previous, generationDefaults: { ...previous.generationDefaults, quality: value as ImageGenerationQuality },
            }) },
          }),
          createElement(OptionPicker, {
            label: '格式', value: routing.generationDefaults.outputFormat, disabled,
            options: [
              { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' },
            ],
            help: '生成图在 DSH attachment 中的持久化格式。',
            onChange: value => { setRouting(previous => previous === null ? previous : {
              ...previous, generationDefaults: { ...previous.generationDefaults, outputFormat: value as ImageOutputFormat },
            }) },
          })))),
    catalog.failures.length === 0 ? null : createElement('p', { className: css.catalogWarning },
      `有 ${catalog.failures.length} 个模型提供方无法读取目录；请在“设置 → 模型”检查配置。`),
    createElement('div', { className: css.actions },
      createElement(Button, { variant: 'primary', disabled, onClick: () => { void save() } },
        saving ? '正在保存…' : '保存路由')))
}

type SessionCall = VisionCallView & { sessionId: string }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function callDetail(call: SessionCall): ReactNode {
  const result = call.status === 'success' ? call.result : call.error
  const title = call.status === 'success' ? call.title : '识图失败'
  const url = imageUrl(call.sessionId, call.id)
  const locator = attachmentLocator(call.attachment.attachmentId)
  const attachmentName = call.attachment.name ?? '未命名图片'
  return createElement('details', { key: call.id, className: css.callCard },
    createElement('summary', { className: css.callSummary },
      createElement('span', { className: css.summaryTitle }, title),
      createElement('time', { className: css.summaryTime, dateTime: call.createdAt },
        new Date(call.createdAt).toLocaleTimeString()),
      createElement('span', { className: css.summaryModel }, `${call.backendId}/${call.model} · ${call.durationMs}ms`),
      createElement('span', { className: css.summaryPreview }, result)),
    createElement('div', { className: css.callBody },
      createElement('div', { className: css.detailLabel }, '图片定位'),
      createElement('div', { className: css.attachmentInfo },
        createElement('div', { className: css.attachmentName }, attachmentName),
        createElement('code', { className: css.attachmentLocator, title: locator }, locator),
        createElement('div', { className: css.attachmentMeta },
          `${call.attachment.mediaType} · ${call.attachment.width}×${call.attachment.height} · ${formatBytes(call.attachment.bytes)}`),
        createElement('a', { className: css.previewAddress, href: url, target: '_blank', rel: 'noreferrer' },
          `当前会话预览：${url}`)),
      createElement('div', { className: css.detailLabel }, '输入提示词'),
      createElement('pre', { className: css.prompt }, call.prompt),
      createElement('a', { className: css.imageLink, href: url, target: '_blank', rel: 'noreferrer' },
        createElement('img', {
          className: css.image, src: url, alt: call.status === 'success' ? call.title : attachmentName, loading: 'lazy',
        })),
      createElement('div', { className: css.detailLabel }, call.status === 'success' ? '解析结果' : '请求错误'),
      createElement('div', { className: call.status === 'success' ? css.result : css.resultError }, result)))
}

function VisionCallsView(props: { sessionId: string }): ReactNode {
  const { sessionId } = props
  const [calls, setCalls] = useState<SessionCall[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setCalls([])
    setError(null)
    if (sessionId.length === 0) { setError('当前没有活动会话。'); return }
    const controller = new AbortController()
    let loading = false
    const load = async (): Promise<void> => {
      if (loading || controller.signal.aborted) return
      loading = true
      try {
        const response = await fetch(callsUrl(sessionId), { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setCalls(parseCallsPayload(await response.json()).map(call => ({ ...call, sessionId })))
        setError(null)
      } catch (reason: unknown) {
        if (!controller.signal.aborted) setError(String(reason))
      } finally {
        loading = false
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 1_500)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [sessionId])
  const groups = groupCalls(calls)
  return createElement('div', { className: css.historyRoot },
    createElement('div', { className: css.historyHeading }, visionMixIcon(16), '识图记录'),
    createElement('p', { className: css.historyIntro }, '仅显示当前会话，按调用时间排列'),
    error === null ? null : createElement('p', { className: css.historyError }, error),
    groups.length === 0 && error === null ? createElement('p', { className: css.empty },
      '当前会话还没有识图调用。用户图片和 Agent 工具截图都会显示在这里。') : null,
    groups.map(group => createElement('section', { key: group.date },
      createElement('div', { className: css.dateHeading }, group.date),
      group.calls.map(call => callDetail({ ...call, sessionId })))))
}

type SessionGeneration = GenerationView & { sessionId: string }

function generationDetail(item: SessionGeneration): ReactNode {
  const title = item.operation === 'generate' ? '生成图片' : '编辑图片'
  const preview = item.status === 'success' ? item.prompt : item.error
  const url = item.status === 'success' ? generatedImageUrl(item.sessionId, item.id) : undefined
  return createElement('details', { key: item.id, className: css.callCard },
    createElement('summary', { className: css.callSummary },
      createElement('span', { className: css.summaryTitle }, item.status === 'success' ? title : `${title}失败`),
      createElement('time', { className: css.summaryTime, dateTime: item.createdAt }, new Date(item.createdAt).toLocaleTimeString()),
      createElement('span', { className: css.summaryModel }, `${item.backendId}/${item.model} · ${item.durationMs}ms`),
      createElement('span', { className: css.summaryPreview }, preview)),
    createElement('div', { className: css.callBody },
      createElement('div', { className: css.detailLabel }, '输入提示词'),
      createElement('pre', { className: css.prompt }, item.prompt),
      createElement('div', { className: css.attachmentMeta },
        `${item.size} · ${item.quality} · ${item.outputFormat.toUpperCase()}`),
      item.sourceAttachments.length === 0 ? null : createElement('div', null,
        createElement('div', { className: css.detailLabel }, '源图片'),
        item.sourceAttachments.map(source => createElement('div', { key: source.attachmentId, className: css.attachmentInfo },
          createElement('div', { className: css.attachmentName }, source.name ?? '会话图片'),
          createElement('code', { className: css.attachmentLocator }, attachmentLocator(source.attachmentId)),
          createElement('div', { className: css.attachmentMeta },
            `${source.mediaType} · ${source.width}×${source.height} · ${formatBytes(source.bytes)}`)))),
      item.status === 'error' ? createElement('div', null,
        createElement('div', { className: css.detailLabel }, '请求错误'),
        createElement('div', { className: css.resultError }, item.error)) : createElement('div', null,
        createElement('div', { className: css.detailLabel }, '生成结果'),
        createElement('div', { className: css.attachmentInfo },
          createElement('div', { className: css.attachmentName }, item.outputAttachment.name ?? '生成图片'),
          createElement('code', { className: css.attachmentLocator }, attachmentLocator(item.outputAttachment.attachmentId)),
          createElement('div', { className: css.attachmentMeta },
            `${item.outputAttachment.mediaType} · ${item.outputAttachment.width}×${item.outputAttachment.height} · ${formatBytes(item.outputAttachment.bytes)}`)),
        createElement('a', { className: css.imageLink, href: url, target: '_blank', rel: 'noreferrer' },
          createElement('img', { className: css.image, src: url, alt: item.prompt, loading: 'lazy' })))))
}

function GenerationCallsView(props: { sessionId: string }): ReactNode {
  const { sessionId } = props
  const [items, setItems] = useState<SessionGeneration[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setItems([])
    setError(null)
    if (sessionId.length === 0) { setError('当前没有活动会话。'); return }
    const controller = new AbortController()
    let loading = false
    const load = async (): Promise<void> => {
      if (loading || controller.signal.aborted) return
      loading = true
      try {
        const response = await fetch(generationsUrl(sessionId), { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setItems(parseGenerationsPayload(await response.json()).map(item => ({ ...item, sessionId })))
        setError(null)
      } catch (reason: unknown) {
        if (!controller.signal.aborted) setError(String(reason))
      } finally {
        loading = false
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 1_500)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [sessionId])
  const groups = new Map<string, SessionGeneration[]>()
  for (const item of [...items].sort((left, right) => right.createdAt - left.createdAt)) {
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.createdAt))
    const group = groups.get(date)
    if (group === undefined) groups.set(date, [item])
    else group.push(item)
  }
  return createElement('div', { className: css.historyRoot },
    createElement('div', { className: css.historyHeading }, visionMixIcon(16), '生图记录'),
    createElement('p', { className: css.historyIntro }, '仅显示当前会话，生图与编辑记录独立于识图记录'),
    error === null ? null : createElement('p', { className: css.historyError }, error),
    items.length === 0 && error === null ? createElement('p', { className: css.empty },
      '当前会话还没有图片生成或编辑调用。') : null,
    [...groups].map(([date, group]) => createElement('section', { key: date },
      createElement('div', { className: css.dateHeading }, date), group.map(generationDetail))))
}
