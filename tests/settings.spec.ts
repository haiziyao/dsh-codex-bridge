import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { createSettingsController } from '../src/settings.ts'

const ROUTING = resolveConfig({})

describe('Vision Mix settings controller', () => {
  it('returns only model routing and revision metadata', () => {
    const controller = createSettingsController({
      current: () => ROUTING,
      settings: { writable: true, describe: () => [{ ns: 'vision-mix', revision: 4 }], mutate: async () => undefined },
    })
    expect(controller.describe()).toEqual({ available: true, writable: true, revision: 4, routing: ROUTING })
    expect(JSON.stringify(controller.describe())).not.toMatch(/apiKey|baseURL|secret/i)
  })

  it('revision-fences one complete routing update', async () => {
    const mutate = vi.fn(async () => undefined)
    const controller = createSettingsController({
      current: () => ROUTING,
      settings: { writable: true, describe: () => [], mutate },
    })
    const routing = resolveConfig({ imageModel: { provider: 'vision', model: 'new' } })
    await controller.updateRouting({ revision: 2, routing })
    expect(mutate).toHaveBeenCalledWith('vision-mix', [{ op: 'set', path: [], value: routing }], 2)
  })
})
