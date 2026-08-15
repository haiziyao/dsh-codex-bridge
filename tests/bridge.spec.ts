import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId as LlmCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { VisionBackend } from '../src/backend.ts'
import {
  analyzeMessageImages,
  attachmentLocator,
  explicitlyReferencesImage,
  MixedAdapter,
  parseImageReferenceDecision,
  renderAttachmentReference,
  renderVisionPrompt,
} from '../src/bridge.ts'
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

describe('analyzeMessageImages', () => {
  it('prepares identification and interface inspection before requesting JSON', () => {
    const prompt = renderVisionPrompt('这是谁？')
    expect(prompt).toContain('actively identify a known person/character')
    expect(prompt).toContain('transcribe important visible text')
    expect(prompt).toContain('Inspect the actual pixels')
    expect(prompt).toContain('Request: 这是谁？')
  })

  it('recognizes explicit cross-turn image references and validates intent JSON', () => {
    expect(explicitlyReferencesImage('再详细介绍一下这张图片')).toBe(true)
    expect(explicitlyReferencesImage('What else is visible in the previous screenshot?')).toBe(true)
    expect(explicitlyReferencesImage('介绍一下 TypeScript')).toBe(false)
    expect(parseImageReferenceDecision('{"referencesImage":true}')).toBe(true)
    expect(() => parseImageReferenceDecision('{"answer":true}')).toThrow(/invalid image-reference decision/)
  })

  it('renders an actionable attachment locator without inventing a filesystem path', () => {
    expect(attachmentLocator(IMAGE)).toBe(`dsh-attachment://sha256%3A${'b'.repeat(64)}`)
    const reference = renderAttachmentReference({ ...IMAGE, name: 'minecraft.png' })
    expect(reference).toContain(`attachment_id: sha256:${'b'.repeat(64)}`)
    expect(reference).toContain('original_name: minecraft.png')
    expect(reference).toContain('not a workspace filesystem path')
    expect(reference).toContain('Do not search the workspace')
  })

  it('bypasses text-only turns with no image or intent request', async () => {
    const analyze = vi.fn<VisionBackend['analyze']>()
    const context = setup({ id: 'vision', model: 'see', analyze })
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    await expect(analyzeMessageImages({ sessionId: SessionId('s'), messages: [message] }, context.dependencies)).resolves.toEqual([])
    expect(analyze).not.toHaveBeenCalled()
    expect(context.records).toEqual([])
  })

  it('returns one recorded analysis context for a new image', async () => {
    const analyze = vi.fn<VisionBackend['analyze']>(async () => ({ title: 'page', result: 'green button', raw: '{}' }))
    const context = setup({ id: 'vision', model: 'see', analyze })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'button color?' }, { type: 'image', attachment: IMAGE }], source: { kind: 'user' },
    })
    const result = await analyzeMessageImages({ sessionId: SessionId('s'), messages: [message] }, context.dependencies)
    expect(result[0]).toMatchObject({ source: { kind: 'plugin', plugin: 'bridge-gpt' }, content: [{ type: 'text', text: expect.stringContaining('green button') }] })
    expect(result[0]?.content[0]).toMatchObject({
      type: 'text', text: expect.stringContaining(`attachment_id: sha256:${'b'.repeat(64)}`),
    })
    expect(result[0]?.content[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('Do not search the filesystem'),
    })
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
        type: 'tool-result', content: [{
          type: 'text', text: expect.stringContaining(`attachment_id: sha256:${'b'.repeat(64)}`),
        }],
      })] })],
    }))
  })

  it('can finish a preprocessing-only step without calling the base model', async () => {
    const delegated = vi.fn(async function* () {})
    const defer = vi.fn(async () => true)
    const config = resolveConfig({ baseModel: { provider: 'base', model: 'chat' } })
    const adapter = new MixedAdapter({ llm: { stream: delegated } } as unknown as Context, () => config, defer)
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'bridge-gpt', model: 'mix', messages: [] })) chunks.push(chunk)
    expect(defer).toHaveBeenCalledOnce()
    expect(delegated).not.toHaveBeenCalled()
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})
