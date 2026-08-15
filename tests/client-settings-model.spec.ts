import { describe, expect, it } from 'vitest'
import { parseModelCatalog, parseRouteValue, parseSettingsPayload, routeValue } from '../src/client/settings-model.ts'

describe('client settings model', () => {
  it('accepts model-reference-only settings', () => {
    const payload = {
      available: true, writable: true, revision: 3,
      routing: {
        baseModel: { provider: 'deepseek', model: 'chat' },
        imageModel: { provider: 'vision', model: 'see' },
        autoAnalyzeToolImages: true,
      },
    }
    expect(parseSettingsPayload(payload)).toEqual(payload)
  })

  it('validates model capabilities and selector route values', () => {
    const catalog = parseModelCatalog({
      groups: [{ id: 'vision', name: 'Vision', models: [{ id: 'see', name: 'See', inputModalities: ['text', 'image'] }] }],
      failures: [],
    })
    expect(catalog.groups[0]?.models[0]?.inputModalities).toEqual(['text', 'image'])
    const route = { provider: 'vision', model: 'see' }
    expect(parseRouteValue(routeValue(route))).toEqual(route)
  })

  it('rejects legacy credential/request fields as an invalid payload', () => {
    expect(() => parseSettingsPayload({ available: true, writable: true, revision: 1, vision: {}, credential: {} })).toThrow()
  })
})
