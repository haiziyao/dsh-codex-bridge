/** Browser plugin for Bridge GPT routing settings and session-scoped vision history. */
import type { Context } from '@deepseek-ai/cordis'
import { Button, IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type { ModelRoute, ResolvedConfig } from '../config.ts'
import { attachmentLocator, callsUrl, groupCalls, imageUrl, parseCallsPayload, type VisionCallView } from './model.ts'
import {
  parseModelCatalog, parseRouteValue, parseSettingsPayload, routeValue,
  type BridgeSettingsPayload, type ModelCatalogPayload, type SelectableModelGroupView,
} from './settings-model.ts'
import css from './BridgeGpt.module.css'

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

function bridgeIcon(size = 16): ReactNode {
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

/** Register the bridge-icon sidebar history tab and routing settings section. */
export function apply(ctx: Context): void {
  ctx.inject(['betterSidebar'], (sidebarCtx: Context) => {
    sidebarCtx.effect(() => sidebarCtx.betterSidebar.registerTab({
      id: 'bridge-gpt:vision-calls', title: () => '识图记录', icon: bridgeIcon,
      order: 55, single: true,
      component: props => createElement(VisionCallsView, { sessionId: props.scope.sessionId }),
    }))
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'bridge-gpt', order: 16, label: () => 'Bridge GPT',
    icon: bridgeIcon, inject: () => ({}),
  }, BridgeSettingsView))
}

function routeExists(groups: SelectableModelGroupView[], route: ModelRoute, imageOnly: boolean): boolean {
  return groups.some(group => group.id === route.provider && group.models.some(model =>
    model.id === route.model && (!imageOnly || model.inputModalities?.includes('image') === true)))
}

function modelLabel(groups: SelectableModelGroupView[], route: ModelRoute | undefined): string {
  if (route === undefined) return '不使用（固定规则）'
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
  if (props.optional === true) items.push({ id: '', label: '不使用（固定规则）' })
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
  createElement('span', { className: css.pickerText }, modelLabel(groups, route)),
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

function BridgeSettingsView(): ReactNode {
  const [snapshot, setSnapshot] = useState<BridgeSettingsPayload | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalogPayload | null>(null)
  const [routing, setRouting] = useState<ResolvedConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (signal?: AbortSignal): Promise<void> => {
    const request = signal === undefined ? {} : { signal }
    const [settingsResponse, modelsResponse] = await Promise.all([
      fetch('/bridge-gpt/settings', request), fetch('/bridge-gpt/models', request),
    ])
    if (!settingsResponse.ok || !modelsResponse.ok) {
      throw new Error(`Bridge GPT HTTP ${settingsResponse.status}/${modelsResponse.status}`)
    }
    const parsedSettings = parseSettingsPayload(await settingsResponse.json())
    setSnapshot(parsedSettings)
    setRouting(parsedSettings.routing)
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
      const response = await fetch('/bridge-gpt/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, routing }),
      })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(String((body as { error?: unknown }).error ?? `HTTP ${response.status}`))
      const parsed = parseSettingsPayload(body)
      setSnapshot(parsed)
      setRouting(parsed.routing)
      setNotice('路由已保存，下一次模型或识图调用立即生效。')
    } catch (reason: unknown) {
      setError(String(reason))
      await load().catch(() => undefined)
    } finally {
      setSaving(false)
    }
  }

  if (snapshot === null || catalog === null || routing === null) {
    return createElement('div', { className: css.settingsSection }, error ?? '正在加载 Bridge GPT 设置…')
  }
  const disabled = saving || !snapshot.available || !snapshot.writable
  return createElement('div', { className: css.settingsSection },
    createElement('div', { className: css.sectionHeading }, bridgeIcon(20),
      createElement('h2', { className: css.sectionTitle }, 'Bridge GPT')),
    createElement('p', { className: css.intro },
      'Mix 是固定的虚拟模型。这里只选择“设置 → 模型”中已经配置好的模型，不重复保存 API 地址或密钥。'),
    error === null ? null : createElement('p', { role: 'alert', className: css.error }, error),
    notice === null ? null : createElement('p', { className: css.notice }, notice),
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
        help: '处理用户上传图片、工具截图和本地图片识别。',
        onChange: value => {
          if (value !== undefined) setRouting(previous => previous === null ? previous : { ...previous, imageModel: value })
        },
      }),
      createElement('details', { className: css.advanced },
        createElement('summary', { className: css.advancedSummary }, '高级设置'),
        createElement('div', { className: css.advancedBody },
          createElement(ModelPicker, {
            label: '意图识别模型', route: routing.intentModel, groups: catalog.groups, disabled, optional: true,
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
    createElement('div', { className: css.historyHeading }, bridgeIcon(16), '识图记录'),
    createElement('p', { className: css.historyIntro }, '仅显示当前会话，按调用时间排列'),
    error === null ? null : createElement('p', { className: css.historyError }, error),
    groups.length === 0 && error === null ? createElement('p', { className: css.empty },
      '当前会话还没有识图调用。用户图片和 Agent 工具截图都会显示在这里。') : null,
    groups.map(group => createElement('section', { key: group.date },
      createElement('div', { className: css.dateHeading }, group.date),
      group.calls.map(call => callDetail({ ...call, sessionId })))))
}
