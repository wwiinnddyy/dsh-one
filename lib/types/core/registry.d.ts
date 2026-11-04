/** dsh-one core: registry, access policy, outbox, audit, and host adapters. */
import type { AgentLike, AuditRecord, DshContextLike, ManagedSessionRecord, OneConfig, OutboxRecord, SelectModelInput, SelectModelResult, SendInput, SendResult, SessionView } from '../types.js';
import { OneStore } from '../store/store.js';
export interface OneCoreHooks {
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
/** Process-local, in-process implementation behind commands and tools. */
export declare class OneCore {
    private readonly ctx;
    private readonly store;
    private readonly config;
    private readonly now;
    private readonly sleeper;
    private readonly inflight;
    private startError;
    private reconciledAt;
    private starting;
    constructor(ctx: DshContextLike, config: OneConfig, store: OneStore, hooks?: OneCoreHooks);
    private get controller();
    /**
     * Reconcile the registry once the host has settled its Session service.
     * The service may appear after this plugin row activates, so the caller
     * invokes this again from `ctx.inject(['sessionController'], ...)`.
     */
    start(): Promise<void>;
    get degraded(): boolean;
    get lastError(): string | undefined;
    get lastReconciledAt(): number | undefined;
    /**
     * Compare registered sessions with `session/list`. A missing registration
     * is created only when `allowSessionCreation` is on; otherwise it stays
     * visible as `missing`.
     */
    reconcile(): Promise<void>;
    /** List registered sessions plus the host's current session list. */
    listSessions(): Promise<{
        items: SessionView[];
        degraded: boolean;
        reconciledAt?: number;
        error?: string;
    }>;
    /**
     * Explicitly register one session for cross-session operations. This is a
     * human command path; tools cannot call it.
     */
    registerSession(input: {
        sessionId: string;
        workspaceId?: string;
        cwd?: string;
        title?: string;
    }): Promise<ManagedSessionRecord>;
    /**
     * Register a session this plugin created for a worker as trusted. Workers
     * are ordinary sessions; automatic registration keeps the default
     * allowlist posture without requiring a human `/one sessions add`.
     */
    trustWorkerSession(input: {
        sessionId: string;
        cwd?: string;
        title?: string;
    }): Promise<ManagedSessionRecord>;
    get storeRef(): OneStore;
    /** Whether a workspace is inside the configured allowlist (an empty list allows all). */
    isWorkspaceAllowed(cwd: string): boolean;
    /** Send a user message to another ordinary session, with retries and idempotency. */
    send(input: SendInput): Promise<SendResult>;
    private executeSend;
    /** Select a model for one session, with catalog validation and a fallback route. */
    selectModel(input: SelectModelInput): Promise<SelectModelResult>;
    getOutbox(requestId: string): OutboxRecord;
    listAudit(limit?: number): AuditRecord[];
    dispose(): Promise<void>;
    private requireController;
    private timedSignal;
    private combineSignal;
    private assertSessionId;
    private assertWorkspaceAllowed;
    private resolveTarget;
    private isSubagent;
    private assertOperable;
    private viewFromSummary;
    private viewFromRecord;
    private resultOf;
    /**
     * Whether the host still lists one ordinary session. Used before returning a
     * stored assistant session id, because opening an id the host dropped shows an
     * empty conversation instead of failing loudly.
     */
    sessionExists(sessionId: string): Promise<boolean>;
    /**
     * Create the assistant's own session.
     *
     * The assistant is an ordinary DSH session, not a private chat surface: it is
     * created through the same controller every other session uses, so the
     * conversation, history, model selection, and tool access all behave normally.
     * The host assigns the id; the title is only a label for the session list.
     */
    createAssistantSession(title: string): Promise<{
        readonly sessionId: string;
    }>;
    /** Append one audit row. Shared by the core, task, and intake modules. */
    audit(input: {
        action: string;
        actorSessionId?: string;
        targetSessionId?: string;
        taskId?: string;
        requestId?: string;
        outcome: 'ok' | 'error' | 'observed';
        detail?: string;
    }): Promise<void>;
}
/** Resolve the agent's session id from the minimal Agent surface. */
export declare function agentSessionId(agent: AgentLike | undefined): string | undefined;
