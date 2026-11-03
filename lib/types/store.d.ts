/** Durable state for dsh-one, backed by `ctx.storageDomain` with an in-memory fallback. */
import { z } from 'zod';
import type { DshContextLike, AuditRecord, ManagedSessionRecord, OneConfig, OutboxRecord } from './types.js';
/** Domain declaration consumed by `ctx.storageDomain.open`. */
export declare const oneDomainSpec: {
    readonly name: "dsh-one";
    readonly version: 1;
    readonly tables: {
        readonly sessions: {
            readonly valueSchema: z.ZodObject<{
                sessionId: z.ZodString;
                title: z.ZodOptional<z.ZodString>;
                workspaceId: z.ZodOptional<z.ZodString>;
                cwd: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodObject<{
                    provider: z.ZodString;
                    model: z.ZodString;
                    reasoningEffort: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>;
                status: z.ZodEnum<{
                    error: "error";
                    active: "active";
                    missing: "missing";
                }>;
                trusted: z.ZodBoolean;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
                lastSeenAt: z.ZodOptional<z.ZodNumber>;
                error: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        };
        readonly outbox: {
            readonly valueSchema: z.ZodObject<{
                requestId: z.ZodString;
                callerSessionId: z.ZodOptional<z.ZodString>;
                targetSessionId: z.ZodString;
                text: z.ZodString;
                mode: z.ZodEnum<{
                    queue: "queue";
                    steer: "steer";
                }>;
                source: z.ZodEnum<{
                    tool: "tool";
                    command: "command";
                }>;
                status: z.ZodEnum<{
                    pending: "pending";
                    sending: "sending";
                    sent: "sent";
                    observed: "observed";
                    failed: "failed";
                    unknown: "unknown";
                    cancelled: "cancelled";
                }>;
                attempts: z.ZodNumber;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
                completedAt: z.ZodOptional<z.ZodNumber>;
                error: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        };
        readonly audit: {
            readonly valueSchema: z.ZodObject<{
                id: z.ZodString;
                at: z.ZodNumber;
                action: z.ZodString;
                actorSessionId: z.ZodOptional<z.ZodString>;
                targetSessionId: z.ZodOptional<z.ZodString>;
                requestId: z.ZodOptional<z.ZodString>;
                outcome: z.ZodEnum<{
                    error: "error";
                    observed: "observed";
                    ok: "ok";
                }>;
                detail: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        };
    };
};
/** One opened storage surface. */
export declare class OneStore {
    readonly degraded: boolean;
    private readonly sessions;
    private readonly outbox;
    private readonly audits;
    private readonly domain;
    private constructor();
    /**
     * Open the `dsh-one` domain when the host provides `ctx.storageDomain`.
     * A host without that service keeps working in memory for one process;
     * the degradation is reported by `one_sessions`.
     */
    static open(ctx: DshContextLike, config: OneConfig): Promise<OneStore>;
    getSession(sessionId: string): ManagedSessionRecord | undefined;
    listSessions(): ManagedSessionRecord[];
    putSession(record: ManagedSessionRecord): Promise<void>;
    getOutbox(requestId: string): OutboxRecord | undefined;
    listOutbox(): OutboxRecord[];
    putOutbox(record: OutboxRecord): Promise<void>;
    listAudit(limit?: number): AuditRecord[];
    appendAudit(record: AuditRecord, limit: number): Promise<void>;
    private trimAudit;
    /**
     * A `sending` row interrupted by a process stop has an unknown outcome.
     * Keep it visible and never silently retry: the caller must use a fresh
     * request id after checking the target session.
     */
    private recoverInterruptedSends;
    close(): Promise<void>;
}
