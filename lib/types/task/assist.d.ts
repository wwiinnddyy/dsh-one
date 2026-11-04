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
export type AssistStatus = 'completed' | 'failed' | 'blocked' | 'partial' | 'exhausted' | 'cancelled';
/** One task the coordinator decided to create. */
export interface AssistStep {
    readonly title: string;
    readonly goal: string;
    readonly cwd?: string;
    readonly priority?: number;
}
/** Limits that keep one run from running away. */
export interface AssistLimits {
    /** Maximum poll rounds before the run is declared exhausted. */
    readonly maxRounds: number;
    /** Maximum tasks one run may create. */
    readonly maxTasks: number;
    /** Wall-clock deadline in milliseconds. */
    readonly deadlineMs: number;
    /** Delay between polls in milliseconds; zero means no sleeping. */
    readonly pollIntervalMs: number;
}
/** The conservative default a deployment can override. */
export declare const DEFAULT_ASSIST_LIMITS: AssistLimits;
/** Why a run ended, in a form that can be shown to a person. */
export interface AssistOutcome {
    readonly status: AssistStatus;
    readonly rounds: number;
    readonly createdTasks: readonly string[];
    readonly completed: readonly string[];
    readonly failed: readonly string[];
    readonly blocked: readonly string[];
    readonly detail: string;
}
/** The task surface the loop needs; a narrow slice of `TaskService`. */
export interface AssistTaskPort {
    createTask(input: {
        readonly title: string;
        readonly goal: string;
        readonly cwd?: string;
        readonly priority?: number;
    }, options: {
        readonly origin?: 'agent' | 'human';
        readonly createdBy?: string;
    }): Promise<{
        readonly task: {
            readonly id: string;
            readonly status: string;
        };
    }>;
    assign(taskId: string, options?: {
        readonly callerSessionId?: string;
    }): Promise<{
        readonly started: boolean;
    }>;
    getTask(taskId: string): {
        readonly id: string;
        readonly status: string;
    } | undefined;
}
/** Clamp a caller-supplied limit into a range that cannot be absurd. */
export declare function normalizeLimits(partial?: Partial<AssistLimits>): AssistLimits;
/**
 * Build the plan for one goal.
 *
 * The plan is derived from the goal text rather than invented by a model here:
 * the coordinator's job in this build is to run the loop reliably, and a
 * deterministic plan is what makes the loop testable. A model-authored plan
 * plugs in at this seam later without touching the loop.
 */
export declare function planSteps(goal: string, requested?: readonly AssistStep[]): readonly AssistStep[];
export interface RunAssistInput {
    readonly goal: string;
    readonly steps?: readonly AssistStep[];
    readonly limits?: Partial<AssistLimits>;
    readonly callerSessionId?: string;
    /** Injected so tests can run the loop without real time passing. */
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly signal?: AbortSignal;
}
/**
 * Run one bounded plan.
 *
 * Returns only after every task is terminal or a limit stopped the run, so the
 * caller never has to guess whether work is still in flight.
 */
export declare function runAssist(port: AssistTaskPort, input: RunAssistInput): Promise<AssistOutcome>;
