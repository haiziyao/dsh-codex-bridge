// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

type SidebarComponent = ComponentType<{ scope: { sessionId: string } }>
type SettingsComponent = ComponentType

function registeredViews(): { sidebar: SidebarComponent; settings: SettingsComponent } {
  let sidebar: SidebarComponent | undefined
  let settings: SettingsComponent | undefined
  const ctx = {
    betterSidebar: {
      registerTab(tab: { component: SidebarComponent }) { sidebar = tab.component; return () => undefined },
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
  if (sidebar === undefined || settings === undefined) throw new Error('Bridge GPT views were not registered')
  return { sidebar, settings }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Bridge GPT browser views', () => {
  it('uses the themed menu primitive instead of a native select', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/bridge-gpt/settings')) {
        return json({
          available: true, writable: true, revision: 0,
          routing: {
            baseModel: { provider: 'deepseek', model: 'chat' },
            imageModel: { provider: 'vision', model: 'see' },
            autoAnalyzeToolImages: true,
          },
        })
      }
      return json({
        groups: [
          { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat', inputModalities: ['text'] }] },
          { id: 'vision', name: 'Vision', models: [{ id: 'see', name: 'See', inputModalities: ['text', 'image'] }] },
        ],
        failures: [],
      })
    })
    const { settings: Settings } = registeredViews()
    const view = render(createElement(Settings))
    const picker = await screen.findByRole('button', { name: 'Chat (deepseek/chat)' })
    expect(view.container.querySelector('select')).toBeNull()
    fireEvent.click(picker)
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
  })

  it('renders compact call summaries that reveal the image and details on click', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      calls: [{
        id: 'call-1', createdAt: 1_700_000_000_000, durationMs: 321,
        origin: 'message', backendId: 'vision', model: 'see',
        prompt: 'full preprocessing prompt', status: 'success', title: '角色识别', result: '最可能是测试角色。',
      }],
    }))
    const { sidebar: Sidebar } = registeredViews()
    const view = render(createElement(Sidebar, { scope: { sessionId: 'session-1' } }))
    const summary = await screen.findByText('角色识别')
    const details = summary.closest('details')
    expect(details?.open).toBe(false)
    fireEvent.click(summary.closest('summary')!)
    expect(details?.open).toBe(true)
    expect(screen.getByRole('img', { name: '角色识别' })).toBeTruthy()
    expect(screen.getByText('full preprocessing prompt')).toBeTruthy()
    await waitFor(() => expect(view.container.firstElementChild?.className).toContain('historyRoot'))
  })
})
