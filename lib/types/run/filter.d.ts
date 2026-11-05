/**
 * Deterministic, first-level projection of a run.
 *
 * This module answers one question without any model, timer, or store access:
 * given the task rows, what is the run's state, and which step transitions are
 * worth recording? Keeping it pure makes the quiet/speak policy testable.
 */
import type { RunActivityKind, RunRecord, RunStatus, RunStepView, TaskStatus } from '../types.js';
export declare const isTerminalTask: (status: TaskStatus) => boolean;
export declare const isTerminalRun: (status: RunStatus) => boolean;
export declare function runStatusOf(run: RunRecord, steps: readonly RunStepView[]): RunStatus;
export interface StepTransition {
    readonly step: RunStepView;
    readonly previous?: string;
    readonly kind: Extract<RunActivityKind, 'step-done' | 'step-failed' | 'step-blocked'>;
    readonly level: 'info' | 'attention' | 'error';
    readonly dedupeKey: string;
}
/**
 * Transitions that are worth writing to the activity feed.
 *
 * Progress, waiting and running are deliberately absent: the dock shows those
 * live, and a coordinator that narrates every step is noise.
 */
export declare function transitionsOf(run: RunRecord, steps: readonly RunStepView[]): StepTransition[];
export declare function attentionOf(steps: readonly RunStepView[], now: number): {
    readonly reason: string;
    readonly taskId?: string;
    readonly since: number;
} | undefined;
