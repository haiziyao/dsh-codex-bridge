import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Input for one image-model request. */
export interface VisionAnalyzeRequest {
  attachment: ImageAttachmentRef
  prompt: string
  signal?: AbortSignal
}

/** Parsed analysis and provider text retained for diagnostics. */
export interface VisionAnalyzeResult {
  title: string
  result: string
  raw: string
}

/** Protocol-independent image-analysis backend used by bridge orchestration. */
export interface VisionBackend {
  readonly id: string
  readonly model: string
  analyze(request: VisionAnalyzeRequest): Promise<VisionAnalyzeResult>
}
