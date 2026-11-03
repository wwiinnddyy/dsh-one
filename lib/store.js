/** Durable state for dsh-one, backed by `ctx.storageDomain` with an in-memory fallback. */
import { z } from 'zod';
const modelSelectionSchema = z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
});
const managedSessionSchema = z.object({
    sessionId: z.string(),
    title: z.string().optional(),
    workspaceId: z.string().optional(),
    cwd: z.string().optional(),
    model: modelSelectionSchema.optional(),
    status: z.enum(['active', 'missing', 'error']),
    trusted: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
});
const outboxSchema = z.object({
    requestId: z.string(),
    callerSessionId: z.string().optional(),
    targetSessionId: z.string(),
    text: z.string(),
    mode: z.enum(['queue', 'steer']),
    source: z.enum(['tool', 'command']),
    status: z.enum(['pending', 'sending', 'sent', 'observed', 'failed', 'unknown', 'cancelled']),
    attempts: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
});
const auditSchema = z.object({
    id: z.string(),
    at: z.number().int().nonnegative(),
    action: z.string(),
    actorSessionId: z.string().optional(),
    targetSessionId: z.string().optional(),
    requestId: z.string().optional(),
    outcome: z.enum(['ok', 'error', 'observed']),
    detail: z.string().optional(),
});
/** Domain declaration consumed by `ctx.storageDomain.open`. */
export const oneDomainSpec = {
    name: 'dsh-one',
    version: 1,
    tables: {
        sessions: { valueSchema: managedSessionSchema },
        outbox: { valueSchema: outboxSchema },
        audit: { valueSchema: auditSchema },
    },
};
class MemoryTable {
    records = new Map();
    get(key) {
        return this.records.get(key);
    }
    entries() {
        return [...this.records.entries()][Symbol.iterator]();
    }
    get size() {
        return this.records.size;
    }
    async put(key, value) {
        this.records.set(key, value);
    }
    async update(key, fn) {
        const current = this.records.get(key);
        if (current === undefined)
            throw new Error(`missing record "${key}"`);
        const next = fn(current);
        this.records.set(key, next);
        return next;
    }
    async delete(key) {
        return this.records.delete(key);
    }
}
/** One opened storage surface. */
export class OneStore {
    degraded;
    sessions;
    outbox;
    audits;
    domain;
    constructor(sessions, outbox, audits, domain, degraded) {
        this.sessions = sessions;
        this.outbox = outbox;
        this.audits = audits;
        this.domain = domain;
        this.degraded = degraded;
    }
    /**
     * Open the `dsh-one` domain when the host provides `ctx.storageDomain`.
     * A host without that service keeps working in memory for one process;
     * the degradation is reported by `one_sessions`.
     */
    static async open(ctx, config) {
        const facility = ctx.get('storageDomain');
        if (facility === undefined || typeof facility.open !== 'function') {
            return new OneStore(new MemoryTable(), new MemoryTable(), new MemoryTable(), undefined, true);
        }
        const domain = await facility.open(oneDomainSpec);
        const store = new OneStore(domain.table('sessions'), domain.table('outbox'), domain.table('audit'), domain, false);
        await store.recoverInterruptedSends();
        await store.trimAudit(config.auditLimit);
        return store;
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    listSessions() {
        return [...this.sessions.entries()].map(([, record]) => record);
    }
    async putSession(record) {
        await this.sessions.put(record.sessionId, record);
    }
    getOutbox(requestId) {
        return this.outbox.get(requestId);
    }
    listOutbox() {
        return [...this.outbox.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt);
    }
    async putOutbox(record) {
        await this.outbox.put(record.requestId, record);
    }
    listAudit(limit = 50) {
        return [...this.audits.entries()]
            .map(([, record]) => record)
            .sort((a, b) => b.at - a.at)
            .slice(0, limit);
    }
    async appendAudit(record, limit) {
        await this.audits.put(record.id, record);
        await this.trimAudit(limit);
    }
    async trimAudit(limit) {
        if (this.audits.size <= limit)
            return;
        const sorted = [...this.audits.entries()]
            .map(([key, record]) => ({ key, at: record.at }))
            .sort((a, b) => a.at - b.at);
        const excess = this.audits.size - limit;
        for (const row of sorted.slice(0, excess)) {
            await this.audits.delete(row.key);
        }
    }
    /**
     * A `sending` row interrupted by a process stop has an unknown outcome.
     * Keep it visible and never silently retry: the caller must use a fresh
     * request id after checking the target session.
     */
    async recoverInterruptedSends() {
        for (const record of this.listOutbox()) {
            if (record.status !== 'sending')
                continue;
            await this.putOutbox({
                ...record,
                status: 'unknown',
                updatedAt: Date.now(),
                error: 'process stopped while the send was in flight; outcome is unknown',
            });
        }
    }
    async close() {
        if (this.domain !== undefined)
            await this.domain.close();
    }
}
