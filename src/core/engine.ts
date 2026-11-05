/**
 * The single writer of Tickets and Goals.
 *
 * Every command validates the current facts, builds the next immutable row and
 * writes it exactly once. Adapters (tools, the executor, the panel) call these
 * commands; none of them mutate a Ticket directly.
 */

import type { Assignment, Goal, Report, ReportKind, Ticket } from './model.js'
import { UserError } from './errors.js'
import { newId } from './ids.js'
import { stageOf } from './stage.js'

/** The only Ticket persistence port the Engine needs. */
export interface TicketRepository {
  getTicket(ticketId: string): Ticket | undefined
  putTicket(ticket: Ticket): Promise<void>
  listTickets(): readonly Ticket[]
}

/** The only Goal persistence port the Engine needs. */
export interface GoalRepository {
  getGoal(goalId: string): Goal | undefined
  putGoal(goal: Goal): Promise<void>
  listGoals(): readonly Goal[]
}

export interface CreateTicketInput {
  readonly title: string
  readonly goal: string
  readonly cwd?: string
  readonly goalId?: string
  readonly origin?: 'assistant' | 'human' | 'agent'
  readonly assistantLabel?: string
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

export interface CreateGoalInput {
  readonly title: string
  readonly cwd?: string
  readonly goalId?: string
}

/** A Goal plus the progress derived from its Tickets. */
export interface GoalView extends Goal {
  readonly total: number
  readonly done: number
  readonly open: number
}

const REPORT_KINDS: readonly ReportKind[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

function endAssignment(assignment: Assignment, at: number, error?: string): Assignment {
  return {
    ...assignment,
    status: 'ended',
    endedAt: at,
    ...(error === undefined ? {} : { error }),
  }
}

export class Engine {
  private readonly tickets: TicketRepository
  private readonly goals: GoalRepository
  private readonly now: () => number

  constructor(tickets: TicketRepository, goals: GoalRepository, now: () => number = Date.now) {
    this.tickets = tickets
    this.goals = goals
    this.now = now
  }

  get(ticketId: string): Ticket | undefined {
    return this.tickets.getTicket(ticketId)
  }

  list(): readonly Ticket[] {
    return this.tickets.listTickets()
  }

  /** Create one Ticket. The same `ticketId` returns the existing row. */
  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const title = input.title.trim()
    const goal = input.goal.trim()
    if (title === '') throw new UserError('one/invalid-argument', 'ticket title must not be blank', { field: 'title' })
    if (goal === '') throw new UserError('one/invalid-argument', 'ticket goal must not be blank', { field: 'goal' })
    const ticketId = input.ticketId ?? newId('ticket')
    const existing = this.tickets.getTicket(ticketId)
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
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.assistantLabel === undefined ? {} : { assistantLabel: input.assistantLabel }),
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      createdAt: at,
      updatedAt: at,
    }
    await this.tickets.putTicket(ticket)
    return ticket
  }

  /** Bind the Ticket to one Executor Session. */
  async assign(input: AssignInput): Promise<Ticket> {
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
    return await this.write({ ...ticket, assignments: [...ticket.assignments, assignment], updatedAt: at })
  }

  /**
   * Record one Report.
   *
   * `progress` keeps the Assignment running; every other kind ends it. A
   * `dropped` Report also ends the Ticket without asking a person.
   */
  async report(input: ReportInput): Promise<Ticket> {
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
      return await this.write({ ...next, status: 'ended', outcome: 'dropped', endedAt: at, endReason: summary })
    }
    return await this.write(next)
  }

  /** Raise one structured question for a person. */
  async ask(input: AskInput): Promise<Ticket> {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const question = input.question.trim()
    if (question === '') throw new UserError('one/invalid-argument', 'question must not be blank', { field: 'question' })
    const at = this.now()
    return await this.write({ ...ticket, attention: { question, askedAt: at }, updatedAt: at })
  }

  /** Answer the outstanding question. */
  async answer(input: AnswerInput): Promise<Ticket> {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const attention = ticket.attention
    if (attention === undefined || attention.answer !== undefined) {
      throw new UserError('one/no-question', 'this ticket has no outstanding question', { ticketId: ticket.ticketId })
    }
    const answer = input.answer.trim()
    if (answer === '') throw new UserError('one/invalid-argument', 'answer must not be blank', { field: 'answer' })
    const at = this.now()
    return await this.write({ ...ticket, attention: { ...attention, answer, answeredAt: at }, updatedAt: at })
  }

  /** Complete a Ticket whose latest Report is `ready`. */
  async complete(input: CompleteInput): Promise<Ticket> {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    if (ticket.latestReport?.kind !== 'ready') {
      throw new UserError('one/not-ready', 'only a ready ticket can be completed', {
        ticketId: ticket.ticketId,
        latest: ticket.latestReport?.kind ?? 'none',
      })
    }
    const at = this.now()
    return await this.end(ticket, 'completed', input.reason ?? 'completed', at)
  }

  /** Stop a Ticket. This is a person's decision and cannot be undone. */
  async stop(input: StopInput): Promise<Ticket> {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const at = this.now()
    return await this.end(ticket, 'cancelled', input.reason ?? 'stopped', at)
  }

  /**
   * Record an infrastructure-level ending of an Assignment, such as a turn that
   * ended without a report or a host restart. It is a Report so the Ticket shows
   * a person stage instead of silently looking busy.
   */
  async interrupt(input: {
    readonly ticketId: string
    readonly assignmentId: string
    readonly kind: 'blocked' | 'failed'
    readonly summary: string
    readonly detail?: string
  }): Promise<Ticket> {
    const ticket = this.requireTicket(input.ticketId)
    this.assertOpen(ticket)
    const assignment = ticket.assignments.find(item => item.assignmentId === input.assignmentId)
    if (assignment === undefined) {
      throw new UserError('one/assignment-not-found', 'this ticket has no such assignment', {
        ticketId: ticket.ticketId,
        assignmentId: input.assignmentId,
      })
    }
    if (assignment.status !== 'running') return ticket
    const at = this.now()
    const report: Report = {
      reportId: newId('report'),
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      kind: input.kind,
      summary: input.summary,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      at,
    }
    return await this.write({
      ...ticket,
      assignments: ticket.assignments.map(item =>
        item.assignmentId === assignment.assignmentId ? endAssignment(item, at) : item),
      latestReport: report,
      updatedAt: at,
    })
  }

  /** A tool or panel view: the stored Ticket plus its derived stage. */
  view(ticketId: string): (Ticket & { readonly stage: ReturnType<typeof stageOf> }) | undefined {
    const ticket = this.tickets.getTicket(ticketId)
    return ticket === undefined ? undefined : { ...ticket, stage: stageOf(ticket) }
  }

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const title = input.title.trim()
    if (title === '') throw new UserError('one/invalid-argument', 'goal title must not be blank', { field: 'title' })
    const goalId = input.goalId ?? newId('goal')
    const existing = this.goals.getGoal(goalId)
    if (existing !== undefined) return existing
    const at = this.now()
    const goal: Goal = {
      goalId,
      title,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ticketIds: [],
      createdAt: at,
      updatedAt: at,
    }
    await this.goals.putGoal(goal)
    return goal
  }

  async attachToGoal(goalId: string, ticketId: string): Promise<Goal> {
    const goal = this.goals.getGoal(goalId)
    if (goal === undefined) throw new UserError('one/goal-not-found', `goal "${goalId}" was not found`, { goalId })
    if (goal.ticketIds.includes(ticketId)) return goal
    const updated: Goal = { ...goal, ticketIds: [...goal.ticketIds, ticketId], updatedAt: this.now() }
    await this.goals.putGoal(updated)
    return updated
  }

  getGoal(goalId: string): Goal | undefined {
    return this.goals.getGoal(goalId)
  }

  listGoals(): readonly Goal[] {
    return this.goals.listGoals()
  }

  goalView(goalId: string): GoalView | undefined {
    const goal = this.goals.getGoal(goalId)
    if (goal === undefined) return undefined
    const tickets = goal.ticketIds
      .map(ticketId => this.tickets.getTicket(ticketId))
      .filter((ticket): ticket is Ticket => ticket !== undefined)
    const done = tickets.filter(ticket => ticket.status === 'ended' && ticket.outcome === 'completed').length
    const open = tickets.filter(ticket => ticket.status === 'open').length
    return { ...goal, total: tickets.length, done, open }
  }

  private async end(ticket: Ticket, outcome: 'completed' | 'dropped' | 'cancelled', reason: string, at: number): Promise<Ticket> {
    const assignments = ticket.assignments.map(item =>
      item.status === 'running' ? endAssignment(item, at) : item)
    return await this.write({
      ...ticket,
      status: 'ended',
      outcome,
      assignments,
      endedAt: at,
      endReason: reason,
      updatedAt: at,
    })
  }

  private async write(ticket: Ticket): Promise<Ticket> {
    await this.tickets.putTicket(ticket)
    return ticket
  }

  private requireTicket(ticketId: string): Ticket {
    const ticket = this.tickets.getTicket(ticketId)
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
