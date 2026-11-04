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
/** The conservative default: audible for results and blocks, silent for noise. */
export const DEFAULT_QUIET_POLICY = {
    muted: false,
    breakthrough: ['needs-you', 'failed'],
};
/** Minutes since local midnight for one timestamp, in the given timezone offset. */
export function localMinuteOfDay(at, utcOffsetMinutes = 0) {
    const shifted = at + utcOffsetMinutes * 60_000;
    const dayMs = 24 * 60 * 60_000;
    const within = ((shifted % dayMs) + dayMs) % dayMs;
    return Math.floor(within / 60_000);
}
/** Whether `minute` falls inside a possibly-wrapping quiet window. */
export function inQuietHours(minute, from, to) {
    if (from === to)
        return false;
    return from < to
        ? minute >= from && minute < to
        : minute >= from || minute < to;
}
/** Why one candidate was suppressed, or `undefined` when it should be raised. */
export function suppressionOf(candidate, policy, options = {}) {
    const { quietFrom, quietTo } = policy;
    if (quietFrom !== undefined && quietTo !== undefined) {
        const minute = localMinuteOfDay(candidate.at, options.utcOffsetMinutes ?? 0);
        // A blocked task is the one thing worth waking someone for; a finished
        // plan can wait until morning.
        if (inQuietHours(minute, quietFrom, quietTo) && candidate.reason !== 'needs-you') {
            return 'quiet hours';
        }
    }
    if (policy.muted) {
        return policy.breakthrough.includes(candidate.reason) ? undefined : 'muted';
    }
    return undefined;
}
/**
 * Decide which candidates to raise.
 *
 * `alreadyRaised` makes the decision idempotent: re-running the policy over the
 * same events cannot notify twice, which matters because the task system may
 * report a terminal state more than once during recovery.
 */
export function selectNotifications(candidates, policy, alreadyRaised, options = {}) {
    const chosen = [];
    const seen = new Set(alreadyRaised);
    for (const candidate of candidates) {
        if (seen.has(candidate.key))
            continue;
        if (suppressionOf(candidate, policy, options) !== undefined)
            continue;
        seen.add(candidate.key);
        chosen.push(candidate);
    }
    return chosen;
}
/**
 * Turn one finished assist run into notification candidates.
 *
 * Deliberately produces at most one candidate: a run is one thing the user
 * asked about, so it earns one message, not one per task.
 */
export function candidatesFromOutcome(outcome, at, key) {
    const reason = outcome.status === 'completed'
        ? 'done'
        : outcome.blocked.length > 0
            ? 'needs-you'
            : 'failed';
    return [{
            reason,
            key: `${key}:${outcome.status}`,
            title: reason === 'done'
                ? '计划已完成'
                : reason === 'needs-you'
                    ? '需要你决定'
                    : '计划没跑成',
            detail: outcome.detail,
            at,
        }];
}
