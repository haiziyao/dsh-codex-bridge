import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAiImageBackend } from '../src/openai-image-backend.ts'

function context(profile: Record<string, unknown>, credential = 'sk-test'): Context {
  return {
    llm: {
      listConfigurableProviders: () => [{
        provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
      }],
    },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { openai: profile } } }],
    },
    get(name: string) {
      if (name !== 'credentials') return undefined
      return { resolve: async () => ({ value: credential, source: 'test' }) }
    },
  } as unknown as Context
}

const request = {
  prompt: 'a bridge over a calm river',
  size: '1024x1024' as const,
  quality: 'high' as const,
  outputFormat: 'png' as const,
}

describe('OpenAiImageBackend', () => {
  it('completes a generation request against a real local HTTP endpoint', async () => {
    let received: { url?: string; authorization?: string; body?: unknown } = {}
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => { chunks.push(chunk as Buffer) })
      request.on('end', () => {
        received = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ b64_json: 'AQID' }] }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const { port } = server.address() as AddressInfo
      const backend = new OpenAiImageBackend(context({
        apiKeyEnv: 'OPENAI_API_KEY', baseURL: `http://127.0.0.1:${port}/v1`,
      }), { provider: 'openai', model: 'gpt-image-2' })
      await expect(backend.generate(request)).resolves.toMatchObject({ mediaType: 'image/png' })
      expect(received).toEqual({
        url: '/v1/images/generations', authorization: 'Bearer sk-test',
        body: { model: 'gpt-image-2', prompt: request.prompt, size: '1024x1024', quality: 'high', output_format: 'png' },
      })
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) resolve(); else reject(error) }) })
    }
  })

  it('calls the generations endpoint with the configured credential and provider headers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const backend = new OpenAiImageBackend(context({
      apiKeyEnv: 'OPENAI_API_KEY', headers: { 'x-tenant': 'demo' },
    }), { provider: 'openai', model: 'gpt-image-2' }, fetcher as typeof fetch)

    await expect(backend.generate(request)).resolves.toEqual({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-test', 'content-type': 'application/json', 'x-tenant': 'demo' })
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-2', prompt: request.prompt, size: '1024x1024', quality: 'high', output_format: 'png',
    })
  })

  it('sends source images as multipart data without unsupported fidelity fields', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'BAUG' }] }), { status: 200 }))
    const backend = new OpenAiImageBackend(context({
      apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'http://127.0.0.1:9999/v1/',
    }), { provider: 'openai', model: 'gpt-image-2' }, fetcher as typeof fetch)
    const ref = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const,
      bytes: 3, width: 1, height: 1, name: 'source.png',
    }

    await expect(backend.edit({ ...request, images: [{ ref, data: new Uint8Array([1, 2, 3]) }] })).resolves.toEqual({
      data: new Uint8Array([4, 5, 6]), mediaType: 'image/png',
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:9999/v1/images/edits')
    const body = init.body as FormData
    expect(body.get('model')).toBe('gpt-image-2')
    expect(body.get('prompt')).toBe(request.prompt)
    expect(body.get('input_fidelity')).toBeNull()
    expect(body.getAll('image[]')).toHaveLength(1)
    expect((body.get('image[]') as File).name).toBe('source.png')
  })

  it('reports API errors and malformed image data', async () => {
    const unauthorized = new OpenAiImageBackend(context({ apiKeyEnv: 'OPENAI_API_KEY' }),
      { provider: 'openai', model: 'gpt-image-2' }, async () => new Response('denied', { status: 401 }))
    await expect(unauthorized.generate(request)).rejects.toThrow(/HTTP 401: denied/)

    const malformed = new OpenAiImageBackend(context({ apiKeyEnv: 'OPENAI_API_KEY' }),
      { provider: 'openai', model: 'gpt-image-2' }, async () => new Response(JSON.stringify({ data: [{ b64_json: '***' }] })))
    await expect(malformed.generate(request)).rejects.toThrow(/invalid base64/)
  })

  it('passes the caller abort signal to fetch', async () => {
    const signal = new AbortController().signal
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(signal)
      throw new DOMException('aborted', 'AbortError')
    })
    const backend = new OpenAiImageBackend(context({ apiKeyEnv: 'OPENAI_API_KEY' }),
      { provider: 'openai', model: 'gpt-image-2' }, fetcher as typeof fetch)
    await expect(backend.generate({ ...request, signal })).rejects.toThrow(/aborted/)
  })
})
