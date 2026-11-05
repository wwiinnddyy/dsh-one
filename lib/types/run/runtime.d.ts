/**
 * Durable, host-side coordinator for one goal.
 *
 * The assistant session is the Router: it plans a goal into steps and calls
 * `one_run_start`, which returns immediately (async ReAct). Workers run the
 * steps through the existing `TaskRuntime`, and this runtime watches their
 * transitions, records user-facing activity, and wakes the assistant only when
 * a person must decide or the goal settled.
 *
 * It deliberately owns no task semantics: slots, leases, budgets, reports,
 * retries and recovery stay in `TaskRuntime`.
 */
import type { DelegateConfig, DshContextLike, RunActivityRecord, RunControlInput, RunService, RunStartInput, RunStartResult, RunSummary, RunView, TaskService } from '../types.js';
import type { OneStore } from '../store/store.js';
import type { OneCore } from '../core/registry.js';
import type { SettingsService } from '../core/settings.js';
import type { AssistantChannel } from '../channel/types.js';
/** The subset of settings a run needs. `SettingsService` satisfies it. */
export interface RunSettings {
    displayName(): string;
    assistantSessionId(): string | undefined;
    notifyMuted(): boolean;
    quietHours(): {
        readonly from?: number;
        readonly to?: number;
    };
    runsPaused(): boolean;
}
export interface RunRuntimeHooks {
    readonly now?: () => number;
    /** Defaults to the chat channel; an IM adapter can replace it later. */
    readonly channel?: AssistantChannel;
}
export declare class RunRuntime implements RunService {
    readonly mode: 'execute' | 'observe';
    private readonly ctx;
    private readonly config;
    private readonly store;
    private readonly core;
    private readonly tasks;
    private readonly settings;
    private readonly now;
    private readonly channel;
    private readonly listeners;
    private readonly dispatchInflight;
    private timer;
    private coalesceTimer;
    private ticking;
    private pendingTick;
    private disposed;
    constructor(ctx: DshContextLike, config: DelegateConfig, store: OneStore, core: OneCore, tasks: TaskService, settings?: SettingsService | RunSettings, hooks?: RunRuntimeHooks);
    /** Reattach interrupted runs, then start the watchdog. */
    open(): Promise<void>;
    dispose(): void;
    /** Create one run and return as soon as its steps are dispatched. */
    start(input: RunStartInput): Promise<RunStartResult>;
    get(runId: string): RunView | undefined;
    list(): RunView[];
    summary(): RunSummary;
    activities(runId?: string, limit?: number): RunActivityRecord[];
    control(input: RunControlInput): Promise<RunView>;
    subscribe(listener: () => void): () => void;
    /** Coalesce a burst of task changes into one decision. */
    scheduleTick(): void;
    /** Project every live run, enforce deadlines, and decide whether to speak. */
    tick(): Promise<void>;
    private expire;
    private project;
    private redispatch;
    /** Start a queued step without awaiting the dispatch chain. */
    private dispatch;
    private maybeWake;
    private deliverWake;
    private wakeText;
    private appendActivity;
    private view;
    private plan;
    private modeOf;
    private taskOrigin;
    private ownerOf;
    private resolveCwd;
    private rebind;
    private emit;
}
