import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ModelRoute, ImageOutputFormat } from './config.ts'
import type { GeneratedImage, ImageEditRequest, ImageGenerationBackend, ImageGenerationRequest } from './image-generation-backend.ts'
import { resolveImageProvider } from './generation-provider.ts'

const MEDIA_TYPES: Record<ImageOutputFormat, Exclude<ImageMediaType, 'image/gif'>> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
}

function endpoint(baseURL: string, operation: 'generations' | 'edits'): string {
  return `${baseURL.replace(/\/+$/, '')}/images/${operation}`
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('vision-mix: image API returned invalid base64 data')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength === 0) throw new Error('vision-mix: image API returned an empty image')
  return Uint8Array.from(decoded)
}

async function responseImage(response: Response, format: ImageOutputFormat): Promise<GeneratedImage> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 4_096)
    throw new Error(`vision-mix: image API HTTP ${response.status}${detail.length === 0 ? '' : `: ${detail}`}`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch (error: unknown) {
    throw new Error('vision-mix: image API returned invalid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) {
    throw new Error('vision-mix: image API response has no data array')
  }
  const first = (value as { data: unknown[] }).data[0]
  if (first === null || typeof first !== 'object') throw new Error('vision-mix: image API returned no image')
  return { data: decodeBase64((first as { b64_json?: unknown }).b64_json), mediaType: MEDIA_TYPES[format] }
}

/** OpenAI Images API implementation that resolves DSH provider settings per operation. */
export class OpenAiImageBackend implements ImageGenerationBackend {
  readonly id = 'openai-images'
  readonly model: string

  constructor(
    private readonly ctx: Context,
    private readonly route: ModelRoute,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.model = route.model
  }

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const connection = await resolveImageProvider(this.ctx, this.route.provider)
    const response = await this.fetcher(endpoint(connection.baseURL, 'generations'), {
      method: 'POST',
      headers: {
        ...connection.headers,
        authorization: `Bearer ${connection.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.route.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        output_format: request.outputFormat,
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return responseImage(response, request.outputFormat)
  }

  async edit(request: ImageEditRequest): Promise<GeneratedImage> {
    if (request.images.length === 0) throw new TypeError('vision-mix: image edit requires at least one source image')
    const connection = await resolveImageProvider(this.ctx, this.route.provider)
    const body = new FormData()
    body.set('model', this.route.model)
    body.set('prompt', request.prompt)
    body.set('size', request.size)
    body.set('quality', request.quality)
    body.set('output_format', request.outputFormat)
    for (const [index, image] of request.images.entries()) {
      body.append('image[]', new Blob([new Uint8Array(image.data)], { type: image.ref.mediaType }), image.ref.name ?? `source-${index + 1}`)
    }
    const response = await this.fetcher(endpoint(connection.baseURL, 'edits'), {
      method: 'POST',
      headers: { ...connection.headers, authorization: `Bearer ${connection.apiKey}` },
      body,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return responseImage(response, request.outputFormat)
  }
}
