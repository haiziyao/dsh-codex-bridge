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

/** Protocol-independent image-analysis backend used by Mix orchestration. */
export interface VisionBackend {
  readonly id: string
  readonly model: string
  analyze(request: VisionAnalyzeRequest): Promise<VisionAnalyzeResult>
}

/** Image backend used until onboarding selects a real model route. */
export class UnconfiguredVisionBackend implements VisionBackend {
  readonly id = 'unconfigured'
  readonly model = 'unconfigured'

  async analyze(_request: VisionAnalyzeRequest): Promise<never> {
    throw new Error('vision-mix: no image model is configured; open Settings → Vision Mix → 基础设置')
  }
}
