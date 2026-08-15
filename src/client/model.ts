/** Browser-safe metadata and locator source for one stored image. */
export interface VisionAttachmentView {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

/** Browser projection of one session-scoped vision call. */
export type VisionCallView = {
  id: string
  createdAt: number
  durationMs: number
  origin: 'message' | 'tool' | 'tool-result'
  backendId: string
  model: string
  prompt: string
  attachment: VisionAttachmentView
} & (
  | { status: 'success'; title: string; result: string }
  | { status: 'error'; error: string }
)

/** One date section in the vertical call list. */
export interface VisionCallGroup {
  date: string
  calls: VisionCallView[]
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`bridge-gpt: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`bridge-gpt: ${where} must be a non-empty string`)
  }
  return value
}

function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`bridge-gpt: ${where} must be a non-negative safe integer`)
  }
  return value as number
}

/** Validate the host response and retain only fields rendered by the client. */
export function parseCallsPayload(payload: unknown): VisionCallView[] {
  const root = object(payload, 'response')
  if (!Array.isArray(root.calls)) throw new TypeError('bridge-gpt: response.calls must be an array')
  return root.calls.map((value, index) => {
    const where = `calls[${index}]`
    const item = object(value, where)
    const rawAttachment = object(item.attachment, `${where}.attachment`)
    const mediaType: VisionAttachmentView['mediaType'] = rawAttachment.mediaType === 'image/png' || rawAttachment.mediaType === 'image/jpeg'
      || rawAttachment.mediaType === 'image/webp' || rawAttachment.mediaType === 'image/gif'
      ? rawAttachment.mediaType
      : (() => { throw new TypeError(`bridge-gpt: ${where}.attachment.mediaType is invalid`) })()
    const attachment: VisionAttachmentView = {
      attachmentId: text(rawAttachment.attachmentId, `${where}.attachment.attachmentId`),
      mediaType,
      bytes: integer(rawAttachment.bytes, `${where}.attachment.bytes`),
      width: integer(rawAttachment.width, `${where}.attachment.width`),
      height: integer(rawAttachment.height, `${where}.attachment.height`),
      ...(rawAttachment.name === undefined
        ? {}
        : { name: text(rawAttachment.name, `${where}.attachment.name`) }),
    }
    const origin: 'message' | 'tool' | 'tool-result' = item.origin === 'message' || item.origin === 'tool' || item.origin === 'tool-result'
      ? item.origin
      : (() => { throw new TypeError(`bridge-gpt: ${where}.origin is invalid`) })()
    const base = {
      id: text(item.id, `${where}.id`),
      createdAt: integer(item.createdAt, `${where}.createdAt`),
      durationMs: integer(item.durationMs, `${where}.durationMs`),
      origin,
      backendId: text(item.backendId, `${where}.backendId`),
      model: text(item.model, `${where}.model`),
      prompt: text(item.prompt, `${where}.prompt`),
      attachment,
    }
    if (item.status === 'success') {
      return {
        ...base,
        status: 'success' as const,
        title: text(item.title, `${where}.title`),
        result: text(item.result, `${where}.result`),
      }
    }
    if (item.status === 'error') {
      return { ...base, status: 'error' as const, error: text(item.error, `${where}.error`) }
    }
    throw new TypeError(`bridge-gpt: ${where}.status is invalid`)
  })
}

/** Build the stable logical locator shown for one opaque attachment id. */
export function attachmentLocator(attachmentId: string): string {
  return `dsh-attachment://${encodeURIComponent(attachmentId)}`
}

/** Build the read-only call-list URL for one session. */
export function callsUrl(sessionId: string): string {
  return `/bridge-gpt/calls?sessionId=${encodeURIComponent(sessionId)}`
}

/** Build a preview URL authorized by both session and call identity. */
export function imageUrl(sessionId: string, callId: string): string {
  return `/bridge-gpt/image/${encodeURIComponent(callId)}?sessionId=${encodeURIComponent(sessionId)}`
}

/** Sort calls newest first and collect them into date sections. */
export function groupCalls(
  calls: readonly VisionCallView[],
  formatDate: (createdAt: number) => string = createdAt => new Intl.DateTimeFormat(
    undefined,
    { dateStyle: 'medium' },
  ).format(new Date(createdAt)),
): VisionCallGroup[] {
  const groups = new Map<string, VisionCallView[]>()
  for (const call of [...calls].sort((left, right) => right.createdAt - left.createdAt)) {
    const date = formatDate(call.createdAt)
    const group = groups.get(date)
    if (group === undefined) groups.set(date, [call])
    else group.push(call)
  }
  return [...groups].map(([date, grouped]) => ({ date, calls: grouped }))
}
