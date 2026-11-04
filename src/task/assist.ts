/**
 * The assistant's autonomous loop: plan → dispatch → poll → summarise.
 *
 * This is the "coordinator" the Super Agent architecture describes: it takes one
 * goal, turns it into a small set of tasks, hands them to the existing task
 * runtime, watches them, and reports a single verdict. It deliberately adds no
 * new task semantics — `TaskRuntime` already owns the state machine, worker
 * slots, leases, and budgets, and is covered by its own tests.
 *
 * Two design rules matter more than the loop itself:
 *
 * 1. **Bounded.** A loop that can run without limit is a way to spend money
 *    while nobody is looking. Every run carries a maximum number of poll
 *    rounds, a maximum number of tasks, and a wall-clock deadline, and any of
 *    them ends the run with an explicit `exhausted` status.
 * 2. **Verified, not self-assessed.** A run is not "done" because a model says
 *    so. It is done when every task reached a terminal state the plan accounts
 *    for. A model claiming success cannot turn a failed task into a success.
 */

export type AssistStatus = 'completed' | 'failed' | 'blocked' | 'partial' | 'exhausted' | 'cancelled'

/** One task the coordinator decided to create. */
export interface AssistStep {
  readonly title: string
  readonly goal: string
  readonly cwd?: string
  readonly priority?: number
}

/** Limits that keep one run from running away. */
export interface AssistLimits {
  /** Maximum poll rounds before the run is declared exhausted. */
  readonly maxRounds: number
  /** Maximum tasks one run may create. */
  readonly maxTasks: number
  /** Wall-clock deadline in milliseconds. */
  readonly deadlineMs: number
  /** Delay between polls in milliseconds; zero means no sleeping. */
  readonly pollIntervalMs: number
}

/** The conservative default a deployment can override. */
export const DEFAULT_ASSIST_LIMITS: AssistLimits = {
  maxRounds: 30,
  maxTasks: 5,
  deadlineMs: 600_000,
  pollIntervalMs: 2_000,
}

/** Why a run ended, in a form that can be shown to a person. */
export interface AssistOutcome {
  readonly status: AssistStatus
  readonly rounds: number
  readonly createdTasks: readonly string[]
  readonly completed: readonly string[]
  readonly failed: readonly string[]
  readonly blocked: readonly string[]
  readonly detail: string
}

/** The task surface the loop needs; a narrow slice of `TaskService`. */
export interface AssistTaskPort {
  createTask(
    input: { readonly title: string; readonly goal: string; readonly cwd?: string; readonly priority?: number },
    options: { readonly origin?: 'agent' | 'human'; readonly createdBy?: string },
  ): Promise<{ readonly task: { readonly id: string; readonly status: string } }>
  assign(taskId: string, options?: { readonly callerSessionId?: string }): Promise<{ readonly started: boolean }>
  getTask(taskId: string): { readonly id: string; readonly status: string } | undefined
}

/** Clamp a caller-supplied limit into a range that cannot be absurd. */
export function normalizeLimits(partial?: Partial<AssistLimits>): AssistLimits {
  const pick = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(value)))
  }
  return {
    maxRounds: pick(partial?.maxRounds, DEFAULT_ASSIST_LIMITS.maxRounds, 1, 200),
    maxTasks: pick(partial?.maxTasks, DEFAULT_ASSIST_LIMITS.maxTasks, 1, 20),
    deadlineMs: pick(partial?.deadlineMs, DEFAULT_ASSIST_LIMITS.deadlineMs, 1_000, 3_600_000),
    pollIntervalMs: pick(partial?.pollIntervalMs, DEFAULT_ASSIST_LIMITS.pollIntervalMs, 0, 60_000),
  }
}

/**
 * Build the plan for one goal.
 *
 * The plan is derived from the goal text rather than invented by a model here:
 * the coordinator's job in this build is to run the loop reliably, and a
 * deterministic plan is what makes the loop testable. A model-authored plan
 * plugs in at this seam later without touching the loop.
 */
export function planSteps(goal: string, requested?: readonly AssistStep[]): readonly AssistStep[] {
  if (requested !== undefined && requested.length > 0) return requested
  const trimmed = goal.trim()
  return [{ title: trimmed === '' ? 'Assist' : trimmed.slice(0, 80), goal: trimmed }]
}

/** A task is terminal once it can no longer make progress on its own. */
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'blocked'])

