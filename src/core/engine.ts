/**
 * The single writer of Tickets.
 *
 * Every command is synchronous, validates the current facts, builds the next
 * immutable Ticket and writes it exactly once. Adapters (tools, HTTP, the
 * executor loop) call these commands; none of them mutate a Ticket directly.
 */

import type { Assignment, Report, ReportKind, Ticket } from './model.js'
import { UserError } from './errors.js'
import { newId } from './ids.js'
import { stageOf } from './stage.js'

/** The only Ticket persistence port the Engine needs. */
export interface TicketRepository {
  get(ticketId: string): Ticket | undefined
  put(ticket: Ticket): void
  list(): readonly Ticket[]
}

export interface CreateTicketInput {
  readonly title: string
  readonly goal: string
  readonly cwd?: string
  readonly goalId?: string
  readonly createdBy?: string
  /** Deterministic id for idempotent creation. */
  readonly ticketId?: string
}

export interface AssignInput {
  readonly ticketId: string
  readonly sessionId: string
  readonly assignmentId?: string
}

export interface ReportInput {
  readonly ticketId: string
  readonly assignmentId: string
  readonly sessionId: string
  readonly kind: ReportKind
  readonly summary: string
  readonly reportId?: string
  readonly detail?: string
  readonly evidence?: string
}

export interface AskInput {
  readonly ticketId: string
  readonly question: string
}

export interface AnswerInput {
  readonly ticketId: string
  readonly answer: string
}

export interface StopInput {
  readonly ticketId: string
  readonly reason?: string
}

export interface CompleteInput {
  readonly ticketId: string
  readonly reason?: string
}

