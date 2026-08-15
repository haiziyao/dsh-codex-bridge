import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

describe('bridge-gpt client plugin', () => {
  it('registers one session-scoped vision-call tab when better-sidebar is available', () => {
    const tabs: Array<Record<string, unknown>> = []
    const settingsSections: Array<Record<string, unknown>> = []
    const ctx = {
      betterSidebar: {
        registerTab(tab: Record<string, unknown>) {
          tabs.push(tab)
          return () => undefined
        },
      },
      slots: {
        inject(name: string, register: () => unknown) {
          expect(name).toBe('settings.section')
          register()
        },
        register(options: Record<string, unknown>) {
          settingsSections.push(options)
          return () => undefined
        },
      },
      effect(register: () => unknown) {
        register()
        return () => undefined
      },
      inject(dependencies: string[], register: (context: Context) => unknown) {
        expect(dependencies).toEqual(['betterSidebar'])
        register(this as unknown as Context)
        return { dispose: () => undefined }
      },
    } as unknown as Context

    apply(ctx)

    expect(tabs).toEqual([expect.objectContaining({
      id: 'bridge-gpt:vision-calls',
      order: 55,
      single: true,
      icon: expect.any(Function),
      component: expect.any(Function),
    })])
    expect((tabs[0]?.title as () => string)()).toBe('识图记录')
    expect(settingsSections).toEqual([expect.objectContaining({
      id: 'bridge-gpt',
      order: 16,
      label: expect.any(Function),
      icon: expect.any(Function),
    })])
    expect((settingsSections[0]?.label as () => string)()).toBe('Bridge GPT')
  })

  it('keeps the settings section when better-sidebar is absent', () => {
    const settingsSections: Array<Record<string, unknown>> = []
    const ctx = {
      slots: {
        inject(_name: string, register: () => unknown) { register() },
        register(options: Record<string, unknown>) {
          settingsSections.push(options)
          return () => undefined
        },
      },
      inject(_dependencies: string[], _register: (context: Context) => unknown) {
        return { dispose: () => undefined }
      },
    } as unknown as Context

    apply(ctx)

    expect(settingsSections).toEqual([expect.objectContaining({ id: 'bridge-gpt' })])
  })
})
