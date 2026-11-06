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
import { AssistantChat } from './chat.js'
import { ToolRegistry } from './tool-registry.js'

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
  readonly toolRegistry: ToolRegistry
  readonly chat: AssistantChat

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
    this.toolRegistry = new ToolRegistry()
    this.chat = new AssistantChat(this)
  }

  async start(): Promise<void> {
    await this.chat.ensureWelcome()
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

  /**
   * Find or create the assistant's own Session. The home directory is created
   * on demand, and a stored id the host no longer lists is replaced rather than
   * returned as a dead conversation.
   */
  async ensureAssistant(): Promise<{ readonly sessionId: string; readonly home: string; readonly created: boolean }> {
    const home = await this.workspace.ensureAssistantHome(this.sessions.assistantHome())
    const stored = this.sessions.assistantSessionId()
    if (stored !== undefined && await this.sessions.exists(stored)) {
      await this.sessions.register(stored, 'router', home, `${this.assistantName()} 助手`)
      return { sessionId: stored, home, created: false }
    }
    const created = await this.sessions.create({
      role: 'router',
      cwd: home,
      title: `${this.assistantName()} 助手`,
    })
    await this.sessions.setAssistantSessionId(created.sessionId)
    await this.sessions.setAssistantHome(home)
    return { sessionId: created.sessionId, home, created: true }
  }
}

export async function createRuntime(ctx: DshContextLike, config: OneConfig): Promise<OneRuntime> {
  const store = await acquireStore(ctx)
  const runtime = new OneRuntime(ctx, config, store)
  await runtime.start()
  return runtime
}
