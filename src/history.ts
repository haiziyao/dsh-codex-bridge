import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

declare const callIdBrand: unique symbol

/** Opaque browser-visible identity for one recorded vision call. */
export type CallId = string & { readonly [callIdBrand]: true }

/** Brand a validated call id. */
export function CallId(value: string): CallId {
  if (value.length === 0) throw new TypeError('vision-mix: call id must be non-empty')
  return value as CallId
}

interface VisionCallBase {
  id: CallId
  sessionId: SessionId
  createdAt: number
  durationMs: number
  origin: 'message' | 'tool' | 'tool-result'
  backendId: string
  model: string
  prompt: string
  attachment: ImageAttachmentRef
}

/** One successful external image-analysis request. */
export interface VisionCallSuccess extends VisionCallBase {
  status: 'success'
  title: string
  result: string
}

/** One failed external image-analysis request. */
export interface VisionCallFailure extends VisionCallBase {
  status: 'error'
  error: string
}

/** Persisted sidebar row for one actual backend request. */
export type VisionCallRecord = VisionCallSuccess | VisionCallFailure

function sessionFile(root: string, sessionId: SessionId): string {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex')
  return join(root, `${digest}.jsonl`)
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`vision-mix: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`vision-mix: ${where} must be a non-empty string`)
  }
  return value
}

function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`vision-mix: ${where} must be a non-negative safe integer`)
  }
  return value as number
}

function attachment(value: unknown, where: string): ImageAttachmentRef {
  const item = object(value, where)
  const mediaType = string(item.mediaType, `${where}.mediaType`)
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
    throw new TypeError(`vision-mix: ${where}.mediaType is unsupported`)
  }
  return {
    attachmentId: AttachmentId(string(item.attachmentId, `${where}.attachmentId`)),
    mediaType: mediaType as ImageMediaType,
    bytes: integer(item.bytes, `${where}.bytes`),
    width: integer(item.width, `${where}.width`),
    height: integer(item.height, `${where}.height`),
    ...(item.name === undefined ? {} : { name: string(item.name, `${where}.name`) }),
  }
}

function parseRecord(value: unknown, where: string): VisionCallRecord {
  const item = object(value, where)
  const base: VisionCallBase = {
    id: CallId(string(item.id, `${where}.id`)),
    sessionId: toSessionId(string(item.sessionId, `${where}.sessionId`)),
    createdAt: integer(item.createdAt, `${where}.createdAt`),
    durationMs: integer(item.durationMs, `${where}.durationMs`),
    origin: item.origin === 'message' || item.origin === 'tool' || item.origin === 'tool-result'
      ? item.origin
      : (() => { throw new TypeError(`vision-mix: ${where}.origin is invalid`) })(),
    backendId: string(item.backendId, `${where}.backendId`),
    model: string(item.model, `${where}.model`),
    prompt: string(item.prompt, `${where}.prompt`),
    attachment: attachment(item.attachment, `${where}.attachment`),
  }
  if (item.status === 'success') {
    return {
      ...base,
      status: 'success',
      title: string(item.title, `${where}.title`),
      result: string(item.result, `${where}.result`),
    }
  }
  if (item.status === 'error') {
    return { ...base, status: 'error', error: string(item.error, `${where}.error`) }
  }
  throw new TypeError(`vision-mix: ${where}.status is invalid`)
}

/** Session-isolated JSONL persistence for sidebar call records. */
export class CallHistory {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  /** Append one complete call after its backend request settles. */
  async append(record: VisionCallRecord): Promise<void> {
    const key = String(record.sessionId)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true })
      await appendFile(sessionFile(this.root, record.sessionId), `${JSON.stringify(record)}\n`, 'utf8')
    })
    this.queues.set(key, next)
    try {
      await next
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }

  /** Return one session's records newest first after pending appends settle. */
  async list(sessionId: SessionId): Promise<VisionCallRecord[]> {
    await this.queues.get(String(sessionId))
    let raw: string
    try {
      raw = await readFile(sessionFile(this.root, sessionId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (raw.length === 0) return []
    const content = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    const records = content.split('\n').map((line, index) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error: unknown) {
        throw new Error(`vision-mix: malformed record at line ${index + 1}`, { cause: error })
      }
      const record = parseRecord(parsed, `record at line ${index + 1}`)
      if (record.sessionId !== sessionId) {
        throw new Error(`vision-mix: record at line ${index + 1} belongs to another session`)
      }
      return record
    })
    return records.sort((left, right) => right.createdAt - left.createdAt)
  }

  /** Resolve a call only within its owning session. */
  async get(sessionId: SessionId, id: CallId): Promise<VisionCallRecord | undefined> {
    return (await this.list(sessionId)).find(record => record.id === id)
  }
}
