import { describe, expect, it } from 'vitest'
import {
  parseGenerationSetupPayload, parseModelCatalog, parseRouteValue, parseSettingsPayload,
  parseVisionSetupPayload, routeValue,
} from '../src/client/settings-model.ts'

describe('client settings model', () => {
  it('accepts model-reference-only settings', () => {
    const payload = {
      available: true, writable: true, revision: 3,
      routing: {
        baseModel: { provider: 'deepseek', model: 'chat' },
        imageModel: { provider: 'vision', model: 'see' },
        autoAnalyzeToolImages: true,
        generationModel: { provider: 'openai', model: 'gpt-image-2' },
        generationDefaults: { size: 'auto', quality: 'high', outputFormat: 'png' },
      },
    }
    expect(parseSettingsPayload(payload)).toEqual(payload)
  })

  it('validates model capabilities and selector route values', () => {
    const catalog = parseModelCatalog({
      groups: [{ id: 'vision', name: 'Vision', models: [{ id: 'see', name: 'See', inputModalities: ['text', 'image'] }] }],
      generationProviders: [{ id: 'openai', name: 'OpenAI' }],
      failures: [],
    })
    expect(catalog.groups[0]?.models[0]?.inputModalities).toEqual(['text', 'image'])
    expect(catalog.generationProviders).toEqual([{ id: 'openai', name: 'OpenAI' }])
    const route = { provider: 'vision', model: 'see' }
    expect(parseRouteValue(routeValue(route))).toEqual(route)
  })

  it('rejects legacy credential/request fields as an invalid payload', () => {
    expect(() => parseSettingsPayload({ available: true, writable: true, revision: 1, vision: {}, credential: {} })).toThrow()
  })

  it('validates vision and independently routed generation setup results', () => {
    expect(parseVisionSetupPayload({
      action: 'auto', route: { provider: 'relay', model: 'vision' }, imageEnabled: true,
      selected: false, message: 'ok', response: 'red',
    })).toMatchObject({ action: 'auto', selected: false, response: 'red' })
    expect(parseGenerationSetupPayload({
      route: { provider: 'images', model: 'gpt-image-2' }, message: 'ok',
      mediaType: 'image/png', bytes: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })).toMatchObject({ route: { provider: 'images', model: 'gpt-image-2' }, previewDataUrl: 'data:image/png;base64,AQID' })
  })
})
