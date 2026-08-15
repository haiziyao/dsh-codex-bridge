import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId as LlmCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CallHistory } from '../src/history.ts'
import { createSettingsHandlers, type HttpRequest, type HttpResponse } from '../src/http.ts'
import { apply } from '../src/index.ts'

class ResponseCapture implements HttpResponse {
  headersSent = false
  status = 0
  body: string | Uint8Array = ''
  writeHead(status: number): void { this.headersSent = true; this.status = status }
  end(data: string | Uint8Array = ''): void { this.body = data }
}

describe('Bridge GPT HTTP settings', () => {
  it('updates routing and serves the live model catalog without credential routes', async () => {
    const updateRouting = vi.fn(async () => undefined)
    const handlers = createSettingsHandlers({
      describe: () => ({ routing: {} }), updateRouting,
    }, { list: async () => ({ groups: [], failures: [] }) })
    const request = Object.assign(Readable.from(['{"revision":2,"routing":{"baseModel":{}}}']), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
    }) as unknown as HttpRequest
    const settings = new ResponseCapture()
    const models = new ResponseCapture()
    await handlers.settings(request, settings)
    await handlers.models({ method: 'GET' }, models)
    expect(updateRouting).toHaveBeenCalledWith({ revision: 2, routing: { baseModel: {} } })
    expect(settings.status).toBe(200)
    expect(JSON.parse(String(models.body))).toEqual({ groups: [], failures: [] })
  })
})

describe('Bridge GPT host plugin', () => {
  it('auto-analyzes tool images, attaches context, and bypasses image-free results', async () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`), mediaType: 'image/png' as const,
      bytes: 3, width: 1, height: 1,
    }
    const stream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, index: 0, text: '{"title":"screen","result":"visible login error"}' }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const listeners = new Map<string, unknown>()
    const routes: string[] = []
    const append = vi.spyOn(CallHistory.prototype, 'append').mockResolvedValue()
    const ctx = {
      llm: {
        registerAdapter: () => () => undefined,
        stream,
        listProviders: () => [],
        listModels: async () => [],
      },
      on(event: string, listener: unknown) { listeners.set(event, listener); return () => undefined },
      tools: { register: () => () => undefined },
      attachments: {
        readImage: async () => ({ ref: attachment, data: new Uint8Array([1, 2, 3]) }),
        saveImage: async () => attachment,
      },
      settings: { writable: true, describe: () => [], mutate: async () => undefined },
      webServer: { register(route: { path: string }) { routes.push(route.path); return () => undefined } },
      effect(register: () => unknown) { register(); return () => undefined },
      inject(dependencies: string[], register: (context: Context) => unknown) {
        if (dependencies.includes('webServer')) register(this as unknown as Context)
        return { dispose: () => undefined }
      },
    } as unknown as Context
    apply(ctx, {
      baseModel: { provider: 'base', model: 'chat' },
      imageModel: { provider: 'vision', model: 'see' },
      autoAnalyzeToolImages: true,
    })
    const listener = listeners.get('tools/post-execute') as (
      exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>
    ) => Promise<PostToolDecision>
    const exec = {
      callId: LlmCallId('call'), rootCallId: LlmCallId('call'), name: 'read', arguments: { path: 'screen.png' },
      agent: { id: SessionId('session-a') }, signal: new AbortController().signal, token: Symbol('exec'),
    } as unknown as ToolExecution
    const imageContent: ContentBlock[] = [{ type: 'image', attachment }]
    const imageResult = { isError: false, value: null, content: imageContent } as const
    const decision = await listener(exec, imageResult, async () => ({ kind: 'accept' }))
    expect(decision).toMatchObject({ kind: 'accept', additionalContexts: [
      { source: { kind: 'plugin', plugin: 'bridge-gpt' }, content: [{ text: expect.stringContaining('visible login error') }] },
    ] })
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ origin: 'tool-result', status: 'success' }))
    expect(stream).toHaveBeenCalledOnce()

    const textResult = { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' } as const] } as const
    await expect(listener(exec, textResult, async () => ({ kind: 'accept' }))).resolves.toEqual({ kind: 'accept' })
    expect(stream).toHaveBeenCalledOnce()
    expect(routes).toEqual(['/bridge-gpt/calls', '/bridge-gpt/image', '/bridge-gpt/settings', '/bridge-gpt/models'])
  })
})
