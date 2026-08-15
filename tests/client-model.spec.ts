import { describe, expect, it } from 'vitest'
import {
  attachmentLocator,
  callsUrl,
  groupCalls,
  imageUrl,
  parseCallsPayload,
  type VisionCallView,
} from '../src/client/model.ts'

function call(id: string, createdAt: number): VisionCallView {
  return {
    id,
    createdAt,
    durationMs: 10,
    origin: 'message',
    backendId: 'codex',
    model: 'vision',
    prompt: `prompt-${id}`,
    attachment: {
      attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 2048,
      width: 1280, height: 720, name: 'screen.png',
    },
    status: 'success',
    title: id,
    result: `result-${id}`,
  }
}

describe('client history model', () => {
  it('groups calls by date with newest groups and rows first', () => {
    const groups = groupCalls([
      call('old', 10),
      call('new', 30),
      call('middle', 20),
    ], value => value >= 20 ? 'day-2' : 'day-1')

    expect(groups).toEqual([
      { date: 'day-2', calls: [call('new', 30), call('middle', 20)] },
      { date: 'day-1', calls: [call('old', 10)] },
    ])
  })

  it('builds session-specific list and preview URLs', () => {
    expect(callsUrl('session/a b')).toBe('/bridge-gpt/calls?sessionId=session%2Fa%20b')
    expect(imageUrl('session/a b', 'call/#1')).toBe(
      '/bridge-gpt/image/call%2F%231?sessionId=session%2Fa%20b',
    )
    expect(attachmentLocator('sha256:abc')).toBe('dsh-attachment://sha256%3Aabc')
  })

  it('validates the HTTP payload before rendering it', () => {
    const item = call('one', 10)
    expect(parseCallsPayload({ calls: [{ ...item, sessionId: 'session-a' }] })).toEqual([item])
    expect(() => parseCallsPayload({ calls: [{ ...item, durationMs: 'fast' }] })).toThrow(
      /calls\[0\]\.durationMs/,
    )
    expect(() => parseCallsPayload({ calls: [{ ...item, attachment: {} }] })).toThrow(
      /calls\[0\]\.attachment\.mediaType/,
    )
  })
})
