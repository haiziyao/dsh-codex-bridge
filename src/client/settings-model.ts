import type {
  ImageGenerationQuality, ImageGenerationSize, ImageOutputFormat, ModelRoute, ResolvedConfig,
} from '../config.ts'

/** Settings response rendered by the browser. */
export interface VisionMixSettingsPayload {
  available: boolean
  writable: boolean
  revision: number
  routing: ResolvedConfig
}

/** One model choice sourced from the live global model registry. */
export interface SelectableModelView {
  id: string
  name: string
  description?: string
  inputModalities?: string[]
}

/** One configured provider group rendered in model selectors. */
export interface SelectableModelGroupView {
  id: string
  name: string
  models: SelectableModelView[]
}

/** Configured-model catalog response rendered by the browser. */
export interface ModelCatalogPayload {
  groups: SelectableModelGroupView[]
  generationProviders: Array<{ id: string; name: string }>
  failures: Array<{ provider: string; error: string }>
}

/** Result of one Host-side image-model onboarding action. */
export interface VisionSetupPayload {
  action: 'test' | 'enable' | 'auto'
  route: ModelRoute
  imageEnabled: boolean
  selected: boolean
  message: string
  response?: string
}

/** Result of one independently routed Images API test. */
export interface GenerationSetupPayload {
  route: ModelRoute
  message: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: number
  previewDataUrl?: string
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`vision-mix: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`vision-mix: ${where} must be non-empty text`)
  return value
}

function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`vision-mix: ${where} is invalid`)
  return value as number
}

function route(value: unknown, where: string): ModelRoute {
  const item = object(value, where)
  return { provider: text(item.provider, `${where}.provider`), model: text(item.model, `${where}.model`) }
}

function imageSize(value: unknown): ImageGenerationSize {
  if (value === 'auto' || value === '1024x1024' || value === '1536x1024' || value === '1024x1536') return value
  throw new TypeError('vision-mix: routing.generationDefaults.size is invalid')
}

function imageQuality(value: unknown): ImageGenerationQuality {
  if (value === 'auto' || value === 'low' || value === 'medium' || value === 'high') return value
  throw new TypeError('vision-mix: routing.generationDefaults.quality is invalid')
}

function outputFormat(value: unknown): ImageOutputFormat {
  if (value === 'png' || value === 'jpeg' || value === 'webp') return value
  throw new TypeError('vision-mix: routing.generationDefaults.outputFormat is invalid')
}

/** Validate a Host routing response before rendering it. */
export function parseSettingsPayload(value: unknown): VisionMixSettingsPayload {
  const root = object(value, 'settings response')
  const routing = object(root.routing, 'routing')
  const generationDefaults = object(routing.generationDefaults, 'routing.generationDefaults')
  if (typeof root.available !== 'boolean' || typeof root.writable !== 'boolean'
    || typeof routing.autoAnalyzeToolImages !== 'boolean') {
    throw new TypeError('vision-mix: settings response has invalid boolean fields')
  }
  return {
    available: root.available,
    writable: root.writable,
    revision: integer(root.revision, 'revision'),
    routing: {
      baseModel: route(routing.baseModel, 'routing.baseModel'),
      ...(routing.imageModel === undefined ? {} : { imageModel: route(routing.imageModel, 'routing.imageModel') }),
      ...(routing.intentModel === undefined ? {} : { intentModel: route(routing.intentModel, 'routing.intentModel') }),
      autoAnalyzeToolImages: routing.autoAnalyzeToolImages,
      ...(routing.generationModel === undefined ? {} : { generationModel: route(routing.generationModel, 'routing.generationModel') }),
      generationDefaults: {
        size: imageSize(generationDefaults.size),
        quality: imageQuality(generationDefaults.quality),
        outputFormat: outputFormat(generationDefaults.outputFormat),
      },
    },
  }
}

/** Validate the configured-model catalog before using it as selector options. */
export function parseModelCatalog(value: unknown): ModelCatalogPayload {
  const root = object(value, 'models response')
  if (!Array.isArray(root.groups) || !Array.isArray(root.generationProviders) || !Array.isArray(root.failures)) {
    throw new TypeError('vision-mix: models response arrays are invalid')
  }
  return {
    groups: root.groups.map((entry, groupIndex) => {
      const group = object(entry, `groups[${groupIndex}]`)
      if (!Array.isArray(group.models)) throw new TypeError(`vision-mix: groups[${groupIndex}].models is invalid`)
      return {
        id: text(group.id, `groups[${groupIndex}].id`),
        name: text(group.name, `groups[${groupIndex}].name`),
        models: group.models.map((entryModel, modelIndex) => {
          const model = object(entryModel, `groups[${groupIndex}].models[${modelIndex}]`)
          const modalities = model.inputModalities
          if (modalities !== undefined && (!Array.isArray(modalities) || modalities.some(item => typeof item !== 'string'))) {
            throw new TypeError(`vision-mix: groups[${groupIndex}].models[${modelIndex}].inputModalities is invalid`)
          }
          return {
            id: text(model.id, `groups[${groupIndex}].models[${modelIndex}].id`),
            name: text(model.name, `groups[${groupIndex}].models[${modelIndex}].name`),
            ...(model.description === undefined ? {} : { description: text(model.description, 'model.description') }),
            ...(modalities === undefined ? {} : { inputModalities: modalities as string[] }),
          }
        }),
      }
    }),
    generationProviders: root.generationProviders.map((entry, index) => {
      const provider = object(entry, `generationProviders[${index}]`)
      return { id: text(provider.id, `generationProviders[${index}].id`), name: text(provider.name, `generationProviders[${index}].name`) }
    }),
    failures: root.failures.map((entry, index) => {
      const failure = object(entry, `failures[${index}]`)
      return { provider: text(failure.provider, `failures[${index}].provider`), error: text(failure.error, `failures[${index}].error`) }
    }),
  }
}

/** Stable selector value for one provider/model pair. */
export function routeValue(route: ModelRoute): string {
  return JSON.stringify([route.provider, route.model])
}

/** Decode a selector value into one provider/model pair. */
export function parseRouteValue(value: string): ModelRoute {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new TypeError('vision-mix: model selection is invalid')
  return { provider: text(parsed[0], 'selection.provider'), model: text(parsed[1], 'selection.model') }
}

/** Validate the image-model setup result before showing or applying it. */
export function parseVisionSetupPayload(value: unknown): VisionSetupPayload {
  const item = object(value, 'vision setup response')
  const action = item.action === 'test' || item.action === 'enable' || item.action === 'auto'
    ? item.action
    : (() => { throw new TypeError('vision-mix: vision setup action is invalid') })()
  if (typeof item.imageEnabled !== 'boolean' || typeof item.selected !== 'boolean') {
    throw new TypeError('vision-mix: vision setup result flags are invalid')
  }
  return {
    action,
    route: route(item.route, 'vision setup route'),
    imageEnabled: item.imageEnabled,
    selected: item.selected,
    message: text(item.message, 'vision setup message'),
    ...(item.response === undefined ? {} : { response: text(item.response, 'vision setup model response') }),
  }
}

/** Validate a generated test image and its optional same-origin preview payload. */
export function parseGenerationSetupPayload(value: unknown): GenerationSetupPayload {
  const item = object(value, 'generation setup response')
  const mediaType = item.mediaType === 'image/png' || item.mediaType === 'image/jpeg' || item.mediaType === 'image/webp'
    ? item.mediaType
    : (() => { throw new TypeError('vision-mix: generation setup media type is invalid') })()
  const previewDataUrl = item.previewDataUrl
  if (previewDataUrl !== undefined && (typeof previewDataUrl !== 'string' || !previewDataUrl.startsWith(`data:${mediaType};base64,`))) {
    throw new TypeError('vision-mix: generation setup preview is invalid')
  }
  return {
    route: route(item.route, 'generation setup route'),
    message: text(item.message, 'generation setup message'),
    mediaType,
    bytes: integer(item.bytes, 'generation setup bytes'),
    ...(previewDataUrl === undefined ? {} : { previewDataUrl }),
  }
}
