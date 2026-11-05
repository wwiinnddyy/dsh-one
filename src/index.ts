/**
 * The dsh-one bundle row.
 *
 * Composition only: build the runtime, register the tools, and forward DSH
 * session events to the Executor. Every rule lives in `core/` or `app/`.
 */

import z from '@deepseek-ai/schemastery'
import type { DshContextLike, OneConfig } from './types.js'
import { createRuntime, type OneRuntime } from './app/runtime.js'
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
  maxWorkers: z.natural().min(1).max(32).default(4)
    .description('Concurrent worker assignments.'),
  commandTimeoutMs: z.natural().min(1_000).max(600_000).default(30_000)
    .description('Deadline for one session operation.'),
}) as unknown as z<OneConfig>

/** The services this row provides to other rows. */
export interface OneServices {
  readonly runtime: OneRuntime
  readonly config: OneConfig
}

/** Mount the runtime, the effect loop and the model-facing tools. */
export async function apply(ctx: DshContextLike, config: OneConfig): Promise<void> {
  const resolved = Config(config) as OneConfig
  const runtime = await createRuntime(ctx, resolved)
  const services: OneServices = { runtime, config: resolved }
  const provide = ctx.provide?.('oneEngine', services)
  const offEvent = ctx.on?.('session/event', (session: unknown, event: unknown) => {
    runtime.executor.handleSessionEvent(session as { readonly id?: string } | undefined, event)
  })

  ctx.effect(() => {
    const disposeTools = registerOneTools(ctx, runtime)
    return (): void => {
      disposeTools()
      offEvent?.()
      provide?.()
      runtime.dispose()
    }
  }, 'dsh-one: runtime')
}
