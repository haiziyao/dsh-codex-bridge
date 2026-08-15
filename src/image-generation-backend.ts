import type { ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageGenerationQuality, ImageGenerationSize, ImageOutputFormat } from './config.ts'

/** Settings and call-specific options for one image operation. */
export interface ImageGenerationRequest {
  prompt: string
  size: ImageGenerationSize
  quality: ImageGenerationQuality
  outputFormat: ImageOutputFormat
  signal?: AbortSignal
}

/** Image edit request carrying session-authorized source attachments. */
export interface ImageEditRequest extends ImageGenerationRequest {
  images: readonly StoredImageAttachment[]
}

/** Decoded image bytes returned by one backend. */
export interface GeneratedImage {
  data: Uint8Array
  mediaType: Exclude<ImageMediaType, 'image/gif'>
}

/** Provider-neutral image generation and edit capability. */
export interface ImageGenerationBackend {
  readonly id: string
  readonly model: string
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>
  edit(request: ImageEditRequest): Promise<GeneratedImage>
}
