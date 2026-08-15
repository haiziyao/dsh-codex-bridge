import { describe, expect, it } from 'vitest'
import { MIX_MODEL, MIX_PROVIDER, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('materializes the fixed Mix routing defaults', () => {
    expect(MIX_PROVIDER).toBe('bridge-gpt')
    expect(MIX_MODEL).toBe('mix')
    expect(resolveConfig({})).toEqual({
      baseModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      imageModel: { provider: 'codex-local', model: 'gpt-5.6-sol' },
      autoAnalyzeToolImages: true,
    })
  })

  it('accepts three globally configured model references', () => {
    expect(resolveConfig({
      baseModel: { provider: 'base', model: 'chat' },
      imageModel: { provider: 'vision', model: 'see' },
      intentModel: { provider: 'intent', model: 'small' },
      autoAnalyzeToolImages: false,
    })).toEqual({
      baseModel: { provider: 'base', model: 'chat' },
      imageModel: { provider: 'vision', model: 'see' },
      intentModel: { provider: 'intent', model: 'small' },
      autoAnalyzeToolImages: false,
    })
  })

  it('rejects internal routes that would recurse into Mix', () => {
    expect(() => resolveConfig({ baseModel: { provider: 'bridge-gpt', model: 'mix' } })).toThrow(/cannot route back/)
    expect(() => resolveConfig({ intentModel: { provider: 'intent', model: '' } })).toThrow(/both be set/)
  })
})
