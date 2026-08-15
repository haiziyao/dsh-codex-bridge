import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import { LlmVisionBackend, parseAnalysis } from '../src/llm-backend.ts'

const IMAGE = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const,
  bytes: 3, width: 1, height: 1,
}

describe('LlmVisionBackend', () => {
  it('uses the harness model registry rather than a plugin-owned HTTP credential', async () => {
    const stream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, index: 0, text: '{"title":"page","result":"login error"}' }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const backend = new LlmVisionBackend({ llm: { stream } } as unknown as Context, { provider: 'vision', model: 'see' })

    await expect(backend.analyze({ attachment: IMAGE, prompt: 'inspect' })).resolves.toEqual({
      title: 'page', result: 'login error', raw: '{"title":"page","result":"login error"}',
    })
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'vision', model: 'see' }))
    expect(stream.mock.calls[0]?.[0].messages[0].content).toEqual([
      { type: 'text', text: 'inspect' }, { type: 'image', attachment: IMAGE },
    ])
  })

  it('accepts plain text and rejects empty output', () => {
    expect(parseAnalysis('plain answer')).toMatchObject({ title: 'image', result: 'plain answer' })
    expect(() => parseAnalysis('  ')).toThrow(/empty/)
  })
})