/** Map one terminal task status onto the run's outcome buckets. */
function bucketOf(status: string): 'completed' | 'failed' | 'blocked' | undefined {
  if (status === 'done') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'blocked') return 'blocked'
  return undefined
}

export interface RunAssistInput {
  readonly goal: string
  readonly steps?: readonly AssistStep[]
  readonly limits?: Partial<AssistLimits>
  readonly callerSessionId?: string
  /** Injected so tests can run the loop without real time passing. */
  readonly now?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly signal?: AbortSignal
}

/**
 * Run one bounded plan.
 *
 * Returns only after every task is terminal or a limit stopped the run, so the
 * caller never has to guess whether work is still in flight.
 */
export async function runAssist(port: AssistTaskPort, input: RunAssistInput): Promise<AssistOutcome> {
  const limits = normalizeLimits(input.limits)
  const now = input.now ?? (() => Date.now())
  const sleep = input.sleep ?? (async () => {})
  const deadline = now() + limits.deadlineMs

  const planned = planSteps(input.goal, input.steps).slice(0, limits.maxTasks)
  if (planned.length === 0) {
    return {
      status: 'failed',
      rounds: 0,
      createdTasks: [],
      completed: [],
      failed: [],
      blocked: [],
      detail: 'the plan was empty, so there was nothing to run',
    }
  }

  const taskIds: string[] = []
  for (const step of planned) {
    if (input.signal?.aborted === true) break
    const created = await port.createTask(
      {
        title: step.title,
        goal: step.goal,
        ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
        ...(step.priority === undefined ? {} : { priority: step.priority }),
      },
      { origin: 'agent', ...(input.callerSessionId === undefined ? {} : { createdBy: input.callerSessionId }) },
    )
    taskIds.push(created.task.id)
    await port.assign(created.task.id, {
      ...(input.callerSessionId === undefined ? {} : { callerSessionId: input.callerSessionId }),
    })
  }

  const completed: string[] = []
  const failed: string[] = []
  const blocked: string[] = []
  let rounds = 0

  // Poll until every task is terminal or a bound stops us. `rounds` counts
  // polls, not tasks, so a hung task cannot be hidden behind a long plan.
  while (rounds < limits.maxRounds) {
    if (input.signal?.aborted === true) {
      return finish('cancelled', rounds, taskIds, completed, failed, blocked, 'the run was cancelled')
    }
    rounds += 1
    completed.length = 0
    failed.length = 0
    blocked.length = 0
    let pending = 0
    for (const taskId of taskIds) {
      const task = port.getTask(taskId)
      if (task === undefined) {
        failed.push(taskId)
        continue
      }
      const bucket = bucketOf(task.status)
      if (bucket === undefined) pending += 1
      else if (bucket === 'completed') completed.push(taskId)
      else if (bucket === 'failed') failed.push(taskId)
      else blocked.push(taskId)
    }
    if (pending === 0) {
      const status: AssistStatus = failed.length > 0
        ? (completed.length > 0 || blocked.length > 0 ? 'partial' : 'failed')
        : (blocked.length > 0 ? 'blocked' : 'completed')
      return finish(status, rounds, taskIds, completed, failed, blocked, summarise(status, completed, failed, blocked))
    }
    if (now() >= deadline) {
      return finish('exhausted', rounds, taskIds, completed, failed, blocked, 'the deadline passed with work still running')
    }
    await sleep(limits.pollIntervalMs)
  }

  return finish('exhausted', rounds, taskIds, completed, failed, blocked,
    `the run used all ${limits.maxRounds} poll rounds with work still running`)
}

function finish(
  status: AssistStatus,
  rounds: number,
  createdTasks: readonly string[],
  completed: readonly string[],
  failed: readonly string[],
  blocked: readonly string[],
  detail: string,
): AssistOutcome {
  return {
    status,
    rounds,
    createdTasks: [...createdTasks],
    completed: [...completed],
    failed: [...failed],
    blocked: [...blocked],
    detail,
  }
}

function summarise(
  status: AssistStatus,
  completed: readonly string[],
  failed: readonly string[],
  blocked: readonly string[],
): string {
  const parts = [`${completed.length} done`]
  if (failed.length > 0) parts.push(`${failed.length} failed`)
  if (blocked.length > 0) parts.push(`${blocked.length} need a person`)
  const lead = status === 'completed' ? 'all tasks finished' : 'the plan did not fully succeed'
  return `${lead}: ${parts.join(', ')}`
}
