import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GenerationHistory, GenerationId, type GenerationRecord } from '../src/generation-history.ts'

const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function record(session: string, id: string, createdAt: number): GenerationRecord {
  return {
    id: GenerationId(id), sessionId: SessionId(session), createdAt, durationMs: 10,
    operation: 'generate', backendId: 'openai-images', model: 'gpt-image-2', prompt: `prompt-${id}`,
    sourceAttachments: [], size: 'auto', quality: 'auto', outputFormat: 'png', status: 'success',
    outputAttachment: {
      attachmentId: AttachmentId(`sha256:${id.padEnd(64, 'a').slice(0, 64)}`), mediaType: 'image/png',
      bytes: 3, width: 1, height: 1, name: `${id}.png`,
    },
  }
}

describe('GenerationHistory', () => {
  it('isolates sessions, serializes appends, and returns newest first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-mix-generation-'))
    roots.push(root)
    const history = new GenerationHistory(root)
    await Promise.all([
      history.append(record('session-a', 'one', 1)),
      history.append(record('session-a', 'two', 2)),
      history.append(record('session-b', 'other', 3)),
    ])
    await expect(history.list(SessionId('session-a'))).resolves.toEqual([
      record('session-a', 'two', 2), record('session-a', 'one', 1),
    ])
    await expect(history.get(SessionId('session-b'), GenerationId('two'))).resolves.toBeUndefined()
  })
})
