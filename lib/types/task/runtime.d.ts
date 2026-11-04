/** Task delegation runtime: state machine, leases, worker slots, budget, recovery, retry. */
import type { AssignResult, CreateTaskInput, CreateTaskResult, DelegateConfig, DshContextLike, PanelTask, SessionControllerLike, TaskAttention, TaskControlInput, TaskCreateOptions, TaskInput, TaskRecord, TaskReportInput, TaskService, TaskView } from '../types.js';
import type { OneStore } from '../store/store.js';
import type { OneCore } from '../core/registry.js';
export interface TaskRuntimeHooks {
    readonly now?: () => number;
}
export type CreateTaskOptions = TaskCreateOptions;
type Listener = () => void;
/** The task service other rows and the panel read. */
export type TaskRuntimeService = TaskService;
export declare class TaskRuntime implements TaskService {
    readonly mode: 'observe' | 'active';
    private readonly ctx;
    private readonly config;
    private readonly store;
    private readonly core;
    private readonly now;
    private readonly listeners;
    private chain;
    private pumping;
    constructor(ctx: DshContextLike, config: DelegateConfig, store: OneStore, core: OneCore, hooks?: TaskRuntimeHooks);
    get controller(): SessionControllerLike | undefined;
    /** Recover interrupted assignments and leases once the host has settled. */
    start(): Promise<void>;
    /** Create one task. Agent-initiated tools observe by default. */
    createTask(input: CreateTaskInput, options: CreateTaskOptions): Promise<CreateTaskResult>;
    /** Make one task eligible and try to start it immediately. */
    assign(taskId: string, options?: {
        callerSessionId?: string;
    }): Promise<AssignResult>;
    /** Pump the queue: start as many eligible tasks as the slot and lease rules allow. */
    pump(): Promise<void>;
    /** Refresh active leases and retry lease-blocked queue entries. */
    heartbeat(): Promise<void>;
    getTask(taskId: string): TaskRecord | undefined;
    listTasks(): TaskRecord[];
    listViews(): TaskView[];
    /** Structured worker report; `reportId` is the idempotency key. */
    report(input: TaskReportInput): Promise<TaskRecord>;
    /** Human control over a task: complete, cancel, retry, or release a stuck lease. */
    control(input: TaskControlInput): Promise<TaskRecord>;
    /** Append a policy-change input and deliver it to the running worker when present. */
    addInput(taskId: string, text: string, kind: TaskInput['kind']): Promise<TaskRecord>;
    /** Force a task into blocked with an attention row (mandate/policy failures). */
    blockTask(taskId: string, reason: string, kind?: TaskAttention['kind']): Promise<TaskRecord>;
    /** Session event feed from the host. */
    handleSessionEvent(session: {
        readonly id?: string;
    } | undefined, event: unknown): void;
    snapshot(): {
        attention: PanelTask[];
        running: PanelTask[];
        history: PanelTask[];
    };
    health(): {
        leases: number;
        workers: number;
        maxWorkers: number;
    };
    subscribe(listener: Listener): () => void;
    private emit;
    private enqueue;
    /** Queue pump. Returns why no assignment started when the target task did not. */
    private pumpInternal;
    private startTask;
    private deliverInput;
    private resolveAgent;
    private applyWorkerComposition;
    private onTurnEnd;
    private accumulateUsage;
    private failTask;
    private failAssignment;
    private cancelAgent;
    private leaseConflict;
    private acquireLease;
    private releaseLease;
    private releaseLeasesForTask;
    private touchLease;
    private expireLeases;
    private resolveWorkspace;
    private requireTask;
    private placeholder;
    private workText;
    private recoveryText;
}
export {};
