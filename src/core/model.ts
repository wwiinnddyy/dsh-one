/**
 * The dsh-one domain model.
 *
 * One work unit is a **Ticket**. A Ticket is authorized by a Decision, bound to
 * an Executor through an **Assignment**, and reports back through a **Report**.
 * A **Goal** is only a grouping of Tickets for display — it owns no scheduler.
 *
 * The model is deliberately free of I/O: `core/` imports nothing outside itself
 * apart from Node's hashing, so every rule in this file is unit-testable.
 */

/** What a Ticket is waiting for, derived from its facts (see `stage.ts`). */
export type TicketStage =
  | 'person/delivery'
  | 'person/answer'
  | 'person/review'
  | 'person/blocked'
  | 'person/failed'
  | 'working/queued'
  | 'idle'
  | 'working'
  | 'ended'

export type TicketStatus = 'open' | 'ended'

export type TicketOutcome = 'completed' | 'dropped' | 'cancelled'

/** The structured result of one Assignment. */
export type ReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export type AssignmentStatus = 'pending' | 'running' | 'ended'

/** One binding of a Ticket to one Executor Session. */
export interface Assignment {
  readonly assignmentId: string
  readonly sessionId: string
  readonly status: AssignmentStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly error?: string
}

/** What an Executor reports back. Reports are append-only facts. */
export interface Report {
  readonly reportId: string
  readonly assignmentId: string
  readonly sessionId: string
  readonly kind: ReportKind
  readonly summary: string
  readonly detail?: string
  readonly evidence?: string
  readonly at: number
}

/** A structured question that only a person can answer. */
export interface Attention {
  readonly question: string
  readonly askedAt: number
  readonly answer?: string
  readonly answeredAt?: number
}

/** The last failed delivery of an Input to an Executor Session. */
export interface DeliveryFailure {
  readonly message: string
  readonly at: number
}

/**
 * A unit of authorized work.
 *
 * Fields are facts, never derived state: `stage` is computed by `stageOf`, so a
 * Ticket cannot disagree with itself about what it is waiting for.
 */
export interface Ticket {
  readonly ticketId: string
  readonly title: string
  readonly goal: string
  readonly cwd?: string
  readonly status: TicketStatus
  readonly outcome?: TicketOutcome
  readonly assignments: readonly Assignment[]
  readonly latestReport?: Report
  readonly attention?: Attention
  readonly delivery?: DeliveryFailure
  /** The Goal this Ticket belongs to, when it was planned as part of one. */
  readonly goalId?: string
  /** Who asked for the work. */
  readonly origin?: 'assistant' | 'human' | 'agent'
  /** Frozen origin header for prompts created by the assistant. */
  readonly assistantLabel?: string
  readonly createdBy?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly endedAt?: number
  readonly endReason?: string
}

/** A display-only grouping of Tickets. It never schedules anything. */
export interface Goal {
  readonly goalId: string
  readonly title: string
  readonly cwd?: string
  readonly ticketIds: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** A Ticket plus its derived stage, for tools and the panel. */
export interface TicketView extends Ticket {
  readonly stage: TicketStage
}

/** Counts by stage, for the status tool. */
export type StageCounts = Readonly<Record<TicketStage, number>>
