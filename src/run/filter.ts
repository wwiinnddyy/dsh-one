/**
 * Deterministic, first-level projection of a run.
 *
 * This module answers one question without any model, timer, or store access:
 * given the task rows, what is the run's state, and which step transitions are
 * worth recording? Keeping it pure makes the quiet/speak policy testable.
 */

import type { RunActivityKind, RunRecord, RunStatus, RunStepView, TaskStatus } from '../types.js'

export const isTerminalTask = (status: TaskStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled'

export const isTerminalRun = (status: RunStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled' || status === 'exhausted'

/** Needs a person: the worker blocked, asked to be completed, or was cancelled. */
const needsPerson = (status: TaskStatus): boolean =>
  status === 'blocked' || status === 'ready' || status === 'cancelled'

export function runStatusOf(run: RunRecord, steps: readonly RunStepView[]): RunStatus {
  if (run.paused) return 'active'
  if (steps.length === 0) return 'done'
  if (steps.every(step => step.status === 'done')) return 'done'
  if (steps.some(step => step.status === 'failed')) return 'failed'
  if (steps.some(step => needsPerson(step.status))) return 'needs-you'
  return 'active'
}

export interface StepTransition {
  readonly step: RunStepView
  readonly previous?: string
  readonly kind: Extract<RunActivityKind, 'step-done' | 'step-failed' | 'step-blocked'>
  readonly level: 'info' | 'attention' | 'error'
  readonly dedupeKey: string
}

/**
 * Transitions that are worth writing to the activity feed.
 *
 * Progress, waiting and running are deliberately absent: the dock shows those
 * live, and a coordinator that narrates every step is noise.
 */
export function transitionsOf(run: RunRecord, steps: readonly RunStepView[]): StepTransition[] {
  const transitions: StepTransition[] = []
  for (const step of steps) {
    const previous = run.seen[step.taskId]
    if (previous === step.status) continue
    if (step.status === 'done') {
      transitions.push({
        step, ...(previous === undefined ? {} : { previous }),
        kind: 'step-done', level: 'info', dedupeKey: `${run.runId}:${step.taskId}:done`,
      })
    } else if (step.status === 'failed') {
      transitions.push({
        step, ...(previous === undefined ? {} : { previous }),
        kind: 'step-failed', level: 'error', dedupeKey: `${run.runId}:${step.taskId}:failed`,
      })
    } else if (needsPerson(step.status)) {
      transitions.push({
        step, ...(previous === undefined ? {} : { previous }),
        kind: 'step-blocked', level: 'attention', dedupeKey: `${run.runId}:${step.taskId}:${step.status}`,
      })
    }
  }
  return transitions
}

export function attentionOf(
  steps: readonly RunStepView[],
  now: number,
): { readonly reason: string; readonly taskId?: string; readonly since: number } | undefined {
  const step = steps.find(item =>
    item.status === 'blocked' || item.status === 'ready' || item.status === 'failed' || item.status === 'cancelled',
  )
  if (step === undefined) return undefined
  return {
    reason: step.attention ?? step.latestReport ?? step.status,
    taskId: step.taskId,
    since: step.updatedAt ?? now,
  }
}
