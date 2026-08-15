import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { CallId, type CallId as CallIdType, type VisionCallRecord } from './history.ts'

/** Minimal request fields used by the read-only routes. */
export interface HttpRequest {
  method?: string | undefined
  url?: string | undefined
  headers?: Record<string, string | string[] | undefined> | undefined
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>
}

/** Settings operations exposed through the plugin-owned Web routes. */
export interface SettingsController {
  describe(): unknown | Promise<unknown>
  updateRouting(input: { revision: number; routing: never }): Promise<void>
}

/** Handlers for the Web settings page and configured-model catalog. */
export interface SettingsHandlers {
  settings(request: HttpRequest, response: HttpResponse): Promise<void>
  models(request: HttpRequest, response: HttpResponse): Promise<void>
}

/** Live model catalog supplied by the harness LLM registry. */
export interface ModelCatalogReader {
  list(): Promise<unknown>
}

/** Minimal response methods shared with Node's ServerResponse. */
export interface HttpResponse {
  headersSent: boolean
  writeHead(status: number, headers?: Record<string, string | number>): void
  end(data?: string | Uint8Array): void
}

interface HistoryReader {
  list(sessionId: SessionIdType): Promise<VisionCallRecord[]>
  get(sessionId: SessionIdType, id: CallIdType): Promise<VisionCallRecord | undefined>
}

interface AttachmentReader {
  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment>
}

/** Dependencies used by the session-scoped call-history routes. */
export interface HistoryHandlerDependencies {
  history: HistoryReader
  attachments: AttachmentReader
}

/** Read-only handlers registered by the host plugin. */
export interface HistoryHandlers {
  calls(request: HttpRequest, response: HttpResponse): Promise<void>
  image(request: HttpRequest, response: HttpResponse): Promise<void>
}

function empty(response: HttpResponse, status: number, headers?: Record<string, string | number>): void {
  response.writeHead(status, headers)
  response.end()
}

function json(response: HttpResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function jsonBody(request: HttpRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers?.['content-type']
  const normalized = Array.isArray(contentType) ? contentType[0] : contentType
  if (normalized?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new TypeError('bridge-gpt: settings writes require application/json')
  }
  const iterator = request[Symbol.asyncIterator]
  if (iterator === undefined) throw new TypeError('bridge-gpt: request body is unavailable')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of { [Symbol.asyncIterator]: iterator.bind(request) }) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += data.byteLength
    if (bytes > 128 * 1024) throw new TypeError('bridge-gpt: settings request exceeds 128 KiB')
    chunks.push(data)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('bridge-gpt: settings request must be an object')
  }
  return parsed as Record<string, unknown>
}

/** Build same-origin JSON handlers over persistent routing and the live model registry. */
export function createSettingsHandlers(
  controller: SettingsController,
  catalog: ModelCatalogReader,
): SettingsHandlers {
  return {
    async settings(request, response): Promise<void> {
      try {
        if (request.method === 'GET') {
          json(response, 200, await controller.describe())
          return
        }
        if (request.method !== 'PUT') {
          empty(response, 405, { allow: 'GET, PUT' })
          return
        }
        const body = await jsonBody(request)
        await controller.updateRouting({ revision: body.revision as number, routing: body.routing as never })
        json(response, 200, await controller.describe())
      } catch (error: unknown) {
        if (!response.headersSent) json(response, 400, { error: String(error) })
      }
    },

    async models(request, response): Promise<void> {
      try {
        if (request.method !== 'GET') {
          empty(response, 405, { allow: 'GET' })
          return
        }
        json(response, 200, await catalog.list())
      } catch (error: unknown) {
        if (!response.headersSent) json(response, 500, { error: String(error) })
      }
    },
  }
}

function requestedSession(url: URL): SessionIdType | undefined {
  const raw = url.searchParams.get('sessionId')
  return raw === null || raw.length === 0 ? undefined : SessionId(raw)
}

/** Build handlers whose call lookup authorizes every image preview. */
export function createHistoryHandlers(dependencies: HistoryHandlerDependencies): HistoryHandlers {
  return {
    async calls(request, response): Promise<void> {
      if (request.method !== 'GET') {
        empty(response, 405, { allow: 'GET' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://bridge-gpt.local')
      const sessionId = requestedSession(url)
      if (sessionId === undefined) {
        empty(response, 400)
        return
      }
      try {
        const calls = await dependencies.history.list(sessionId)
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify({ calls }))
      } catch {
        if (!response.headersSent) empty(response, 500)
      }
    },

    async image(request, response): Promise<void> {
      if (request.method !== 'GET') {
        empty(response, 405, { allow: 'GET' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://bridge-gpt.local')
      const sessionId = requestedSession(url)
      const encoded = url.pathname.slice('/bridge-gpt/image/'.length)
      if (sessionId === undefined || encoded.length === 0) {
        empty(response, 400)
        return
      }
      let id: CallIdType
      try {
        id = CallId(decodeURIComponent(encoded))
      } catch {
        empty(response, 400)
        return
      }
      try {
        const record = await dependencies.history.get(sessionId, id)
        if (record === undefined) {
          empty(response, 404)
          return
        }
        const stored = await dependencies.attachments.readImage(record.attachment)
        response.writeHead(200, {
          'content-type': stored.ref.mediaType,
          'content-length': stored.data.byteLength,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        })
        response.end(stored.data)
      } catch {
        if (!response.headersSent) empty(response, 500)
      }
    },
  }
}
