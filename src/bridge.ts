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

/** Hook that can finish a preprocessing-only Mix step before base-model delegation. */
export type DeferBaseModel = (options: GenerateOptions) => Promise<boolean>

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

/** Return the text portion of one user message. */
export function requestText(message: UserMessage): string {
  const text = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || 'Describe the image in detail.'
}

/** Return the text supplied by the current claimed user-message batch. */
export function requestBatchText(messages: readonly UserMessage[]): string {
  return messages.map(requestText).filter(text => text.length > 0).join('\n').trim()
}

/** Whether a text request explicitly points back to an image in the session. */
export function explicitlyReferencesImage(request: string): boolean {
  return /(?:这|那|上|前|刚才|之前).{0,8}(?:张)?(?:图|图片|截图|照片)|(?:图|图片|截图|照片|画面)(?:里|中|上|的)|(?:继续|再).{0,8}(?:图|图片|截图|照片)/u.test(request)
    || /\b(?:this|that|the|previous|above|last|same)\s+(?:image|picture|photo|screenshot)\b|\b(?:in|from|about)\s+(?:it|the image|the picture|the screenshot)\b/iu.test(request)
}

/** Parse the strict JSON response requested from the image-reference classifier. */
export function parseImageReferenceDecision(value: string): boolean {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const parsed: unknown = JSON.parse(trimmed)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || typeof (parsed as Record<string, unknown>).referencesImage !== 'boolean') {
    throw new Error('vision-mix: intent model returned an invalid image-reference decision')
  }
  return (parsed as { referencesImage: boolean }).referencesImage
}

/** Stable logical locator for one opaque DSH attachment id. */
export function attachmentLocator(attachment: ImageAttachmentRef): string {
  return `dsh-attachment://${encodeURIComponent(String(attachment.attachmentId))}`
}

function attachmentLines(attachment: ImageAttachmentRef): string[] {
  return [
    `attachment_id: ${String(attachment.attachmentId)}`,
    `attachment_locator: ${attachmentLocator(attachment)}`,
    ...(attachment.name === undefined ? [] : [`original_name: ${attachment.name}`]),
    `media_type: ${attachment.mediaType}`,
    `dimensions: ${attachment.width}x${attachment.height}`,
    `encoded_bytes: ${attachment.bytes}`,
  ]
}

/** Replace image bytes with an actionable, model-readable attachment reference. */
export function renderAttachmentReference(attachment: ImageAttachmentRef): string {
  return [
    '<image-attachment>',
    ...attachmentLines(attachment),
    'storage: Private DSH attachment storage; this locator is not a workspace filesystem path.',
    'Do not search the workspace for this image. Vision Mix can reopen it by attachment_id for pixel-level follow-up.',
    '</image-attachment>',
  ].join('\n')
}

/** Build the durable plugin context that represents image pixels to a text-only model. */
export function createAnalysisContext(
  title: string,
  result: string,
  attachment: ImageAttachmentRef,
): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<img-caption>',
        ...attachmentLines(attachment),
        `title: ${title}`,
        `analysis: ${result}`,
        'The vision backend inspected the actual stored bytes for this attachment.',
        'This is not a workspace file path. Do not search the filesystem or claim the pixels are unavailable.',
        'For another pixel-level question, Vision Mix can reopen this attachment by attachment_id.',
        '</img-caption>',
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'vision-mix' },
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
      contexts.push(createAnalysisContext(analyzed.title, analyzed.result, image.attachment))
    }
  }
  return contexts
}

function textOnlyBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  const output: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      output.push({ type: 'text', text: renderAttachmentReference(block.attachment) })
      continue
    }
    if (block.type === 'tool-result') {
      output.push({ ...block, content: textOnlyBlocks(block.content) })
      continue
    }
    output.push(block)
  }
  return output
}

/** Image-admitting Mix route that delegates only text-safe content to the selected base model. */
export class MixedAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly current: () => ResolvedConfig,
    private readonly deferBaseModel?: DeferBaseModel,
  ) {
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
    if (this.deferBaseModel !== undefined && await this.deferBaseModel(options)) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const messages = options.messages.flatMap((message) => {
      const content = textOnlyBlocks(message.content)
      return content.length === 0 ? [] : [{ ...message, content }]
    })
    const base = this.current().baseModel
    yield* this.ctx.llm.stream({ ...options, messages, provider: base.provider, model: base.model })
  }
}
