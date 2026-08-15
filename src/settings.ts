import { settingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'

/** Persistent settings namespace owned by this plugin. */
export const BRIDGE_GPT_SETTINGS_NAMESPACE = settingsNamespace('bridge-gpt')

interface SettingsDescriptorLike {
  ns: string
  revision: number
}

interface SettingsAccess {
  readonly writable: boolean
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** Routing configuration returned to the browser settings page. */
export interface BridgeSettingsView {
  available: boolean
  writable: boolean
  revision: number
  routing: ResolvedConfig
}

/** One revision-fenced Web routing update. */
export interface RoutingSettingsUpdate {
  revision: number
  routing: Config
}

/** Host services used by the Web settings controller. */
export interface SettingsControllerDependencies {
  current(): ResolvedConfig
  settings: SettingsAccess
}

/** Build the model-reference-only settings operations used by the HTTP route. */
export function createSettingsController(dependencies: SettingsControllerDependencies) {
  return {
    describe(): BridgeSettingsView {
      const descriptor = dependencies.settings.describe({ redactSecrets: true })
        .find(item => item.ns === BRIDGE_GPT_SETTINGS_NAMESPACE)
      return {
        available: descriptor !== undefined,
        writable: dependencies.settings.writable,
        revision: descriptor?.revision ?? 0,
        routing: dependencies.current(),
      }
    },

    async updateRouting(input: RoutingSettingsUpdate): Promise<void> {
      if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
        throw new TypeError('bridge-gpt: settings revision must be a non-negative safe integer')
      }
      const routing = resolveConfig(input.routing)
      await dependencies.settings.mutate(BRIDGE_GPT_SETTINGS_NAMESPACE, [{
        op: 'set',
        path: [],
        value: routing,
      }], input.revision)
    },
  }
}
