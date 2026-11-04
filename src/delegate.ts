/**
 * dsh-one delegate row: the durable task runtime. It owns task state, worker
 * sessions, workspace leases, slots, token budgets, reports, recovery, and retry.
 */

import z from '@deepseek-ai/schemastery'
import type { DelegateConfig, DshContextLike, OneConfig } from './types.js'
import { OneCore } from './core/registry.js'
import { defaultCoreConfig } from './core/defaults.js'
import { acquireStore } from './store/index.js'
import { TaskRuntime } from './task/runtime.js'
import { registerTaskTools } from './task/tools.js'

/** Cordis plugin name. */
export const name = 'dsh-one-delegate'

/** Tools are required. `oneCore` is read opportunistically; a missing core row gets a local registry. */
export const inject = ['tools']

/** Delegate row configuration. */
export const Config: z<DelegateConfig> = z.object({
  taskMode: z.union([z.const('observe'), z.const('active')]).default('observe')
    .description('Agent tool path: observe records intended tasks without creating them. /one task is always human.'),
  maxWorkers: z.natural().min(1).max(32).default(4)
    .description('Concurrent worker slots. An additional slot opens while human work is queued or active.'),
  workspaceMode: z.union([z.const('lease'), z.const('shared')]).default('lease')
    .description('lease allows one writing task per canonical workspace; shared disables workspace locking.'),
  leaseTtlMs: z.natural().min(10_000).max(3_600_000).default(120_000)
    .description('Workspace lease lifetime; the heartbeat renews it.'),
  defaultWorkspaceRoot: z.string().default('')
    .description('Workspace for tasks that do not name one. Agent tools fall back to the caller cwd.'),
  workerAgentPreset: z.string().default('')
    .description('Agent preset used to compose worker sessions. Empty uses the default preset.'),
  workerPermissionPreset: z.string().default('')
    .description('Permission preset applied to worker sessions (for example read-only or workspace-write).'),
  workerToolAllow: z.array(String).default([])
    .description('When non-empty, only these global tools stay visible to workers.'),
  workerToolDeny: z.array(String).default(['subagent', 'workflow', 'schedule', 'job'])
    .description('Global tools removed from worker sessions when workerToolAllow is empty.'),
  tokenBudget: z.natural().default(200_000)
    .description('Default per-task token budget. Zero means unlimited. Exceeding it blocks and cancels the task.'),
  retryLimit: z.natural().min(0).max(10).default(3)
    .description('Maximum retry assignments a task may receive.'),
  reportMaxChars: z.natural().min(100).max(100_000).default(4_000)
    .description('Maximum characters retained from one structured report field.'),
  commandTimeoutMs: z.natural().min(1_000).max(600_000).default(60_000)
    .description('Deadline for worker session creation and prompt admission.'),
  defaultTaskPriority: z.natural().default(100)
    .description('Priority assigned when a task names none. Human tasks always sort first.'),
}) as unknown as z<DelegateConfig>

function coreConfig(): OneConfig {
  return defaultCoreConfig()
}

/**
 * Open the shared store, recover interrupted assignments, and register the task surface.
 * @param ctx - Cordis context carrying `tools` and optional host services.
 * @param config - validated delegate configuration.
 */
export async function apply(ctx: DshContextLike, config: DelegateConfig): Promise<void> {
  const resolved = Config(config) as DelegateConfig
  const lease = await acquireStore(ctx, coreConfig())
  const existingCore = ctx.get('oneCore') as OneCore | undefined
  const core = existingCore ?? new OneCore(ctx, coreConfig(), lease.store)
  if (existingCore === undefined) await core.start()
  const runtime = new TaskRuntime(ctx, resolved, lease.store, core)
  await runtime.start()
  const provide = ctx.provide?.('oneTasks', runtime)
  const offEvent = ctx.on?.('session/event', (session: unknown, event: unknown) => {
    runtime.handleSessionEvent(session as { readonly id?: string } | undefined, event)
  })
  ctx.effect(() => {
    const disposeTools = registerTaskTools(ctx, runtime, resolved.commandTimeoutMs)
    const timer = setInterval(() => {
      void runtime.heartbeat()
    }, Math.max(10_000, Math.floor(resolved.leaseTtlMs / 3)))
    ;(timer as { unref?: () => void }).unref?.()
    return (): void => {
      clearInterval(timer)
      disposeTools()
      offEvent?.()
      provide?.()
      void lease.release()
    }
  }, 'dsh-one: task runtime')
}
