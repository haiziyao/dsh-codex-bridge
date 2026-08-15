/** Host plugin for Mix routing and session-scoped image analysis. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { defineTool, type PostToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import {
  analyzeAttachment,
  analyzeMessageImages,
  createAnalysisContext,
  MixedAdapter,
  renderVisionPrompt,
} from './bridge.ts'
import {
  Config as ConfigSchema,
  MIX_PROVIDER,
  resolveConfig,
  RoutingSettingsSchema,
  type Config as PluginConfig,
} from './config.ts'
import { CallHistory } from './history.ts'
import {
  createHistoryHandlers,
  createSettingsHandlers,
  type HttpRequest,
  type HttpResponse,
} from './http.ts'
import { generateText, LlmVisionBackend } from './llm-backend.ts'
import { listSelectableModels } from './model-catalog.ts'
import { BRIDGE_GPT_SETTINGS_NAMESPACE, createSettingsController } from './settings.ts'

export const name = 'dsh-codex-bridge'
export const inject = ['agents', 'attachments', 'llm', 'settings', 'tools']
export const Config = ConfigSchema
export type Config = PluginConfig

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface WebRouteRegistry {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: HttpRequest, response: HttpResponse) => void | Promise<void>
  }): () => void
}

function webRouteRegistry(ctx: Context): WebRouteRegistry | undefined {
  const services = ctx as unknown as { webServer?: WebRouteRegistry; httpServer?: WebRouteRegistry }
  return services.webServer ?? services.httpServer
}

function imageAttachments(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const block of blocks) {
    if (block.type === 'image') refs.push(block.attachment)
    else if (block.type === 'tool-result') refs.push(...imageAttachments(block.content))
  }
  return refs
}

function toolContext(exec: ToolExecution): string {
  let args: string
  try {
    args = JSON.stringify(exec.arguments)
  } catch {
    args = '[unavailable]'
  }
  return `Tool: ${exec.name}\nArguments: ${args}`
}

async function toolVisionRequest(ctx: Context, config: ReturnType<typeof resolveConfig>, exec: ToolExecution): Promise<string> {
  const fallback = [
    'Describe this tool-produced image for the agent.',
    'Focus on visible text, page structure, interaction state, errors, and abnormalities relevant to the tool call.',
    toolContext(exec),
  ].join('\n')
  if (config.intentModel === undefined) return fallback
  const generated = await generateText(ctx, config.intentModel, [{
    content: [{
      type: 'text',
      text: [
        'Write one concise image-analysis request for a vision model.',
        'Return only the request. Do not claim to have seen the image.',
        toolContext(exec),
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'bridge-gpt' },
  }], exec.signal)
  return generated
}

/** Register the fixed Mix route, user/tool image ingress, tool, and session-history routes. */
export function apply(ctx: Context, input: PluginConfig): void {
  let config = resolveConfig(input)
  let backend = new LlmVisionBackend(ctx, config.imageModel)
  let settingsSource: () => PluginConfig = () => input
  installSettingsSection(ctx, BRIDGE_GPT_SETTINGS_NAMESPACE, RoutingSettingsSchema, input, {
    setSource: (source) => { settingsSource = source },
    validate: settings => { resolveConfig(settings) },
    onChange: () => {
      config = resolveConfig(settingsSource())
      backend = new LlmVisionBackend(ctx, config.imageModel)
    },
  })
  const history = new CallHistory(join(resolveDshHome(), 'bridge-gpt', 'v1', 'calls'))
  const dependencies = () => ({ backend, attachments: ctx.attachments, history })

  ctx.llm.registerAdapter([MIX_PROVIDER], new MixedAdapter(ctx, () => config))

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const contexts = await analyzeMessageImages({ sessionId: agent.id, messages, signal }, dependencies())
    return { kind: 'enter', messages: [...decision.messages, ...contexts] }
  }, { prepend: true })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (!config.autoAnalyzeToolImages || exec.agent === undefined || result.isError
      || decision.kind !== 'accept' || exec.name === 'bridge_gpt_image_query') return decision
    const content = decision.content ?? result.content
    const attachments = imageAttachments(content)
    if (attachments.length === 0) return decision
    const question = await toolVisionRequest(ctx, config, exec)
    const contexts = []
    for (const attachment of attachments) {
      try {
        const analyzed = await analyzeAttachment({
          sessionId: exec.agent.id,
          origin: 'tool-result',
          attachment,
          prompt: renderVisionPrompt(question),
          signal: exec.signal,
        }, dependencies())
        contexts.push(createAnalysisContext(analyzed.title, analyzed.result))
      } catch (error: unknown) {
        if (exec.signal.aborted) return decision
        contexts.push(createUserMessage({
          content: [{ type: 'text', text: `<img-caption-error>${String(error)}</img-caption-error>` }],
          source: { kind: 'plugin', plugin: 'bridge-gpt' },
        }))
      }
    }
    return {
      ...decision,
      additionalContexts: [...(decision.additionalContexts ?? []), ...contexts],
    }
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'bridge_gpt_image_query',
    description: 'Analyze a local image with the configured image model and answer one question about it.',
    parameters: {
      image_path: { type: 'string', required: true, description: 'Absolute path to an image file' },
      question: { type: 'string', required: true, description: 'Question or extraction request for the image' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('bridge-gpt: image_query requires a session-owned agent call')
      if (!isAbsolute(args.image_path)) throw new Error('bridge-gpt: image_path must be absolute')
      const mediaType = MEDIA_TYPES[extname(args.image_path).toLowerCase()]
      if (mediaType === undefined) throw new Error(`bridge-gpt: unsupported image type: ${args.image_path}`)
      const data = await readFile(args.image_path)
      const attachment = await ctx.attachments.saveImage({ data, mediaType, name: basename(args.image_path) })
      const analyzed = await analyzeAttachment({
        sessionId: exec.agent.id,
        origin: 'tool',
        attachment,
        prompt: renderVisionPrompt(args.question.trim() || 'Describe the image in detail.'),
        signal: exec.signal,
      }, dependencies())
      return analyzed.result
    },
  }))

  const historyHandlers = createHistoryHandlers({ history, attachments: ctx.attachments })
  const settingsHandlers = createSettingsHandlers(createSettingsController({
    current: () => config,
    settings: ctx.settings,
  }), { list: () => listSelectableModels(ctx) })
  let activeRegistry: WebRouteRegistry | undefined
  const mountRoutes = (routeCtx: Context): void => {
    const registry = webRouteRegistry(routeCtx)
    if (registry === undefined || activeRegistry !== undefined) return
    activeRegistry = registry
    routeCtx.effect(() => {
      const dispose = [
        registry.register({ kind: 'exact', path: '/bridge-gpt/calls', handler: historyHandlers.calls }),
        registry.register({ kind: 'prefix', path: '/bridge-gpt/image', handler: historyHandlers.image }),
        registry.register({ kind: 'exact', path: '/bridge-gpt/settings', handler: settingsHandlers.settings }),
        registry.register({ kind: 'exact', path: '/bridge-gpt/models', handler: settingsHandlers.models }),
      ]
      return () => {
        for (const unregister of dispose.reverse()) unregister()
        if (activeRegistry === registry) activeRegistry = undefined
      }
    }, 'bridge-gpt: web routes')
  }
  ctx.inject(['webServer'], mountRoutes)
  ctx.inject(['httpServer'], mountRoutes)
}
