import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageGenerationQuality, ImageGenerationSize, ImageOutputFormat } from './config.ts'

declare const generationIdBrand: unique symbol

/** Opaque identity for one image generation or edit request. */
export type GenerationId = string & { readonly [generationIdBrand]: true }

/** Brand one validated generation record id. */
export function GenerationId(value: string): GenerationId {
  if (value.length === 0) throw new TypeError('vision-mix: generation id must be non-empty')
  return value as GenerationId
}

interface GenerationBase {
  id: GenerationId
  sessionId: SessionIdType
  createdAt: number
  durationMs: number
  operation: 'generate' | 'edit'
  backendId: string
  model: string
  prompt: string
  sourceAttachments: ImageAttachmentRef[]
  size: ImageGenerationSize
  quality: ImageGenerationQuality
  outputFormat: ImageOutputFormat
}

/** Successful image operation with its durable output attachment. */
export interface GenerationSuccess extends GenerationBase {
  status: 'success'
  outputAttachment: ImageAttachmentRef
}

/** Failed image operation retained for the session sidebar. */
export interface GenerationFailure extends GenerationBase {
  status: 'error'
  error: string
}

/** One persisted image generation or edit record. */
export type GenerationRecord = GenerationSuccess | GenerationFailure

function sessionFile(root: string, sessionId: SessionIdType): string {
  return join(root, `${createHash('sha256').update(String(sessionId)).digest('hex')}.jsonl`)
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`vision-mix: ${where} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`vision-mix: ${where} must be non-empty text`)
  return value
}

function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`vision-mix: ${where} must be a non-negative safe integer`)
  return value as number
}

function attachment(value: unknown, where: string): ImageAttachmentRef {
  const item = object(value, where)
  const mediaType = text(item.mediaType, `${where}.mediaType`)
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw new TypeError(`vision-mix: ${where}.mediaType is unsupported`)
  return {
    attachmentId: AttachmentId(text(item.attachmentId, `${where}.attachmentId`)),
    mediaType: mediaType as ImageMediaType,
    bytes: integer(item.bytes, `${where}.bytes`),
    width: integer(item.width, `${where}.width`),
    height: integer(item.height, `${where}.height`),
    ...(item.name === undefined ? {} : { name: text(item.name, `${where}.name`) }),
  }
}

function parseRecord(value: unknown, where: string): GenerationRecord {
  const item = object(value, where)
  if (!Array.isArray(item.sourceAttachments)) throw new TypeError(`vision-mix: ${where}.sourceAttachments must be an array`)
  const operation = item.operation === 'generate' || item.operation === 'edit'
    ? item.operation
    : (() => { throw new TypeError(`vision-mix: ${where}.operation is invalid`) })()
  const size = ['auto', '1024x1024', '1536x1024', '1024x1536'].includes(String(item.size))
    ? item.size as ImageGenerationSize
    : (() => { throw new TypeError(`vision-mix: ${where}.size is invalid`) })()
  const quality = ['auto', 'low', 'medium', 'high'].includes(String(item.quality))
    ? item.quality as ImageGenerationQuality
    : (() => { throw new TypeError(`vision-mix: ${where}.quality is invalid`) })()
  const outputFormat = ['png', 'jpeg', 'webp'].includes(String(item.outputFormat))
    ? item.outputFormat as ImageOutputFormat
    : (() => { throw new TypeError(`vision-mix: ${where}.outputFormat is invalid`) })()
  const base: GenerationBase = {
    id: GenerationId(text(item.id, `${where}.id`)),
    sessionId: SessionId(text(item.sessionId, `${where}.sessionId`)),
    createdAt: integer(item.createdAt, `${where}.createdAt`),
    durationMs: integer(item.durationMs, `${where}.durationMs`),
    operation,
    backendId: text(item.backendId, `${where}.backendId`),
    model: text(item.model, `${where}.model`),
    prompt: text(item.prompt, `${where}.prompt`),
    sourceAttachments: item.sourceAttachments.map((entry, index) => attachment(entry, `${where}.sourceAttachments[${index}]`)),
    size,
    quality,
    outputFormat,
  }
  if (item.status === 'success') return { ...base, status: 'success', outputAttachment: attachment(item.outputAttachment, `${where}.outputAttachment`) }
  if (item.status === 'error') return { ...base, status: 'error', error: text(item.error, `${where}.error`) }
  throw new TypeError(`vision-mix: ${where}.status is invalid`)
}

/** Session-isolated persistence for image generation and edit records. */
export class GenerationHistory {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  /** Append one settled image operation. */
  async append(record: GenerationRecord): Promise<void> {
    const key = String(record.sessionId)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true })
      await appendFile(sessionFile(this.root, record.sessionId), `${JSON.stringify(record)}\n`, 'utf8')
    })
    this.queues.set(key, next)
    try { await next } finally { if (this.queues.get(key) === next) this.queues.delete(key) }
  }

  /** Return one session's operations newest first. */
  async list(sessionId: SessionIdType): Promise<GenerationRecord[]> {
    await this.queues.get(String(sessionId))
    let raw: string
    try {
      raw = await readFile(sessionFile(this.root, sessionId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (raw.length === 0) return []
    const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n')
    return lines.map((line, index) => {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch (error: unknown) {
        throw new Error(`vision-mix: malformed generation record at line ${index + 1}`, { cause: error })
      }
      const record = parseRecord(parsed, `generation record at line ${index + 1}`)
      if (record.sessionId !== sessionId) throw new Error(`vision-mix: generation record at line ${index + 1} belongs to another session`)
      return record
    }).sort((left, right) => right.createdAt - left.createdAt)
  }

  /** Resolve one generation only inside its owning session. */
  async get(sessionId: SessionIdType, id: GenerationId): Promise<GenerationRecord | undefined> {
    return (await this.list(sessionId)).find(record => record.id === id)
  }
}