const REPORT_KINDS: readonly ReportKind[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

/** Ends one Assignment's life without losing its history. */
function endAssignment(assignment: Assignment, at: number, error?: string): Assignment {
  return {
    ...assignment,
    status: 'ended',
    endedAt: at,
    ...(error === undefined ? {} : { error }),
  }
}

export class Engine {
  private readonly repo: TicketRepository
  private readonly now: () => number

  constructor(repo: TicketRepository, now: () => number = Date.now) {
    this.repo = repo
    this.now = now
  }

  get(ticketId: string): Ticket | undefined {
    return this.repo.get(ticketId)
  }

  list(): readonly Ticket[] {
    return this.repo.list()
  }

  /** Create one Ticket. The same `ticketId` returns the existing row. */
  createTicket(input: CreateTicketInput): Ticket {
    const title = input.title.trim()
    const goal = input.goal.trim()
    if (title === '') throw new UserError('one/invalid-argument', 'ticket title must not be blank', { field: 'title' })
    if (goal === '') throw new UserError('one/invalid-argument', 'ticket goal must not be blank', { field: 'goal' })
    const ticketId = input.ticketId ?? newId('ticket')
    const existing = this.repo.get(ticketId)
    if (existing !== undefined) return existing
    const at = this.now()
    const ticket: Ticket = {
      ticketId,
      title,
      goal,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      status: 'open',
      assignments: [],
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      createdAt: at,
      updatedAt: at,
    }
    this.repo.put(ticket)
    return ticket
  }

  /** Bind the Ticket to one Executor Session. */
  assign(input: AssignInput): Ticket {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    if (ticket.assignments.some(item => item.status === 'running')) {
      throw new UserError('one/assignment-running', 'this ticket already has a running assignment', {
        ticketId: ticket.ticketId,
      })
    }
    const at = this.now()
    const assignment: Assignment = {
      assignmentId: input.assignmentId ?? newId('assignment'),
      sessionId: input.sessionId,
      status: 'running',
      startedAt: at,
    }
    return this.write({ ...ticket, assignments: [...ticket.assignments, assignment], updatedAt: at })
  }

  /**
   * Record one Report.
   *
   * `progress` keeps the Assignment running; every other kind ends it. A
   * `dropped` Report also ends the Ticket without a message.
   */
  report(input: ReportInput): Ticket {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    if (!REPORT_KINDS.includes(input.kind)) {
      throw new UserError('one/invalid-argument', `unknown report kind "${String(input.kind)}"`, { kind: input.kind })
    }
    const assignment = ticket.assignments.find(item => item.assignmentId === input.assignmentId)
    if (assignment === undefined) {
      throw new UserError('one/assignment-not-found', 'this ticket has no such assignment', {
        ticketId: ticket.ticketId,
        assignmentId: input.assignmentId,
      })
    }
    if (assignment.status !== 'running') {
      throw new UserError('one/assignment-not-running', 'this assignment is not running', {
        ticketId: ticket.ticketId,
        assignmentId: input.assignmentId,
        status: assignment.status,
      })
    }
    const summary = input.summary.trim()
    if (summary === '') throw new UserError('one/invalid-argument', 'report summary must not be blank', { field: 'summary' })
    const at = this.now()
    const report: Report = {
      reportId: input.reportId ?? newId('report'),
      assignmentId: assignment.assignmentId,
      sessionId: input.sessionId,
      kind: input.kind,
      summary,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      at,
    }
    const assignments = ticket.assignments.map(item =>
      item.assignmentId === assignment.assignmentId && input.kind !== 'progress'
        ? endAssignment(item, at)
        : item)
    const next: Ticket = { ...ticket, assignments, latestReport: report, updatedAt: at }
    if (input.kind === 'dropped') {
      return this.write({ ...next, status: 'ended', outcome: 'dropped', endedAt: at, endReason: summary })
    }
    return this.write(next)
  }

  /** Raise one structured question for a person. */
  ask(input: AskInput): Ticket {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const question = input.question.trim()
    if (question === '') throw new UserError('one/invalid-argument', 'question must not be blank', { field: 'question' })
    const at = this.now()
    return this.write({ ...ticket, attention: { question, askedAt: at }, updatedAt: at })
  }

  /** Answer the outstanding question. */
  answer(input: AnswerInput): Ticket {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const attention = ticket.attention
    if (attention === undefined || attention.answer !== undefined) {
      throw new UserError('one/no-question', 'this ticket has no outstanding question', { ticketId: ticket.ticketId })
    }
    const answer = input.answer.trim()
    if (answer === '') throw new UserError('one/invalid-argument', 'answer must not be blank', { field: 'answer' })
    const at = this.now()
    return this.write({ ...ticket, attention: { ...attention, answer, answeredAt: at }, updatedAt: at })
  }

  /** Complete a Ticket whose latest Report is `ready`. */
  complete(input: CompleteInput): Ticket {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    if (ticket.latestReport?.kind !== 'ready') {
      throw new UserError('one/not-ready', 'only a ready ticket can be completed', {
        ticketId: ticket.ticketId,
        latest: ticket.latestReport?.kind ?? 'none',
      })
    }
    const at = this.now()
    return this.end(ticket, 'completed', input.reason ?? 'completed', at)
  }

  /** Stop a Ticket. This is a person's decision and cannot be undone. */
  stop(input: StopInput): Ticket {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const at = this.now()
    return this.end(ticket, 'cancelled', input.reason ?? 'stopped', at)
  }

  /** A tool or panel view: the stored Ticket plus its derived stage. */
  view(ticketId: string): (Ticket & { readonly stage: ReturnType<typeof stageOf> }) | undefined {
    const ticket = this.repo.get(ticketId)
    return ticket === undefined ? undefined : { ...ticket, stage: stageOf(ticket) }
  }

  private end(ticket: Ticket, outcome: 'completed' | 'dropped' | 'cancelled', reason: string, at: number): Ticket {
    const assignments = ticket.assignments.map(item =>
      item.status === 'running' ? endAssignment(item, at) : item)
    return this.write({
      ...ticket,
      status: 'ended',
      outcome,
      assignments,
      endedAt: at,
      endReason: reason,
      updatedAt: at,
    })
  }

  private write(ticket: Ticket): Ticket {
    this.repo.put(ticket)
    return ticket
  }

  private requireTicket(ticketId: string): Ticket {
    const ticket = this.repo.get(ticketId)
    if (ticket === undefined) {
      throw new UserError('one/ticket-not-found', `ticket "${ticketId}" was not found`, { ticketId })
    }
    return ticket
  }

  private assertOpen(ticket: Ticket): void {
    if (ticket.status !== 'open') {
      throw new UserError('one/ticket-ended', `ticket "${ticket.ticketId}" is ${ticket.outcome ?? 'ended'}`, {
        ticketId: ticket.ticketId,
      })
    }
  }
}
