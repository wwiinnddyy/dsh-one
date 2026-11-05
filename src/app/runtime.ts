/**
 * The composition root.
 *
 * Builds the store, the domain Engine, the Effects queue and the adapters in one
 * place. Everything below receives a narrow interface; nothing here contains a
 * business rule.
 */

import type { DshContextLike, OneConfig } from '../types.js'
import { Engine } from '../core/engine.js'
import { acquireStore, type Store } from './store.js'
import { EffectsQueue } from './effects.js'
import { Executor } from './executor.js'
import { SessionService } from './sessions.js'
import { SettingsService } from './settings.js'
import { WorkspaceService } from './workspace.js'

export class OneRuntime {
  readonly ctx: DshContextLike
  readonly config: OneConfig
  readonly store: Store
  readonly engine: Engine
  readonly effects: EffectsQueue
  readonly sessions: SessionService
  readonly workspace: WorkspaceService
  readonly settings: SettingsService
  readonly executor: Executor

  constructor(ctx: DshContextLike, config: OneConfig, store: Store) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.engine = new Engine(store, store)
    this.effects = new EffectsQueue(store)
    this.sessions = new SessionService(ctx, store, config)
    this.workspace = new WorkspaceService(ctx, config)
    this.settings = new SettingsService(store, config)
    this.executor = new Executor(ctx, config, store, this.engine, this.effects, this.sessions)
  }

  async start(): Promise<void> {
    await this.executor.start()
  }

  dispose(): void {
    this.executor.dispose()
  }

  assistantName(): string {
    return this.settings.displayName()
  }

  assistantSessionId(): string | undefined {
    return this.sessions.assistantSessionId()
  }
}

export async function createRuntime(ctx: DshContextLike, config: OneConfig): Promise<OneRuntime> {
  const store = await acquireStore(ctx)
  const runtime = new OneRuntime(ctx, config, store)
  await runtime.start()
  return runtime
}
