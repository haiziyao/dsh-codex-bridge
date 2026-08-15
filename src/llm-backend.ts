import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type FinishReason } from '@deepseek-ai/dsh-llm'
import type { VisionAnalyzeRequest, VisionAnalyzeResult, VisionBackend } from './backend.ts'
import type { ModelRoute } from './config.ts'

/** Parse JSON image output while accepting plain text from providers that ignore the format request. */
export function parseAnalysis(raw: string): VisionAnalyzeResult {
  const trimmed = raw.trim()
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try {
    const parsed: unknown = JSON.parse(stripped)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = parsed as { title?: unknown; result?: unknown }
      if (typeof candidate.result === 'string' && candidate.result.trim().length > 0) {
        return {
          title: typeof candidate.title === 'string' && candidate.title.trim().length > 0
            ? candidate.title.trim()
            : 'image',
          result: candidate.result.trim(),
          raw: trimmed,
        }
      }
    }
  } catch {
    // Some compatible providers return useful plain text despite the requested JSON format.
  }
  if (trimmed.length === 0) throw new Error('vision-mix: selected model returned empty text')
  return { title: 'image', result: trimmed, raw: trimmed }
}

function finishError(reason: FinishReason): Error | undefined {
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined
  return new Error(`vision-mix: selected model failed: ${reason.failure.message}`)
}

/** Collect visible text from one ordinary harness model request. */
export async function generateText(
  ctx: Context,
  route: ModelRoute,
  messages: Array<Parameters<typeof createUserMessage>[0]>,
  signal?: AbortSignal,
): Promise<string> {
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: messages.map(createUserMessage),
    ...(signal === undefined ? {} : { signal }),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') {
      const error = finishError(chunk.reason)
      if (error !== undefined) throw error
    }
  }
  if (text.trim().length === 0) throw new Error('vision-mix: selected model returned empty text')
  return text.trim()
}

/** Image backend that delegates authentication and transport to a globally configured model provider. */
export class LlmVisionBackend implements VisionBackend {
  readonly id: string
  readonly model: string

  constructor(private readonly ctx: Context, private readonly route: ModelRoute) {
    this.id = route.provider
    this.model = route.model
  }

  async analyze(request: VisionAnalyzeRequest): Promise<VisionAnalyzeResult> {
    request.signal?.throwIfAborted()
    const raw = await generateText(this.ctx, this.route, [{
      content: [
        { type: 'text', text: request.prompt },
        { type: 'image', attachment: request.attachment },
      ],
      source: { kind: 'plugin', plugin: 'vision-mix' },
    }], request.signal)
    return parseAnalysis(raw)
  }
}
