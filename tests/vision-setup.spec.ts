import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { VisionSetupService } from '../src/vision-setup.ts'

interface Harness {
  ctx: Context
  provider: { models: Array<Record<string, unknown>> }
  bridge: { imageModel: { provider: string; model: string } }
  stream: ReturnType<typeof vi.fn>
  mutate: ReturnType<typeof vi.fn>
}

function setAt(root: Record<string, unknown>, path: readonly string[], value: unknown, unset: boolean): void {
  let target = root
  for (const segment of path.slice(0, -1)) {
    const child = target[segment]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) target[segment] = {}
    target = target[segment] as Record<string, unknown>
  }
  const key = path.at(-1)
  if (key === undefined) throw new Error('root writes are not used in this test')
  if (unset) delete target[key]
  else target[key] = structuredClone(value)
}

function harness(response = 'red'): Harness {
  const provider = { models: [{ id: 'vision', contextWindow: 200_000 }] as Array<Record<string, unknown>> }
  const bridge = { imageModel: { provider: 'old', model: 'old-vision' } }
  const revisions = new Map([['llm-pi-ai', 0], ['vision-mix', 0]])
  const stream = vi.fn(async function* () {
    const input = provider.models[0]?.input
    if (!Array.isArray(input) || !input.includes('image')) throw new Error('adapter still sees text-only model')
    yield { type: 'text-delta' as const, index: 0, text: response }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  })
  const mutate = vi.fn(async (ns: string, ops: readonly SettingsPathOp[], expected?: number) => {
    expect(expected).toBe(revisions.get(ns))
    const root = ns === 'llm-pi-ai'
      ? { providers: { relay: provider } } as Record<string, unknown>
      : bridge as unknown as Record<string, unknown>
    for (const op of ops) setAt(root, op.path, op.op === 'set' ? op.value : undefined, op.op === 'unset')
    revisions.set(ns, (revisions.get(ns) ?? 0) + 1)
  })
  const ctx = {
    llm: {
      listConfigurableProviders: () => [{
        provider: 'relay', displayName: 'Relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'],
      }],
      resolveModelInfo: async () => ({
        id: 'vision', name: 'vision', contextWindow: 200_000, maxTokens: 32_000,
        inputModalities: provider.models[0]?.input ?? ['text'],
      }),
      stream,
    },
    settings: {
      describe: () => [{
        ns: settingsNamespace('llm-pi-ai'), revision: revisions.get('llm-pi-ai')!,
        value: { providers: { relay: provider } },
      }, {
        ns: settingsNamespace('vision-mix'), revision: revisions.get('vision-mix')!, value: bridge,
      }],
      mutate,
    },
    attachments: {
      saveImage: async () => ({
        attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 80, width: 3, height: 3,
      }),
    },
  } as unknown as Context
  return { ctx, provider, bridge, stream, mutate }
}

const ROUTE = { provider: 'relay', model: 'vision' }

describe('VisionSetupService', () => {
  it('tests through a temporary image declaration and restores the profile', async () => {
    const subject = harness()
    await expect(new VisionSetupService(subject.ctx).test(ROUTE)).resolves.toMatchObject({
      action: 'test', imageEnabled: false, selected: false, response: 'red',
    })
    expect(subject.provider.models).toEqual([{ id: 'vision', contextWindow: 200_000 }])
    expect(subject.bridge.imageModel).toEqual({ provider: 'old', model: 'old-vision' })
    expect(subject.mutate).toHaveBeenCalledTimes(2)
  })

  it('force-enables without an API request and selects the route', async () => {
    const subject = harness()
    await expect(new VisionSetupService(subject.ctx).enable(ROUTE)).resolves.toMatchObject({
      action: 'enable', imageEnabled: true, selected: true,
    })
    expect(subject.provider.models[0]).toEqual({ id: 'vision', contextWindow: 200_000, input: ['text', 'image'] })
    expect(subject.bridge.imageModel).toEqual(ROUTE)
    expect(subject.stream).not.toHaveBeenCalled()
  })

  it('keeps the declaration only after automatic setup passes a real image probe', async () => {
    const subject = harness('The tile is RED.')
    await expect(new VisionSetupService(subject.ctx).auto(ROUTE)).resolves.toMatchObject({
      action: 'auto', imageEnabled: true, selected: true,
    })
    expect(subject.provider.models[0]?.input).toEqual(['text', 'image'])
    expect(subject.bridge.imageModel).toEqual(ROUTE)
    expect(subject.stream).toHaveBeenCalledOnce()
  })

  it('rolls back a failed automatic visual check without changing the selected model', async () => {
    const subject = harness('blue')
    await expect(new VisionSetupService(subject.ctx).auto(ROUTE)).rejects.toThrow(/did not identify the red test tile/)
    expect(subject.provider.models).toEqual([{ id: 'vision', contextWindow: 200_000 }])
    expect(subject.bridge.imageModel).toEqual({ provider: 'old', model: 'old-vision' })
  })
})
