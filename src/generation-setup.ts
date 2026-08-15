import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ModelRoute } from './config.ts'
import { OpenAiImageBackend } from './openai-image-backend.ts'

/** Successful configuration-time Images API probe. */
export interface GenerationSetupResult {
  route: ModelRoute
  message: string
  mediaType: Exclude<ImageMediaType, 'image/gif'>
  bytes: number
  previewDataUrl?: string
}

/** Send one inexpensive generation request through an independently selected Provider. */
export async function testGenerationRoute(ctx: Context, route: ModelRoute): Promise<GenerationSetupResult> {
  const backend = new OpenAiImageBackend(ctx, route)
  const generated = await backend.generate({
    prompt: 'A minimal flat blue bridge icon centered on a plain white background. No text. Configuration test image.',
    size: '1024x1024',
    quality: 'low',
    outputFormat: 'png',
  })
  await ctx.attachments.validateImage({
    data: generated.data,
    mediaType: generated.mediaType,
    name: 'vision-mix-generation-api-test.png',
  })
  return {
    route,
    message: `生图 API 测试通过：${route.provider}/${route.model} 返回了 ${generated.mediaType} 图片。`,
    mediaType: generated.mediaType,
    bytes: generated.data.byteLength,
    ...(generated.data.byteLength > 5 * 1024 * 1024
      ? {}
      : { previewDataUrl: `data:${generated.mediaType};base64,${Buffer.from(generated.data).toString('base64')}` }),
  }
}
