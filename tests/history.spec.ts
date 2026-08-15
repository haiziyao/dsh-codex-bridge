import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CallHistory, CallId, type VisionCallRecord } from '../src/history.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function history(): Promise<{ root: string; history: CallHistory }> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-gpt-history-'))
  roots.push(root)
  return { root, history: new CallHistory(root) }
}

function record(session: string, id: string, createdAt: number): VisionCallRecord {
  return {
    id: CallId(id),
    sessionId: SessionId(session),
    createdAt,
    durationMs: 12,
    origin: 'message',
    backendId: 'codex',
    model: 'vision-model',
    prompt: `prompt-${id}`,
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    },
    status: 'success',
    title: 'screen',
    result: `result-${id}`,
  }
}

describe('CallHistory', () => {
  it('isolates records by session', async () => {
    const store = await history()
    await store.history.append(record('session-a', 'a', 1))
    await store.history.append(record('session-b', 'b', 2))

    await expect(store.history.list(SessionId('session-a'))).resolves.toEqual([record('session-a', 'a', 1)])
    await expect(store.history.list(SessionId('session-b'))).resolves.toEqual([record('session-b', 'b', 2)])
  })

  it('serializes concurrent appends and returns newest records first', async () => {
    const store = await history()
    await Promise.all([
      store.history.append(record('session-a', 'one', 1)),
      store.history.append(record('session-a', 'two', 2)),
      store.history.append(record('session-a', 'three', 3)),
    ])

    await expect(store.history.list(SessionId('session-a'))).resolves.toEqual([
      record('session-a', 'three', 3),
      record('session-a', 'two', 2),
      record('session-a', 'one', 1),
    ])
  })

  it('finds a call only inside its owning session', async () => {
    const store = await history()
    const item = record('session-a', 'one', 1)
    await store.history.append(item)

    await expect(store.history.get(SessionId('session-a'), item.id)).resolves.toEqual(item)
    await expect(store.history.get(SessionId('session-b'), item.id)).resolves.toBeUndefined()
  })

  it('rejects a malformed stored line instead of returning partial history', async () => {
    const store = await history()
    const sessionId = SessionId('session-a')
    const filename = `${createHash('sha256').update(sessionId).digest('hex')}.jsonl`
    await mkdir(store.root, { recursive: true })
    await writeFile(join(store.root, filename), `${JSON.stringify(record('session-a', 'one', 1))}\n{broken}\n`, 'utf8')

    await expect(store.history.list(sessionId)).rejects.toThrow(/malformed record at line 2/)
  })
})
