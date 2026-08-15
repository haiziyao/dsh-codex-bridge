import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testGenerationRoute } from '../src/generation-setup.ts'

afterEach(() => { vi.unstubAllGlobals() })

function context(fetcher: ReturnType<typeof vi.fn>): Context {
  vi.stubGlobal('fetch', fetcher)
  return {
    llm: {
      listConfigurableProviders: () => [{
        provider: 'images-relay', displayName: 'Images Relay', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'images-relay'],
      }],
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai', value: { providers: { 'images-relay': {
          apiKeyEnv: 'IMAGES_RELAY_KEY', baseURL: 'https://images.example/v1',
        } } },
      }],
    },
    get(name: string) {
      return name === 'credentials' ? { resolve: async () => ({ value: 'sk-images', source: 'test' }) } : undefined
    },
    attachments: {
      validateImage: async () => undefined,
    },
  } as unknown as Context
}

describe('generation API setup test', () => {
  it('uses an independent Provider and returns a validated preview', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), { status: 200 }))
    const result = await testGenerationRoute(context(fetcher), { provider: 'images-relay', model: 'gpt-image-2' })
    expect(result).toMatchObject({
      route: { provider: 'images-relay', model: 'gpt-image-2' },
      mediaType: 'image/png', bytes: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({ model: 'gpt-image-2', size: '1024x1024', quality: 'low', output_format: 'png' })
  })
})
