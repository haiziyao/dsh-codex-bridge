import type { ImageGenerationQuality, ImageGenerationSize, ImageOutputFormat } from '../config.ts'
import type { VisionAttachmentView } from './model.ts'

/** Browser projection of one image generation or edit operation. */
export type GenerationView = {
  id: string
  createdAt: number
  durationMs: number
  operation: 'generate' | 'edit'
  backendId: string
  model: string
  prompt: string
  sourceAttachments: VisionAttachmentView[]
  size: ImageGenerationSize
  quality: ImageGenerationQuality
  outputFormat: ImageOutputFormat
} & (
  | { status: 'success'; outputAttachment: VisionAttachmentView }
  | { status: 'error'; error: string }
)

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

function attachment(value: unknown, where: string): VisionAttachmentView {
  const item = object(value, where)
  const mediaType = item.mediaType === 'image/png' || item.mediaType === 'image/jpeg'
    || item.mediaType === 'image/webp' || item.mediaType === 'image/gif'
    ? item.mediaType
    : (() => { throw new TypeError(`vision-mix: ${where}.mediaType is invalid`) })()
  return {
    attachmentId: text(item.attachmentId, `${where}.attachmentId`),
    mediaType,
    bytes: integer(item.bytes, `${where}.bytes`),
    width: integer(item.width, `${where}.width`),
    height: integer(item.height, `${where}.height`),
    ...(item.name === undefined ? {} : { name: text(item.name, `${where}.name`) }),
  }
}

/** Validate the generation-history response before rendering it. */
export function parseGenerationsPayload(value: unknown): GenerationView[] {
  const root = object(value, 'generation response')
  if (!Array.isArray(root.generations)) throw new TypeError('vision-mix: response.generations must be an array')
  return root.generations.map((entry, index) => {
    const where = `generations[${index}]`
    const item = object(entry, where)
    if (!Array.isArray(item.sourceAttachments)) throw new TypeError(`vision-mix: ${where}.sourceAttachments is invalid`)
    const operation: GenerationView['operation'] = item.operation === 'generate' || item.operation === 'edit'
      ? item.operation
      : (() => { throw new TypeError(`vision-mix: ${where}.operation is invalid`) })()
    const size: ImageGenerationSize = item.size === 'auto' || item.size === '1024x1024' || item.size === '1536x1024' || item.size === '1024x1536'
      ? item.size
      : (() => { throw new TypeError(`vision-mix: ${where}.size is invalid`) })()
    const quality: ImageGenerationQuality = item.quality === 'auto' || item.quality === 'low' || item.quality === 'medium' || item.quality === 'high'
      ? item.quality
      : (() => { throw new TypeError(`vision-mix: ${where}.quality is invalid`) })()
    const outputFormat: ImageOutputFormat = item.outputFormat === 'png' || item.outputFormat === 'jpeg' || item.outputFormat === 'webp'
      ? item.outputFormat
      : (() => { throw new TypeError(`vision-mix: ${where}.outputFormat is invalid`) })()
    const base = {
      id: text(item.id, `${where}.id`),
      createdAt: integer(item.createdAt, `${where}.createdAt`),
      durationMs: integer(item.durationMs, `${where}.durationMs`),
      operation,
      backendId: text(item.backendId, `${where}.backendId`),
      model: text(item.model, `${where}.model`),
      prompt: text(item.prompt, `${where}.prompt`),
      sourceAttachments: item.sourceAttachments.map((source, sourceIndex) => attachment(source, `${where}.sourceAttachments[${sourceIndex}]`)),
      size,
      quality,
      outputFormat,
    }
    if (item.status === 'success') return { ...base, status: 'success' as const, outputAttachment: attachment(item.outputAttachment, `${where}.outputAttachment`) }
    if (item.status === 'error') return { ...base, status: 'error' as const, error: text(item.error, `${where}.error`) }
    throw new TypeError(`vision-mix: ${where}.status is invalid`)
  })
}

/** Build the session-scoped generation-list endpoint. */
export function generationsUrl(sessionId: string): string {
  return `/vision-mix/generations?sessionId=${encodeURIComponent(sessionId)}`
}

/** Build the session-authorized generated-image preview endpoint. */
export function generatedImageUrl(sessionId: string, id: string): string {
  return `/vision-mix/generated-image/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`
}
