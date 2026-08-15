import type { ModelRoute, ResolvedConfig } from '../config.ts'

/** Settings response rendered by the browser. */
export interface BridgeSettingsPayload {
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
  failures: Array<{ provider: string; error: string }>
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`bridge-gpt: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`bridge-gpt: ${where} must be non-empty text`)
  return value
}

function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`bridge-gpt: ${where} is invalid`)
  return value as number
}

function route(value: unknown, where: string): ModelRoute {
  const item = object(value, where)
  return { provider: text(item.provider, `${where}.provider`), model: text(item.model, `${where}.model`) }
}

/** Validate a Host routing response before rendering it. */
export function parseSettingsPayload(value: unknown): BridgeSettingsPayload {
  const root = object(value, 'settings response')
  const routing = object(root.routing, 'routing')
  if (typeof root.available !== 'boolean' || typeof root.writable !== 'boolean'
    || typeof routing.autoAnalyzeToolImages !== 'boolean') {
    throw new TypeError('bridge-gpt: settings response has invalid boolean fields')
  }
  return {
    available: root.available,
    writable: root.writable,
    revision: integer(root.revision, 'revision'),
    routing: {
      baseModel: route(routing.baseModel, 'routing.baseModel'),
      imageModel: route(routing.imageModel, 'routing.imageModel'),
      ...(routing.intentModel === undefined ? {} : { intentModel: route(routing.intentModel, 'routing.intentModel') }),
      autoAnalyzeToolImages: routing.autoAnalyzeToolImages,
    },
  }
}

/** Validate the configured-model catalog before using it as selector options. */
export function parseModelCatalog(value: unknown): ModelCatalogPayload {
  const root = object(value, 'models response')
  if (!Array.isArray(root.groups) || !Array.isArray(root.failures)) {
    throw new TypeError('bridge-gpt: models response arrays are invalid')
  }
  return {
    groups: root.groups.map((entry, groupIndex) => {
      const group = object(entry, `groups[${groupIndex}]`)
      if (!Array.isArray(group.models)) throw new TypeError(`bridge-gpt: groups[${groupIndex}].models is invalid`)
      return {
        id: text(group.id, `groups[${groupIndex}].id`),
        name: text(group.name, `groups[${groupIndex}].name`),
        models: group.models.map((entryModel, modelIndex) => {
          const model = object(entryModel, `groups[${groupIndex}].models[${modelIndex}]`)
          const modalities = model.inputModalities
          if (modalities !== undefined && (!Array.isArray(modalities) || modalities.some(item => typeof item !== 'string'))) {
            throw new TypeError(`bridge-gpt: groups[${groupIndex}].models[${modelIndex}].inputModalities is invalid`)
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
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new TypeError('bridge-gpt: model selection is invalid')
  return { provider: text(parsed[0], 'selection.provider'), model: text(parsed[1], 'selection.model') }
}
