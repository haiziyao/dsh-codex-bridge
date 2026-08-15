import type { Context } from '@deepseek-ai/cordis'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { MIX_PROVIDER } from './config.ts'

/** One configured model selectable by Bridge GPT. */
export interface SelectableModel {
  id: string
  name: string
  description?: string
  inputModalities?: readonly ModelModality[]
}

/** One live configured provider and its catalog models. */
export interface SelectableModelGroup {
  id: string
  name: string
  models: SelectableModel[]
}

/** Browser payload sourced from the same live registry as the global Models page. */
export interface ModelCatalogView {
  groups: SelectableModelGroup[]
  failures: Array<{ provider: string; error: string }>
}

/** List live configured models while excluding the virtual Mix route to prevent recursion. */
export async function listSelectableModels(ctx: Context): Promise<ModelCatalogView> {
  const groups: SelectableModelGroup[] = []
  const failures: ModelCatalogView['failures'] = []
  for (const provider of ctx.llm.listProviders()) {
    if (provider.id === MIX_PROVIDER) continue
    try {
      const models = await ctx.llm.listModels(provider.id)
      groups.push({
        id: provider.id,
        name: provider.name,
        models: models.map(model => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
        })),
      })
    } catch (error: unknown) {
      failures.push({ provider: provider.id, error: String(error) })
    }
  }
  return { groups, failures }
}
