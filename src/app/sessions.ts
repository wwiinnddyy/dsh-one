/**
 * The DSH Session adapter.
 *
 * The Router and the Executor are both ordinary DSH sessions; this module is
 * the only place that creates them, prompts them, and records which role each
 * one plays. It never decides who should work on what — that is the agent's
 * choice for the Router, or the Engine's assignment for a ticket.
 */

import type {
  DshContextLike,
  OneConfig,
  SessionControllerLike,
  SessionSummary,
} from '../types.js'
import type { ManagedSessionRecord, Store } from './store.js'
import { UserError } from '../core/errors.js'

export const SETTINGS_NAMESPACE = 'one'
export const ASSISTANT_SESSION_KEY = 'assistantSession'
export const ASSISTANT_HOME_KEY = 'assistantHome'

export interface SessionServiceOptions {
  readonly now?: () => number
}

export class SessionService {
  private readonly ctx: DshContextLike
  private readonly store: Store
  private readonly config: OneConfig
  private readonly now: () => number

  constructor(ctx: DshContextLike, store: Store, config: OneConfig, options: SessionServiceOptions = {}) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.now = options.now ?? Date.now
  }

  private get controller(): SessionControllerLike | undefined {
    return this.ctx.get('sessionController') as SessionControllerLike | undefined
  }

  requireController(): SessionControllerLike {
    const controller = this.controller
    if (controller === undefined) {
      throw new UserError('one/unavailable', 'sessionController is unavailable in this profile', {})
    }
    return controller
  }

  async list(): Promise<readonly SessionSummary[]> {
    const controller = this.controller
    if (controller === undefined) return []
    try {
      return (await controller.list({}, AbortSignal.timeout(this.config.commandTimeoutMs))).items
    } catch {
      return []
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    const items = await this.list()
    return items.some(item => item.sessionId === sessionId)
  }

  /** Create one ordinary DSH session and record its role. */
  async create(input: {
    readonly role: ManagedSessionRecord['role']
    readonly cwd?: string
    readonly sessionId?: string
    readonly agentPreset?: string
    readonly title?: string
  }): Promise<ManagedSessionRecord> {
    const controller = this.requireController()
    const created = await controller.create({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.agentPreset === undefined || input.agentPreset === '' ? {} : { agentPreset: input.agentPreset }),
    })
    return await this.register(created.sessionId, input.role, input.cwd, input.title)
  }

  /** Record a session the host already has, without creating anything. */
  async register(
    sessionId: string,
    role: ManagedSessionRecord['role'],
    cwd?: string,
    title?: string,
  ): Promise<ManagedSessionRecord> {
    const existing = this.store.getSession(sessionId)
    const at = this.now()
    const record: ManagedSessionRecord = {
      sessionId,
      role,
      ...(title ?? existing?.title) === undefined ? {} : { title: (title ?? existing?.title) as string },
      ...(cwd ?? existing?.cwd) === undefined ? {} : { cwd: (cwd ?? existing?.cwd) as string },
      status: 'active',
      trusted: true,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      lastSeenAt: at,
    }
    await this.store.putSession(record)
    return record
  }

  /** Deliver one message to a session; the request id makes a retry idempotent. */
  async prompt(input: {
    readonly sessionId: string
    readonly text: string
    readonly requestId: string
    readonly mode?: 'queue' | 'steer'
  }): Promise<void> {
    const controller = this.requireController()
    await controller.prompt(
      {
        requestId: input.requestId,
        sessionId: input.sessionId,
        mode: input.mode ?? 'queue',
        content: [{ type: 'text', text: input.text }],
      },
      AbortSignal.timeout(this.config.commandTimeoutMs),
    )
  }

  assistantSessionId(): string | undefined {
    const value = this.store.getSetting(SETTINGS_NAMESPACE, ASSISTANT_SESSION_KEY)?.value.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async setAssistantSessionId(sessionId: string): Promise<void> {
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: ASSISTANT_SESSION_KEY,
      value: sessionId,
      updatedAt: this.now(),
      updatedBy: 'system',
    })
  }

  assistantHome(): string | undefined {
    const value = this.store.getSetting(SETTINGS_NAMESPACE, ASSISTANT_HOME_KEY)?.value.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async setAssistantHome(path: string): Promise<void> {
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: ASSISTANT_HOME_KEY,
      value: path,
      updatedAt: this.now(),
      updatedBy: 'system',
    })
  }

  /**
   * Find or create the Router session. A stored id that the host no longer
   * lists is replaced, never returned as a dead conversation.
   */
  async ensureAssistant(home: string, title: string): Promise<string> {
    const stored = this.assistantSessionId()
    if (stored !== undefined && await this.exists(stored)) {
      await this.register(stored, 'router', home, title)
      return stored
    }
    const created = await this.create({ role: 'router', cwd: home, title })
    await this.setAssistantSessionId(created.sessionId)
    await this.setAssistantHome(home)
    return created.sessionId
  }

  /** Executor sessions recorded for one workspace. */
  workersInWorkspace(cwd: string): readonly ManagedSessionRecord[] {
    const key = normalize(cwd)
    return this.store.listSessions().filter(record =>
      record.role === 'executor' && record.cwd !== undefined && normalize(record.cwd) === key)
  }

  /** Every executor session this plugin knows about. */
  workers(): readonly ManagedSessionRecord[] {
    return this.store.listSessions().filter(record => record.role === 'executor')
  }
}

function normalize(path: string): string {
  const slashed = path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-zA-Z]:\//u.test(slashed) ? slashed.toLowerCase() : slashed
}
