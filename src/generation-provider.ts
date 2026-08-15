import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'

/** Resolved OpenAI-compatible transport facts for one configured provider route. */
export interface ImageProviderConnection {
  baseURL: string
  apiKey: string
  headers: Record<string, string>
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`vision-mix: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function profileAt(value: unknown, path: readonly string[], provider: string): Record<string, unknown> {
  let current = value
  for (const segment of path) current = record(current, `settings for provider "${provider}"`)[segment]
  return record(current, `profile for provider "${provider}"`)
}

function headers(value: unknown, provider: string): Record<string, string> {
  if (value === undefined) return {}
  const source = record(value, `headers for provider "${provider}"`)
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(source)) {
    if (typeof entry !== 'string') throw new TypeError(`vision-mix: header "${name}" for provider "${provider}" must be text`)
    result[name] = entry
  }
  return result
}

/** Resolve endpoint and credential from the provider selected in DSH Models settings. */
export async function resolveImageProvider(ctx: Context, provider: string): Promise<ImageProviderConnection> {
  const directory = ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
  if (directory === undefined) {
    throw new Error(`vision-mix: image generation provider "${provider}" is not managed by DSH Models settings`)
  }
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === directory.settingsNs)
  if (descriptor === undefined) {
    throw new Error(`vision-mix: settings namespace "${directory.settingsNs}" for provider "${provider}" is unavailable`)
  }
  const profile = profileAt(descriptor.value, directory.settingsPath, provider)
  const rawRef = profile.apiKeyEnv
  if (typeof rawRef !== 'string' || rawRef.length === 0) {
    throw new Error(`vision-mix: provider "${provider}" does not name a credential in Models settings`)
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error('vision-mix: the DSH credentials service is unavailable')
  }
  const resolved = await credentials.resolve(credentialRef(rawRef))
  if (resolved === undefined || resolved.value.length === 0) {
    throw new Error(`vision-mix: credential "${rawRef}" for provider "${provider}" is not configured`)
  }
  const rawBaseURL = profile.baseURL
  const baseURL = typeof rawBaseURL === 'string' && rawBaseURL.length > 0
    ? rawBaseURL
    : provider === 'openai'
      ? 'https://api.openai.com/v1'
      : undefined
  if (baseURL === undefined) {
    throw new Error(`vision-mix: provider "${provider}" must configure a Base URL for image generation`)
  }
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch (error: unknown) {
    throw new TypeError(`vision-mix: provider "${provider}" has an invalid Base URL`, { cause: error })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`vision-mix: provider "${provider}" Base URL must use HTTP or HTTPS`)
  }
  return { baseURL: parsed.toString().replace(/\/$/, ''), apiKey: resolved.value, headers: headers(profile.headers, provider) }
}
