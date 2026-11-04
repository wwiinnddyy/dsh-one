/** Intake runtime: trigger dedupe, gate, assessment, eval, mandate, decision, acceptance. */
import type { DecisionRecord, DispatchEvent, DshContextLike, IngressConfig, IntakePanelSnapshot, IntakeResult, IntakeService, PolicyRecord, TaskService, ThreadRecord } from '../types.js';
import type { OneStore } from '../store/store.js';
import type { OneCore } from '../core/registry.js';
export interface IntakeRuntimeOptions {
    readonly now?: () => number;
    readonly reply?: (thread: ThreadRecord, text: string, key: string) => Promise<void>;
    readonly poll?: (signal?: AbortSignal) => Promise<DispatchEvent[]>;
}
type Listener = () => void;
export declare class IntakeRuntime implements IntakeService {
    private readonly ctx;
    private readonly config;
    private readonly store;
    private readonly core;
    private readonly now;
    private readonly reply?;
    private readonly poller?;
    private readonly listeners;
    private chain;
    private lastPollAt;
    private lastError;
    private currentPolicy;
    constructor(ctx: DshContextLike, config: IngressConfig, store: OneStore, core: OneCore, options?: IntakeRuntimeOptions);
    get taskService(): TaskService | undefined;
    /** Install or refresh the policy, recover mandates, and finish queued evals. */
    start(): Promise<void>;
    handle(event: DispatchEvent): Promise<IntakeResult>;
    snapshot(): IntakePanelSnapshot;
    decisions(limit?: number): DecisionRecord[];
    policy(): PolicyRecord | undefined;
    health(): {
        acceptMode: IngressConfig['acceptMode'];
        policyVersion?: string;
        lastPollAt?: number;
        error?: string;
    };
    /** Run one poll pass through the configured source adapter. */
    pollNow(): Promise<number>;
    subscribe(listener: Listener): () => void;
    private emit;
    private enqueue;
    private handleInternal;
    private upsertThread;
    private gate;
    private settleEval;
    private recordDecision;
    private confirm;
    private assess;
    private rulesAssessment;
    private ensurePolicy;
    private onPolicyChanged;
    private reconcile;
    private processQueuedEvals;
    private requireTrigger;
    private requireThread;
    private goalText;
}
export {};
