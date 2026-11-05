/**
 * When the assistant speaks, and when it stays quiet.
 *
 * The Super Agent idea most easily lost in implementation is "know when to shut
 * up". A coordinator that narrates every step is harder to work with than one
 * that only surfaces what a person must act on. This module is the policy for
 * that, kept pure so it can be tested without a running task system.
 *
 * The rule is deliberately narrow — three reasons to interrupt, everything else
 * waits:
 *
 * - `done`      the whole plan finished; the user asked for an outcome.
 * - `needs-you` something is blocked and only a person can unblock it.
 * - `failed`    the run failed and cannot recover on its own.
 *
 * Progress, retries, and intermediate steps are *not* reasons to speak. They
 * remain visible in the task list for anyone who looks.
 */
/** Why a notification might be sent. */
export type NotifyReason = 'done' | 'needs-you' | 'failed';
/** One candidate notification the assistant considered raising. */
export interface NotifyCandidate {
    readonly reason: NotifyReason;
    /** Stable identity, so one event cannot notify twice. */
    readonly key: string;
    readonly title: string;
    readonly detail?: string;
    readonly at: number;
}
/** The quiet hours and muted switches a person configured. */
export interface QuietPolicy {
    /** Master switch: when true nothing is raised. */
    readonly muted: boolean;
    /**
     * Reasons that may still break through `muted`. A person who muted progress
     * chatter usually still wants to be told that something failed outright.
     */
    readonly breakthrough: readonly NotifyReason[];
    /** Local-day start minute (0-1439) of quiet hours; `undefined` disables it. */
    readonly quietFrom?: number;
    /** Local-day end minute (0-1439); may wrap past midnight. */
    readonly quietTo?: number;
}
/** The conservative default: audible for results and blocks, silent for noise. */
export declare const DEFAULT_QUIET_POLICY: QuietPolicy;
/** Minutes since local midnight for one timestamp, in the given timezone offset. */
export declare function localMinuteOfDay(at: number, utcOffsetMinutes?: number): number;
/** Whether `minute` falls inside a possibly-wrapping quiet window. */
export declare function inQuietHours(minute: number, from: number, to: number): boolean;
/** Why one candidate was suppressed, or `undefined` when it should be raised. */
export declare function suppressionOf(candidate: NotifyCandidate, policy: QuietPolicy, options?: {
    readonly utcOffsetMinutes?: number;
}): string | undefined;
/**
 * Decide which candidates to raise.
 *
 * `alreadyRaised` makes the decision idempotent: re-running the policy over the
 * same events cannot notify twice, which matters because the task system may
 * report a terminal state more than once during recovery.
 */
export declare function selectNotifications(candidates: readonly NotifyCandidate[], policy: QuietPolicy, alreadyRaised: ReadonlySet<string>, options?: {
    readonly utcOffsetMinutes?: number;
}): readonly NotifyCandidate[];
