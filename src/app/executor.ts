/**
 * The Executor adapter.
 *
 * It turns an Assignment into a message in an ordinary DSH Session, watches
 * that Session's turn end, and treats the absence of a Report as a block. All
 * retries live in the Effects queue; this file only decides *what* to do.
 */

import type { DshContextLike, OneConfig } from '../types.js'
import type { Store } from './store.js'
import type { Engine } from '../core/engine.js'
import type { Assignment, Ticket } from '../core/model.js'
import type { SessionService } from './sessions.js'
import { EffectsQueue, Later } from './effects.js'
import { newId } from '../core/ids.js'

interface LaunchPayload {
  readonly ticketId: string
  readonly assignmentId: string
}

interface RelayPayload {
  readonly text: string
  readonly sessionId?: string
}

interface ReplyPayload {
  readonly sessionId: string
  readonly text: string
  readonly requestId?: string
}

export interface ExecutorOptions {
  readonly now?: () => number
  readonly tickMs?: number
}

export class Executor {
  private readonly ctx: DshContextLike
  private readonly config: OneConfig
  private readonly store: Store
  private readonly engine: Engine
  private readonly effects: EffectsQueue
  private readonly sessions: SessionService
  private readonly now: () => number
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private draining = false
  private disposed = false

  constructor(
    ctx: DshContextLike,
    config: OneConfig,
    store: Store,
    engine: Engine,
    effects: EffectsQueue,
    sessions: SessionService,
    options: ExecutorOptions = {},
  ) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.engine = engine
    this.effects = effects
    this.sessions = sessions
    this.now = options.now ?? Date.now
    this.tickMs = options.tickMs ?? 2_000
  }

  /** Recover interrupted work, register the effect handlers, and start draining. */
  async start(): Promise<void> {
    await this.effects.recover()
    await this.recoverInterrupted()
    this.effects.register('launch', payload => this.launch(payload as LaunchPayload))
    this.effects.register('relay', payload => this.relay(payload as RelayPayload))
    this.effects.register('reply', payload => this.reply(payload as ReplyPayload))
    this.timer = setInterval(() => { void this.drain() }, this.tickMs)
    ;(this.timer as { unref?: () => void }).unref?.()
    await this.drain()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Ask the queue to run soon; safe to call from a tool after an assign. */
  schedule(): void {
    void this.drain()
  }

  /** Enqueue the one launch effect for a running assignment. */
  async enqueueLaunch(ticketId: string, assignmentId: string): Promise<void> {
    await this.effects.enqueue('launch', `${ticketId}:${assignmentId}`, { ticketId, assignmentId })
  }

  /** Enqueue one relay of a text into the Router session. */
  async enqueueRelay(text: string, sessionId?: string): Promise<void> {
    await this.effects.enqueue('relay', newId('relay'), { text, ...(sessionId === undefined ? {} : { sessionId }) })
  }

  /** Enqueue one reply into an arbitrary session. */
  async enqueueReply(sessionId: string, text: string, requestId?: string): Promise<void> {
    await this.effects.enqueue('reply', requestId ?? newId('reply'), {
      sessionId,
      text,
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  /** Handle one DSH session event. A turn that ends without a Report blocks the ticket. */
  handleSessionEvent(session: { readonly id?: string } | undefined, event: unknown): void {
    const sessionId = session?.id
    if (sessionId === undefined) return
    const type = typeof event === 'object' && event !== null
      ? (event as { type?: unknown }).type
      : undefined
    if (type !== 'turn/end') return
    const ticket = this.ticketForSession(sessionId)
    if (ticket === undefined) return
    const assignment = ticket.assignments.find(item => item.status === 'running' && item.sessionId === sessionId)
    if (assignment === undefined) return
    const lastReport = ticket.latestReport
    if (lastReport !== undefined && lastReport.at >= assignment.startedAt) return
    void this.engine.interrupt({
      ticketId: ticket.ticketId,
      assignmentId: assignment.assignmentId,
      kind: 'blocked',
      summary: 'turn-ended-without-report',
      detail: 'The worker turn ended without a one_work report; nothing is assumed done.',
    })
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining) return
    this.draining = true
    try {
      // Drain until the queue has nothing due: a handler may enqueue follow-up
      // work (a launch that fails and defers, a reply queued in the same tick).
      for (let round = 0; round < 10; round += 1) {
        const result = await this.effects.drain()
        if (result.processed === 0) break
      }
    } finally {
      this.draining = false
    }
  }

  private async launch(payload: LaunchPayload): Promise<void> {
    const ticket = this.engine.get(payload.ticketId)
    if (ticket === undefined || ticket.status !== 'open') return
    const assignment = ticket.assignments.find(item => item.assignmentId === payload.assignmentId)
    if (assignment === undefined || assignment.status !== 'running') return

    // Slots: the oldest running assignments hold the pool. A later one waits
    // instead of failing, so a burst of assigns drains in order.
    const running = this.engine.list()
      .flatMap(other => other.assignments.filter(item => item.status === 'running'))
      .sort((a, b) => a.startedAt - b.startedAt)
    const slot = running.findIndex(item => item.assignmentId === assignment.assignmentId)
    if (slot >= this.config.maxWorkers) throw new Later('all worker slots are busy', 2_000)

    const record = this.store.getSession(assignment.sessionId)
    if (record === undefined) {
      await this.failAssignment(ticket, assignment, 'worker session is not registered')
      return
    }
    if (!await this.sessions.exists(assignment.sessionId)) {
      await this.failAssignment(ticket, assignment, 'worker session is missing from session/list')
      return
    }
    if (record.cwd !== undefined && ticket.cwd !== undefined && record.cwd !== ticket.cwd) {
      // The agent chose a session in another workspace; that is allowed, the
      // session's own cwd wins. Record the mismatch for the panel.
      await this.store.putSession({ ...record, updatedAt: this.now() })
    }

    try {
      await this.sessions.prompt({
        sessionId: assignment.sessionId,
        text: this.taskText(ticket, assignment),
        requestId: `one:${ticket.ticketId}:${assignment.assignmentId}:launch`,
      })
    } catch (error: unknown) {
      // A prompt admission failure is a launch failure, not a ticket outcome:
      // the queue retries, and the same request id keeps it idempotent.
      throw error
    }
    await this.store.appendAudit({
      id: newId('audit'),
      at: this.now(),
      action: 'ticket_dispatched',
      ticketId: ticket.ticketId,
      targetSessionId: assignment.sessionId,
      outcome: 'ok',
      detail: ticket.title,
    }, 1_000)
  }

  private async relay(payload: RelayPayload): Promise<void> {
    const router = payload.sessionId ?? this.sessions.assistantSessionId()
    if (router === undefined) throw new Later('the router session is not ready', 5_000)
    await this.sessions.prompt({ sessionId: router, text: payload.text, requestId: newId('relay') })
  }

  private async reply(payload: ReplyPayload): Promise<void> {
    await this.sessions.prompt({
      sessionId: payload.sessionId,
      text: payload.text,
      requestId: payload.requestId ?? newId('reply'),
    })
  }

  private async failAssignment(ticket: Ticket, assignment: Assignment, reason: string): Promise<void> {
    await this.engine.interrupt({
      ticketId: ticket.ticketId,
      assignmentId: assignment.assignmentId,
      kind: 'failed',
      summary: reason,
    })
  }

  private ticketForSession(sessionId: string): Ticket | undefined {
    return this.engine.list().find(ticket =>
      ticket.status === 'open'
      && ticket.assignments.some(item => item.status === 'running' && item.sessionId === sessionId))
  }

  private async recoverInterrupted(): Promise<void> {
    for (const ticket of this.engine.list()) {
      for (const assignment of ticket.assignments) {
        if (assignment.status !== 'running') continue
        await this.engine.interrupt({
          ticketId: ticket.ticketId,
          assignmentId: assignment.assignmentId,
          kind: 'blocked',
          summary: 'host-restarted',
          detail: 'The host restarted while this assignment was running. Inspect the workspace before retrying.',
        })
      }
    }
  }

  private taskText(ticket: Ticket, assignment: Assignment): string {
    const label = ticket.assistantLabel
    const report = JSON.stringify({
      action: 'report',
      ticketId: ticket.ticketId,
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      reportKind: 'progress | waiting | ready | blocked | failed | dropped',
      summary: 'one-line state and evidence',
    })
    return [
      ...(label === undefined ? [] : [label, '']),
      `[DSH One ticket ${ticket.ticketId}]`,
      `Title: ${ticket.title}`,
      '',
      'Goal:',
      ticket.goal,
      '',
      ...(ticket.cwd === undefined ? [] : [`Workspace: ${ticket.cwd}`, '']),
      'Report through the one_work tool, for example:',
      report,
      '',
      'The final chat text is not a result. Do not mark work ready without evidence.',
      'Stay inside the workspace. If you are blocked, report blocked with the reason.',
    ].join('\n')
  }
}
