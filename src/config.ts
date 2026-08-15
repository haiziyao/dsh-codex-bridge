import Schema from '@deepseek-ai/schemastery'

/** Fixed provider route exposed to the model selector. */
export const MIX_PROVIDER = 'vision-mix'
/** Fixed model id exposed to the model selector. */
export const MIX_MODEL = 'mix'

/** Reference to one model already registered by the global Models settings. */
export interface ModelRoute {
  provider: string
  model: string
}

/** Output dimensions supported by the first OpenAI image backend. */
export type ImageGenerationSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536'

/** Image quality sent to the generation backend. */
export type ImageGenerationQuality = 'auto' | 'low' | 'medium' | 'high'

/** Stored image encoding requested from the generation backend. */
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp'

/** Defaults shared by image generation and image editing tools. */
export interface ImageGenerationDefaults {
  size?: ImageGenerationSize
  quality?: ImageGenerationQuality
  outputFormat?: ImageOutputFormat
}

/** Mix routing settings; credentials and transport settings belong to the selected providers. */
export interface Config {
  baseModel?: ModelRoute
  imageModel?: ModelRoute
  intentModel?: ModelRoute
  autoAnalyzeToolImages?: boolean
  generationModel?: ModelRoute
  generationDefaults?: ImageGenerationDefaults
}

/** Complete routing settings used by the runtime. */
export interface ResolvedConfig {
  baseModel: ModelRoute
  imageModel?: ModelRoute
  intentModel?: ModelRoute
  autoAnalyzeToolImages: boolean
  generationModel?: ModelRoute
  generationDefaults: Required<ImageGenerationDefaults>
}

const ModelRouteSchema: Schema<ModelRoute> = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
}) as Schema<ModelRoute>

const OptionalModelRouteSchema: Schema<ModelRoute> = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
}) as Schema<ModelRoute>

const ImageGenerationDefaultsSchema: Schema<ImageGenerationDefaults> = Schema.object({
  size: Schema.union(['auto', '1024x1024', '1536x1024', '1024x1536']).default('auto'),
  quality: Schema.union(['auto', 'low', 'medium', 'high']).default('auto'),
  outputFormat: Schema.union(['png', 'jpeg', 'webp']).default('png'),
}) as Schema<ImageGenerationDefaults>

/** Cordis and Web settings schema. */
export const Config: Schema<Config> = Schema.object({
  baseModel: ModelRouteSchema.default({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
  imageModel: OptionalModelRouteSchema.default({ provider: '', model: '' }),
  intentModel: OptionalModelRouteSchema.default({ provider: '', model: '' }),
  autoAnalyzeToolImages: Schema.boolean().default(true),
  generationModel: OptionalModelRouteSchema.default({ provider: '', model: '' }),
  generationDefaults: ImageGenerationDefaultsSchema.default({
    size: 'auto', quality: 'auto', outputFormat: 'png',
  }),
}) as Schema<Config>

/** Settings namespace schema; it intentionally contains only model references. */
export const RoutingSettingsSchema = Config

function route(value: ModelRoute, field: string): ModelRoute {
  const provider = value.provider.trim()
  const model = value.model.trim()
  if (provider.length === 0 || model.length === 0) {
    throw new TypeError(`vision-mix: ${field} provider and model must be non-empty`)
  }
  if (provider === MIX_PROVIDER) {
    throw new TypeError(`vision-mix: ${field} cannot route back to Mix`)
  }
  return { provider, model }
}

/** Validate and materialize model routing once per settings revision. */
export function resolveConfig(input: Config): ResolvedConfig {
  const resolved = Config(input) as Required<Config>
  const intentProvider = resolved.intentModel.provider.trim()
  const intentModel = resolved.intentModel.model.trim()
  if ((intentProvider.length === 0) !== (intentModel.length === 0)) {
    throw new TypeError('vision-mix: intentModel provider and model must both be set or both be empty')
  }
  const imageProvider = resolved.imageModel.provider.trim()
  const imageModel = resolved.imageModel.model.trim()
  if ((imageProvider.length === 0) !== (imageModel.length === 0)) {
    throw new TypeError('vision-mix: imageModel provider and model must both be set or both be empty')
  }
  const generationProvider = resolved.generationModel.provider.trim()
  const generationModel = resolved.generationModel.model.trim()
  if ((generationProvider.length === 0) !== (generationModel.length === 0)) {
    throw new TypeError('vision-mix: generationModel provider and model must both be set or both be empty')
  }
  return {
    baseModel: route(resolved.baseModel, 'baseModel'),
    ...(imageProvider.length === 0 ? {} : { imageModel: route(resolved.imageModel, 'imageModel') }),
    ...(intentProvider.length === 0 ? {} : { intentModel: route(resolved.intentModel, 'intentModel') }),
    autoAnalyzeToolImages: resolved.autoAnalyzeToolImages,
    ...(generationProvider.length === 0
      ? {}
      : { generationModel: route(resolved.generationModel, 'generationModel') }),
    generationDefaults: {
      size: resolved.generationDefaults.size ?? 'auto',
      quality: resolved.generationDefaults.quality ?? 'auto',
      outputFormat: resolved.generationDefaults.outputFormat ?? 'png',
    },
  }
}
