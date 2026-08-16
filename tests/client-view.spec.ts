// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

type SidebarComponent = ComponentType<{ scope: { sessionId: string } }>
type SettingsComponent = ComponentType

function registeredViews(): { visionSidebar: SidebarComponent; generationSidebar: SidebarComponent; settings: SettingsComponent } {
  const sidebars = new Map<string, SidebarComponent>()
  let settings: SettingsComponent | undefined
  const ctx = {
    betterSidebar: {
      registerTab(tab: { id: string; component: SidebarComponent }) { sidebars.set(tab.id, tab.component); return () => undefined },
    },
    slots: {
      inject(_name: string, register: () => unknown) { register() },
      register(_options: Record<string, unknown>, component: SettingsComponent) {
        settings = component
        return () => undefined
      },
    },
    effect(register: () => unknown) { register(); return () => undefined },
    inject(_dependencies: string[], register: (context: Context) => unknown) {
      register(this as unknown as Context)
      return { dispose: () => undefined }
    },
  } as unknown as Context
  apply(ctx)
  const visionSidebar = sidebars.get('vision-mix:vision-calls')
  const generationSidebar = sidebars.get('vision-mix:generation-calls')
  if (visionSidebar === undefined || generationSidebar === undefined || settings === undefined) throw new Error('Vision Mix views were not registered')
  return { visionSidebar, generationSidebar, settings }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Vision Mix browser views', () => {
  it('uses the themed menu primitive instead of a native select', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/vision-mix/settings')) {
        return json({
          available: true, writable: true, revision: 0,
          routing: {
            baseModel: { provider: 'deepseek', model: 'chat' },
            imageModel: { provider: 'vision', model: 'see' },
            autoAnalyzeToolImages: true,
            generationDefaults: { size: 'auto', quality: 'auto', outputFormat: 'png' },
          },
        })
      }
      return json({
        groups: [
          { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat', inputModalities: ['text'] }] },
          { id: 'vision', name: 'Vision', models: [{ id: 'see', name: 'See', inputModalities: ['text', 'image'] }] },
        ],
        generationProviders: [{ id: 'openai', name: 'OpenAI' }],
        failures: [],
      })
    })
    const { settings: Settings } = registeredViews()
    const view = render(createElement(Settings))
    const picker = await screen.findByRole('button', { name: '基础模型：Chat (deepseek/chat)' })
    const basics = screen.getByText('基础设置')
    const capabilities = screen.getByText('模型图片能力')
    expect(basics.compareDocumentPosition(capabilities) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(view.container.querySelector('select')).toBeNull()
    fireEvent.click(picker)
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(document.querySelectorAll('[data-modality="text"]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-modality="image"]').length).toBeGreaterThan(0)
  })

  it('renders compact call summaries that reveal the image and details on click', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      calls: [{
        id: 'call-1', createdAt: 1_700_000_000_000, durationMs: 321,
        origin: 'message', backendId: 'vision', model: 'see',
        attachment: {
          attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 2048,
          width: 1280, height: 720, name: 'minecraft.png',
        },
        prompt: 'full preprocessing prompt', status: 'success', title: '角色识别', result: '最可能是测试角色。',
      }],
    }))
    const { visionSidebar: Sidebar } = registeredViews()
    const view = render(createElement(Sidebar, { scope: { sessionId: 'session-1' } }))
    const summary = await screen.findByText('角色识别')
    const details = summary.closest('details')
    expect(details?.open).toBe(false)
    fireEvent.click(summary.closest('summary')!)
    expect(details?.open).toBe(true)
    expect(screen.getByRole('img', { name: '角色识别' })).toBeTruthy()
    expect(screen.getByText('full preprocessing prompt')).toBeTruthy()
    expect(screen.getByText('minecraft.png')).toBeTruthy()
    expect(screen.getByText(`dsh-attachment://sha256%3A${'a'.repeat(64)}`)).toBeTruthy()
    expect(screen.getByText('image/png · 1280×720 · 2.0 KiB')).toBeTruthy()
    await waitFor(() => expect(view.container.firstElementChild?.className).toContain('historyRoot'))
  })

  it('runs automatic vision onboarding and tests a separate image generation Provider', async () => {
    const requests: Array<{ url: string; body?: unknown }> = []
    let imageEnabled = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/vision-mix/vision-setup')) {
        requests.push({ url, body: JSON.parse(String(init?.body)) })
        imageEnabled = true
        return json({
          action: 'auto', route: { provider: 'relay', model: 'vision' }, imageEnabled: true,
          selected: false, message: '真实图片测试通过，已保存 image 能力。', response: 'red',
        })
      }
      if (url.endsWith('/vision-mix/generation-setup')) {
        requests.push({ url, body: JSON.parse(String(init?.body)) })
        return json({
          route: { provider: 'images', model: 'gpt-image-2' }, message: '生图 API 测试通过',
          mediaType: 'image/png', bytes: 3,
          previewDataUrl: 'data:image/png;base64,AQID',
        })
      }
      if (url.endsWith('/vision-mix/settings')) return json({
        available: true, writable: true, revision: 1,
        routing: {
          baseModel: { provider: 'relay', model: 'chat' }, imageModel: { provider: 'relay', model: 'vision' },
          autoAnalyzeToolImages: true, generationModel: { provider: 'images', model: 'gpt-image-2' },
          generationDefaults: { size: 'auto', quality: 'auto', outputFormat: 'png' },
        },
      })
      return json({
        groups: [{ id: 'relay', name: 'Relay', models: [
          { id: 'chat', name: 'Chat', inputModalities: ['text'] },
          { id: 'vision', name: 'Vision', inputModalities: imageEnabled ? ['text', 'image'] : ['text'] },
        ] }],
        generationProviders: [{ id: 'images', name: 'Images Relay' }], failures: [],
      })
    })
    const { settings: Settings } = registeredViews()
    render(createElement(Settings))
    fireEvent.click(await screen.findByRole('button', { name: '基础模型：Chat (relay/chat)' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Vision/ }))
    expect(screen.getByRole('button', { name: '基础模型：Vision (relay/vision)' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '测试并启用 image' }))
    expect(await screen.findByText('图片测试通过 · 已启用 image')).toBeTruthy()
    expect(screen.getByText('真实图片测试通过，已保存 image 能力。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '已声明 image' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: '基础模型：Vision (relay/vision)' })).toBeTruthy()
    expect(requests[0]?.body).toEqual({ action: 'auto', route: { provider: 'relay', model: 'vision' } })

    fireEvent.click(screen.getByRole('button', { name: '测试生图 API' }))
    expect(await screen.findByRole('img', { name: '生图 API 测试结果' })).toBeTruthy()
    expect(requests[1]?.body).toEqual({ route: { provider: 'images', model: 'gpt-image-2' } })
  })

  it('renders generation history separately with source and output attachments', async () => {
    const sourceId = `sha256:${'b'.repeat(64)}`
    const outputId = `sha256:${'c'.repeat(64)}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      generations: [{
        id: 'generation-1', createdAt: 1_700_000_000_000, durationMs: 9000,
        operation: 'edit', backendId: 'openai-images', model: 'gpt-image-2',
        prompt: '改成夜景', size: '1536x1024', quality: 'high', outputFormat: 'png', status: 'success',
        sourceAttachments: [{ attachmentId: sourceId, mediaType: 'image/png', bytes: 1024, width: 1024, height: 1024 }],
        outputAttachment: { attachmentId: outputId, mediaType: 'image/png', bytes: 2048, width: 1536, height: 1024, name: 'night.png' },
      }],
    }))
    const { generationSidebar: Sidebar } = registeredViews()
    render(createElement(Sidebar, { scope: { sessionId: 'session-1' } }))
    const summary = await screen.findByText('编辑图片')
    fireEvent.click(summary.closest('summary')!)
    expect(screen.getAllByText('改成夜景')).toHaveLength(2)
    expect(screen.getByText('night.png')).toBeTruthy()
    expect(screen.getByText(`dsh-attachment://sha256%3A${'b'.repeat(64)}`)).toBeTruthy()
    expect(screen.getByRole('img', { name: '改成夜景' })).toBeTruthy()
  })
})
