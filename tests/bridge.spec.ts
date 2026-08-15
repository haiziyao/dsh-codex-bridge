import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId as LlmCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { VisionBackend } from '../src/backend.ts'
import { MixedAdapter, renderVisionPrompt, transformMessages } from '../src/bridge.ts'
import { resolveConfig } from '../src/config.ts'
import { CallId, type VisionCallRecord } from '../src/history.ts'

const IMAGE: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
}

function setup(backend: VisionBackend) {
  const records: VisionCallRecord[] = []
  let time = 100
  return {
    records,
    dependencies: {
      backend,
      attachments: { readImage: vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: new Uint8Array([1]) })) },
      history: { append: async (record: VisionCallRecord) => { records.push(record) } },
      now: () => { const value = time; time += 10; return value },
      createCallId: () => CallId('call-1'),
    },
  }
}

describe('transformMessages', () => {
  it('prepares identification and interface inspection before requesting JSON', () => {
    const prompt = renderVisionPrompt('这是谁？')
    expect(prompt).toContain('actively identify a known person/character')
    expect(prompt).toContain('transcribe important visible text')
    expect(prompt).toContain('Inspect the actual pixels')
    expect(prompt).toContain('Request: 这是谁？')
  })

  it('bypasses text-only turns with no image or intent request', async () => {
    const analyze = vi.fn<VisionBackend['analyze']>()
    const context = setup({ id: 'vision', model: 'see', analyze })
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    await expect(transformMessages({ sessionId: SessionId('s'), messages: [message] }, context.dependencies)).resolves.toEqual([message])
    expect(analyze).not.toHaveBeenCalled()
    expect(context.records).toEqual([])
  })

  it('preserves the visible image and appends a recorded analysis context', async () => {
    const analyze = vi.fn<VisionBackend['analyze']>(async () => ({ title: 'page', result: 'green button', raw: '{}' }))
    const context = setup({ id: 'vision', model: 'see', analyze })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'button color?' }, { type: 'image', attachment: IMAGE }], source: { kind: 'user' },
    })
    const result = await transformMessages({ sessionId: SessionId('s'), messages: [message] }, context.dependencies)
    expect(result[0]).toBe(message)
    expect(result[1]).toMatchObject({ source: { kind: 'plugin', plugin: 'bridge-gpt' }, content: [{ type: 'text', text: expect.stringContaining('green button') }] })
    expect(analyze).toHaveBeenCalledWith({ attachment: IMAGE, prompt: renderVisionPrompt('button color?') })
    expect(context.records).toEqual([expect.objectContaining({ origin: 'message', attachment: IMAGE, result: 'green button' })])
  })
})

describe('MixedAdapter', () => {
  it('uses the fixed Mix name and recursively removes tool-result images', async () => {
    const delegated = vi.fn(async function* () {})
    const config = resolveConfig({ baseModel: { provider: 'base', model: 'chat' } })
    const adapter = new MixedAdapter({ llm: { stream: delegated } } as unknown as Context, () => config)
    const message = createUserMessage({
      content: [{
        type: 'tool-result', toolCallId: LlmCallId('call'), content: [{ type: 'image', attachment: IMAGE }],
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(adapter.providerInfo('bridge-gpt').name).toBe('Mix')
    expect((await adapter.listModels('bridge-gpt'))[0]?.name).toBe('Mix')
    for await (const _chunk of adapter.stream({ provider: 'bridge-gpt', model: 'mix', messages: [message] })) {}
    expect(delegated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'base', model: 'chat',
      messages: [expect.objectContaining({ content: [expect.objectContaining({
        type: 'tool-result', content: [{ type: 'text', text: expect.stringContaining('Bridge GPT') }],
      })] })],
    }))
  })
})
