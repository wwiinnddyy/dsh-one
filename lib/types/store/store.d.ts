/** Durable state for dsh-one, backed by `ctx.storageDomain` with an in-memory fallback. */
import type { AuditRecord, CursorRecord, DecisionRecord, DeliveryRecord, DshContextLike, EvalRecord, LeaseRecord, MandateRecord, ManagedSessionRecord, OneConfig, OutboxRecord, PolicyRecord, ReportRecord, SettingRecord, SubscriptionRecord, TaskRecord, ThreadRecord, TriggerRecord } from '../types.js';
/** One opened storage surface over the shared `dsh-one` domain. */
export declare class OneStore {
    readonly degraded: boolean;
    private readonly domain;
    private readonly sessionsTable;
    private readonly outboxTable;
    private readonly auditTable;
    private readonly taskTable;
    private readonly leaseTable;
    private readonly reportTable;
    private readonly triggerTable;
    private readonly threadTable;
    private readonly evalTable;
    private readonly decisionTable;
    private readonly policyTable;
    private readonly mandateTable;
    private readonly deliveryTable;
    private readonly cursorTable;
    private readonly subscriptionTable;
    private readonly settingTable;
    private readonly config;
    private constructor();
    /** Build one store; the caller owns recovery and lifecycle. */
    static create(ctx: DshContextLike, config: OneConfig): Promise<OneStore>;
    getSession(sessionId: string): ManagedSessionRecord | undefined;
    listSessions(): ManagedSessionRecord[];
    putSession(record: ManagedSessionRecord): Promise<void>;
    getOutbox(requestId: string): OutboxRecord | undefined;
    listOutbox(): OutboxRecord[];
    putOutbox(record: OutboxRecord): Promise<void>;
    listAudit(limit?: number): AuditRecord[];
    appendAudit(record: AuditRecord, limit: number): Promise<void>;
    private trimAudit;
    getTask(taskId: string): TaskRecord | undefined;
    listTasks(): TaskRecord[];
    putTask(task: TaskRecord): Promise<void>;
    /** Single-key atomic read-modify-write for every task transition. */
    updateTask(taskId: string, fn: (current: TaskRecord) => TaskRecord): Promise<TaskRecord>;
    getLease(leaseId: string): LeaseRecord | undefined;
    listLeases(): LeaseRecord[];
    putLease(lease: LeaseRecord): Promise<void>;
    getReport(taskId: string, reportId: string): ReportRecord | undefined;
    listReports(taskId?: string): ReportRecord[];
    putReport(report: ReportRecord): Promise<void>;
    getTrigger(id: string): TriggerRecord | undefined;
    listTriggers(limit?: number): TriggerRecord[];
    putTrigger(record: TriggerRecord): Promise<void>;
    getThread(id: string): ThreadRecord | undefined;
    listThreads(): ThreadRecord[];
    putThread(record: ThreadRecord): Promise<void>;
    getEval(id: string): EvalRecord | undefined;
    listEvals(): EvalRecord[];
    putEval(record: EvalRecord): Promise<void>;
    getDecision(id: string): DecisionRecord | undefined;
    listDecisions(limit?: number): DecisionRecord[];
    putDecision(record: DecisionRecord): Promise<void>;
    getPolicy(version: string): PolicyRecord | undefined;
    listPolicies(): PolicyRecord[];
    putPolicy(record: PolicyRecord): Promise<void>;
    getMandate(id: string): MandateRecord | undefined;
    listMandates(): MandateRecord[];
    /** Mandates are immutable: only first insert is allowed. */
    putMandateOnce(record: MandateRecord): Promise<boolean>;
    getDelivery(id: string): DeliveryRecord | undefined;
    putDelivery(record: DeliveryRecord): Promise<void>;
    listDeliveries(limit?: number): DeliveryRecord[];
    getCursor(id: string): CursorRecord | undefined;
    putCursor(record: CursorRecord): Promise<void>;
    getSubscription(id: string): SubscriptionRecord | undefined;
    putSubscription(record: SubscriptionRecord): Promise<void>;
    /**
     * One preference row; `namespace` scopes the key to its owning surface.
     *
     * The composite key is joined with `_`, not `:` or `.`: a per-record backend
     * writes each key as a path segment and accepts only `[a-zA-Z0-9_-]+`, so
     * the separator must satisfy that class rather than merely read well.
     */
    getSetting(namespace: string, key: string): SettingRecord | undefined;
    listSettings(namespace?: string): SettingRecord[];
    putSetting(record: SettingRecord): Promise<void>;
    deleteSetting(namespace: string, key: string): Promise<boolean>;
    /** Current active policy (the newest non-superseded record). */
    activePolicy(): PolicyRecord | undefined;
    /** A `sending` row interrupted by a process stop has an unknown outcome. */
    private recover;
    close(): Promise<void>;
}
/** A fresh empty usage accumulator. */
export declare const emptyUsage: () => TaskRecord["usage"];
