/**
 * The dsh-one bundle row.
 *
 * This is the new base: the domain Engine is the only writer of Tickets, the
 * Effects queue owns everything that happens after a command commits, and the
 * plugin exposes one delegation tool plus one status tool. Later phases add the
 * DSH session adapter, sources, the panel and the assistant conversation.
 */

import z from '@deepseek-ai/schemastery'
import type { DshContextLike, OneConfig } from './types.js'
import { Engine } from './core/engine.js'
import { EffectsQueue } from './app/effects.js'
import { MemoryStore } from './app/store.js'
import { registerOneTools } from './app/tools.js'

/** Cordis plugin name. */
export const name = 'dsh-one'

/** Required services. */
export const inject = ['tools']

/** Core row configuration. */
export const Config: z<OneConfig> = z.object({
  displayName: z.string().min(1).max(24).default('鲸宝')
    .description('User-facing assistant name.'),
  assistantHomeRoot: z.string().default('')
    .description('Root for folders the assistant creates; empty derives <DSH home>/super-mind.'),
  mode: z.union([z.const('observe'), z.const('active')]).default('observe')
    .description('Agent-initiated actions: observe records only; active executes.'),
  allowedWorkspaceRoots: z.array(String).default([])
    .description('Workspace roots the assistant may touch; empty allows all.'),
}) as unknown as z<OneConfig>

/** The services this row provides to the other rows. */
export interface OneServices {
  readonly engine: Engine
  readonly effects: EffectsQueue
  readonly config: OneConfig
}

/** Mount the engine, the effect queue and the model-facing tools. */
export async function apply(ctx: DshContextLike, config: OneConfig): Promise<void> {
  const resolved = Config(config) as OneConfig
  const store = new MemoryStore()
  const engine = new Engine(store.tickets)
  const effects = new EffectsQueue(store.effects)
  const services: OneServices = { engine, effects, config: resolved }
  const provide = ctx.provide?.('oneEngine', services)

  ctx.effect(() => {
    const disposeTools = registerOneTools(ctx, engine)
    return (): void => {
      disposeTools()
      provide?.()
    }
  }, 'dsh-one: domain tools')
}
