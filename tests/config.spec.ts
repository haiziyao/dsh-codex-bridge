import { describe, expect, it } from 'vitest'
import { MIX_MODEL, MIX_PROVIDER, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('materializes the fixed Mix routing defaults', () => {
    expect(MIX_PROVIDER).toBe('vision-mix')
    expect(MIX_MODEL).toBe('mix')
    expect(resolveConfig({})).toEqual({
      baseModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      autoAnalyzeToolImages: true,
      generationDefaults: { size: 'auto', quality: 'auto', outputFormat: 'png' },
    })
  })

  it('accepts three globally configured model references', () => {
    expect(resolveConfig({
      baseModel: { provider: 'base', model: 'chat' },
      imageModel: { provider: 'vision', model: 'see' },
      intentModel: { provider: 'intent', model: 'small' },
      autoAnalyzeToolImages: false,
      generationDefaults: { size: 'auto', quality: 'auto', outputFormat: 'png' },
    })).toEqual({
      baseModel: { provider: 'base', model: 'chat' },
      imageModel: { provider: 'vision', model: 'see' },
      intentModel: { provider: 'intent', model: 'small' },
      autoAnalyzeToolImages: false,
      generationDefaults: { size: 'auto', quality: 'auto', outputFormat: 'png' },
    })
  })

  it('rejects internal routes that would recurse into Mix', () => {
    expect(() => resolveConfig({ baseModel: { provider: 'vision-mix', model: 'mix' } })).toThrow(/cannot route back/)
    expect(() => resolveConfig({ intentModel: { provider: 'intent', model: '' } })).toThrow(/both be set/)
    expect(() => resolveConfig({ imageModel: { provider: 'vision', model: '' } })).toThrow(/both be set/)
    expect(() => resolveConfig({ generationModel: { provider: 'openai', model: '' } })).toThrow(/both be set/)
  })

  it('resolves the independent image generation route and defaults', () => {
    expect(resolveConfig({
      generationModel: { provider: 'openai', model: 'gpt-image-2' },
      generationDefaults: { size: '1536x1024', quality: 'high', outputFormat: 'webp' },
    })).toMatchObject({
      generationModel: { provider: 'openai', model: 'gpt-image-2' },
      generationDefaults: { size: '1536x1024', quality: 'high', outputFormat: 'webp' },
    })
  })
})
