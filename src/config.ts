import Schema from '@deepseek-ai/schemastery'

/** Fixed provider route exposed to the model selector. */
export const MIX_PROVIDER = 'bridge-gpt'
/** Fixed model id exposed to the model selector. */
export const MIX_MODEL = 'mix'

/** Reference to one model already registered by the global Models settings. */
export interface ModelRoute {
  provider: string
  model: string
}

/** Bridge routing settings; credentials and transport settings belong to the selected providers. */
export interface Config {
  baseModel?: ModelRoute
  imageModel?: ModelRoute
  intentModel?: ModelRoute
  autoAnalyzeToolImages?: boolean
}

/** Complete routing settings used by the runtime. */
export interface ResolvedConfig {
  baseModel: ModelRoute
  imageModel: ModelRoute
  intentModel?: ModelRoute
  autoAnalyzeToolImages: boolean
}

const ModelRouteSchema: Schema<ModelRoute> = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
}) as Schema<ModelRoute>

const OptionalModelRouteSchema: Schema<ModelRoute> = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
}) as Schema<ModelRoute>

/** Cordis and Web settings schema. */
export const Config: Schema<Config> = Schema.object({
  baseModel: ModelRouteSchema.default({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
  imageModel: ModelRouteSchema.default({ provider: 'codex-local', model: 'gpt-5.6-sol' }),
  intentModel: OptionalModelRouteSchema.default({ provider: '', model: '' }),
  autoAnalyzeToolImages: Schema.boolean().default(true),
}) as Schema<Config>

/** Settings namespace schema; it intentionally contains only model references. */
export const RoutingSettingsSchema = Config

function route(value: ModelRoute, field: string): ModelRoute {
  const provider = value.provider.trim()
  const model = value.model.trim()
  if (provider.length === 0 || model.length === 0) {
    throw new TypeError(`bridge-gpt: ${field} provider and model must be non-empty`)
  }
  if (provider === MIX_PROVIDER) {
    throw new TypeError(`bridge-gpt: ${field} cannot route back to Mix`)
  }
  return { provider, model }
}

/** Validate and materialize model routing once per settings revision. */
export function resolveConfig(input: Config): ResolvedConfig {
  const resolved = Config(input) as Required<Config>
  const intentProvider = resolved.intentModel.provider.trim()
  const intentModel = resolved.intentModel.model.trim()
  if ((intentProvider.length === 0) !== (intentModel.length === 0)) {
    throw new TypeError('bridge-gpt: intentModel provider and model must both be set or both be empty')
  }
  return {
    baseModel: route(resolved.baseModel, 'baseModel'),
    imageModel: route(resolved.imageModel, 'imageModel'),
    ...(intentProvider.length === 0 ? {} : { intentModel: route(resolved.intentModel, 'intentModel') }),
    autoAnalyzeToolImages: resolved.autoAnalyzeToolImages,
  }
}
