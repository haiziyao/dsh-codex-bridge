import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationHistory } from '../src/generation-history.ts'
import { apply } from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('image generation tools', () => {
  it('uses the configured provider, persists the image, and renders its attachment block', async () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png' as const,
      bytes: 3, width: 1, height: 1, name: 'vision-mix.png',
    }
    const saveImage = vi.fn(async () => attachment)
    const append = vi.spyOn(GenerationHistory.prototype, 'append').mockResolvedValue()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), { status: 200 }))
    const tools: Array<{
      name: string
      execute(args: Record<string, string>, exec: ToolExecution): Promise<unknown>
      output: { render(args: unknown, value: never): unknown }
    }> = []
    const ctx = {
      llm: {
        registerAdapter: () => () => undefined,
        listConfigurableProviders: () => [{
          provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
        }],
        listProviders: () => [], listModels: async () => [],
      },
      tools: { register(tool: typeof tools[number]) { tools.push(tool); return () => undefined } },
      attachments: {
        saveImage,
        readImage: async (ref: typeof attachment) => ({ ref, data: new Uint8Array([1, 2, 3]) }),
      },
      settings: {
        writable: true,
        describe: () => [{
          ns: 'llm-pi-ai', revision: 1,
          value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://images.example/v1' } } },
        }],
        mutate: async () => undefined,
      },
      get(name: string) {
        if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test', source: 'test' }) }
        return undefined
      },
      on: () => () => undefined,
      inject: () => ({ dispose: () => undefined }),
    } as unknown as Context
    apply(ctx, {
      baseModel: { provider: 'base', model: 'chat' }, imageModel: { provider: 'vision', model: 'see' },
      generationModel: { provider: 'openai', model: 'gpt-image-2' },
    })
    const tool = tools.find(candidate => candidate.name === 'vision_mix_image_generate')
    if (tool === undefined) throw new Error('generation tool was not registered')
    const exec = {
      agent: { id: SessionId('generation-session') } as Agent,
      signal: new AbortController().signal,
    } as ToolExecution

    const value = await tool.execute({ prompt: 'A stone bridge at sunrise' }, exec) as never
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({
      data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: expect.stringMatching(/^vision-mix-\d+\.png$/),
    }))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SessionId('generation-session'), operation: 'generate', status: 'success', outputAttachment: attachment,
    }))
    expect(tool.output.render({}, value)).toEqual([
      { type: 'text', text: expect.stringContaining(`attachment_id="${attachment.attachmentId}"`) },
      { type: 'image', attachment },
    ])
  })
})
