/** dsh-one core: registry, access policy, outbox, audit, and host adapters. */
import type { AgentLike, AuditRecord, DshContextLike, ManagedSessionRecord, OneConfig, OutboxRecord, SelectModelInput, SelectModelResult, SendInput, SendResult, SessionView } from '../types.js';
import { OneStore } from '../store/store.js';
import type { WorkspaceOverview } from './workspaces.js';
/** Directory name the assistant owns under the configured home root. */
export declare const ASSISTANT_HOME_DIRNAME = "super-mind";
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
     * Whether a stored assistant session can be reopened as-is.
     *
     * It must exist, be an ordinary session, and already carry a `cwd` that lies
     * inside the assistant home. A session created before the home existed has no
     * `cwd`, belongs to no Workspace, and would make the client prompt for one, so
     * it is not reusable and is rebuilt on the next open.
     */
    assistantSessionReusable(sessionId: string, home: string): Promise<boolean>;
    /** Whether the host still lists one ordinary session. */
    sessionExists(sessionId: string): Promise<boolean>;
    /**
     * Resolve the assistant's home directory, creating it when absent.
     *
     * The assistant must own a directory because a Session without a `cwd`
     * belongs to no Workspace, and the DSH client then forces the user to pick
     * one before it will open the conversation. Preferences win, so a deployment
     * can keep the assistant anywhere; the default is `<dsh home>/super-mind`.
     */
    resolveAssistantHome(preferred?: string): Promise<string>;
    /**
     * Create the assistant's own session.
     *
     * The assistant is an ordinary DSH session, not a private chat surface: it is
     * created through the same controller every other session uses, so the
     * conversation, history, model selection, and tool access all behave normally.
     * It carries a `cwd` so the client can group it under a Workspace and open it
     * without prompting for one.
     */
    createAssistantSession(home: string, title: string): Promise<{
        readonly sessionId: string;
    }>;
    /**
     * Make the assistant introduce itself in its own conversation.
     *
     * An empty Session looks exactly like a new chat, which is indistinguishable
     * from "the plugin did nothing". One queued user-role kickoff inside the
     * assistant's own Session makes the assistant answer with its identity, so the
     * first thing the user sees is a conversation that has already started.
     *
     * Failure is swallowed on purpose: a greeting is a nicety, and a Host that
     * refuses the prompt must not stop the entry from opening.
     */
    greetAssistantSession(sessionId: string, displayName: string): Promise<void>;
    /**
     * The cross-Workspace picture the assistant reasons over.
     *
     * Derived on every call from the Host's own session list plus this plugin's
     * outbox, so it never drifts from what the Host believes.
     */
    workspaceOverview(): Promise<WorkspaceOverview>;
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
