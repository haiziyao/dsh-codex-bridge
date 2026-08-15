import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  createUserMessage,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { VisionAnalyzeResult, VisionBackend } from './backend.ts'
import { MIX_MODEL, type ResolvedConfig } from './config.ts'
import { CallId, type VisionCallRecord } from './history.ts'

interface AttachmentReader {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

interface HistoryWriter {
  append(record: VisionCallRecord): Promise<void>
}

/** Dependencies kept explicit so message and tool-image processing are independently testable. */
export interface TransformDependencies {
  backend: VisionBackend
  attachments: AttachmentReader
  history: HistoryWriter
  now?: () => number
  createCallId?: () => CallId
}

/** One image-analysis request owned by a live session. */
export interface AnalyzeAttachmentRequest {
  sessionId: SessionId
  origin: VisionCallRecord['origin']
  attachment: ImageAttachmentRef
  prompt: string
  signal?: AbortSignal
}

/** One pre-step transformation request owned by a live session. */
export interface TransformRequest {
  sessionId: SessionId
  messages: readonly UserMessage[]
  signal?: AbortSignal
}

/** Render the exact text sent beside an image to the selected image model. */
export function renderVisionPrompt(request: string): string {
  return [
    'You are the visual preprocessing stage for another agent. Inspect the actual pixels before answering.',
    '',
    'Analysis policy:',
    '- Answer the user request directly and use all visible evidence, not a generic image disclaimer.',
    '- For people or fictional characters, actively identify a known person/character when visual knowledge supports it. Compare distinctive hair, face, clothing, accessories, pose, art style, and likely source work; provide the best candidate and evidence. Express uncertainty only after making that comparison.',
    '- For screenshots or interfaces, transcribe important visible text and report layout, controls, current state, errors, selected items, and abnormal regions.',
    '- For documents, diagrams, or data, preserve exact labels, numbers, spatial relationships, and readable OCR text.',
    '- Do not invent details that are not visible. Distinguish a confident identification from a likely candidate.',
    '- Match the language of the request.',
    '',
    'Reply with ONLY a JSON object (no markdown or code fence) with this format:',
    '{"title":"short descriptive name","result":"complete answer to the request"}',
    '',
    `Request: ${request}`,
  ].join('\n')
}

function requestText(message: UserMessage): string {
  const text = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || 'Describe the image in detail.'
}

/** Build the durable plugin context that represents image pixels to a text-only model. */
export function createAnalysisContext(title: string, result: string): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<img-caption>',
        `title: ${title}`,
        `analysis: ${result}`,
        'The image pixels are represented by this analysis.',
        '</img-caption>',
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'bridge-gpt' },
  })
}

/** Analyze and record one attachment through the configured backend. */
export async function analyzeAttachment(
  request: AnalyzeAttachmentRequest,
  dependencies: TransformDependencies,
): Promise<VisionAnalyzeResult> {
  const now = dependencies.now ?? Date.now
  const createCallId = dependencies.createCallId ?? (() => CallId(randomUUID()))
  const stored = await dependencies.attachments.readImage(request.attachment, request.signal)
  const createdAt = now()
  const id = createCallId()
  try {
    const analyzed = await dependencies.backend.analyze({
      attachment: stored.ref,
      prompt: request.prompt,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    await dependencies.history.append({
      id,
      sessionId: request.sessionId,
      createdAt,
      durationMs: Math.max(0, now() - createdAt),
      origin: request.origin,
      backendId: dependencies.backend.id,
      model: dependencies.backend.model,
      prompt: request.prompt,
      attachment: stored.ref,
      status: 'success',
      title: analyzed.title,
      result: analyzed.result,
    })
    return analyzed
  } catch (error: unknown) {
    await dependencies.history.append({
      id,
      sessionId: request.sessionId,
      createdAt,
      durationMs: Math.max(0, now() - createdAt),
      origin: request.origin,
      backendId: dependencies.backend.id,
      model: dependencies.backend.model,
      prompt: request.prompt,
      attachment: stored.ref,
      status: 'error',
      error: String(error),
    })
    throw error
  }
}

/** Analyze only the new messages supplied for one pre-step and return text contexts for their images. */
export async function analyzeMessageImages(
  request: TransformRequest,
  dependencies: TransformDependencies,
): Promise<UserMessage[]> {
  const contexts: UserMessage[] = []
  for (const message of request.messages) {
    const images = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
    )
    if (images.length === 0) continue
    const prompt = renderVisionPrompt(requestText(message))
    for (const image of images) {
      const analyzed = await analyzeAttachment({
        sessionId: request.sessionId,
        origin: 'message',
        attachment: image.attachment,
        prompt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }, dependencies)
      contexts.push(createAnalysisContext(analyzed.title, analyzed.result))
    }
  }
  return contexts
}

function textOnlyBlocks(blocks: readonly ContentBlock[], nested: boolean): ContentBlock[] {
  const output: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      if (nested) output.push({ type: 'text', text: '[Image analyzed by Bridge GPT in the following context.]' })
      continue
    }
    if (block.type === 'tool-result') {
      output.push({ ...block, content: textOnlyBlocks(block.content, true) })
      continue
    }
    output.push(block)
  }
  return output
}

/** Image-admitting Mix route that delegates only text-safe content to the selected base model. */
export class MixedAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly current: () => ResolvedConfig) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mix' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const base = this.current().baseModel
    return Promise.resolve([{
      provider,
      id: MIX_MODEL,
      name: 'Mix',
      description: `Base: ${base.provider}/${base.model}`,
      inputModalities: ['text', 'image'],
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const base = this.current().baseModel
    return Promise.resolve({
      provider,
      id: model,
      name: 'Mix',
      description: `Base: ${base.provider}/${base.model}`,
      inputModalities: ['text', 'image'],
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages.flatMap((message) => {
      const content = textOnlyBlocks(message.content, false)
      return content.length === 0 ? [] : [{ ...message, content }]
    })
    const base = this.current().baseModel
    yield* this.ctx.llm.stream({ ...options, messages, provider: base.provider, model: base.model })
  }
}
