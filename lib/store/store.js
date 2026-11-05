/** Durable state for dsh-one, backed by `ctx.storageDomain` with an in-memory fallback. */
import { oneDomainSpec } from './spec.js';
const EMPTY_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    lastUsageSeq: -1,
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
/** Path-safe table key for one preference row (`[a-zA-Z0-9_-]+`). */
function settingId(namespace, key) {
    return `${namespace}_${key}`;
}
/** One opened storage surface over the shared `dsh-one` domain. */
export class OneStore {
    degraded;
    domain;
    sessionsTable;
    outboxTable;
    auditTable;
    taskTable;
    leaseTable;
    reportTable;
    triggerTable;
    threadTable;
    evalTable;
    decisionTable;
    policyTable;
    mandateTable;
    deliveryTable;
    cursorTable;
    subscriptionTable;
    settingTable;
    runTable;
    runActivityTable;
    runWakeTable;
    config;
    constructor(config, domain, degraded) {
        this.config = config;
        this.domain = domain;
        this.degraded = degraded;
        const table = (name, memory) => domain === undefined ? memory : domain.table(name);
        this.sessionsTable = table('sessions', new MemoryTable());
        this.outboxTable = table('outbox', new MemoryTable());
        this.auditTable = table('audit', new MemoryTable());
        this.taskTable = table('tasks', new MemoryTable());
        this.leaseTable = table('leases', new MemoryTable());
        this.reportTable = table('reports', new MemoryTable());
        this.triggerTable = table('triggers', new MemoryTable());
        this.threadTable = table('threads', new MemoryTable());
        this.evalTable = table('evals', new MemoryTable());
        this.decisionTable = table('decisions', new MemoryTable());
        this.policyTable = table('policies', new MemoryTable());
        this.mandateTable = table('mandates', new MemoryTable());
        this.deliveryTable = table('deliveries', new MemoryTable());
        this.cursorTable = table('cursors', new MemoryTable());
        this.subscriptionTable = table('subscriptions', new MemoryTable());
        this.settingTable = table('settings', new MemoryTable());
        this.runTable = table('runs', new MemoryTable());
        this.runActivityTable = table('run_activities', new MemoryTable());
        this.runWakeTable = table('run_wakes', new MemoryTable());
    }
    /** Build one store; the caller owns recovery and lifecycle. */
    static async create(ctx, config) {
        const facility = ctx.get('storageDomain');
        if (facility === undefined || typeof facility.open !== 'function') {
            const memory = new OneStore(config, undefined, true);
            await memory.recover();
            return memory;
        }
        let domain;
        try {
            domain = await facility.open(oneDomainSpec);
        }
        catch (error) {
            const existing = typeof facility.get === 'function' ? facility.get('dsh_one') : undefined;
            if (existing === undefined)
                throw error;
            domain = existing;
        }
        const store = new OneStore(config, domain, false);
        await store.recover();
        return store;
    }
    // ---- sessions -----------------------------------------------------------------
    getSession(sessionId) { return this.sessionsTable.get(sessionId); }
    listSessions() { return [...this.sessionsTable.entries()].map(([, record]) => record); }
    async putSession(record) { await this.sessionsTable.put(record.sessionId, record); }
    // ---- outbox -------------------------------------------------------------------
    getOutbox(requestId) { return this.outboxTable.get(requestId); }
    listOutbox() {
        return [...this.outboxTable.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt);
    }
    async putOutbox(record) { await this.outboxTable.put(record.requestId, record); }
    // ---- audit --------------------------------------------------------------------
    listAudit(limit = 50) {
        return [...this.auditTable.entries()]
            .map(([, record]) => record)
            .sort((a, b) => b.at - a.at)
            .slice(0, limit);
    }
    async appendAudit(record, limit) {
        await this.auditTable.put(record.id, record);
        await this.trimAudit(limit);
    }
    async trimAudit(limit) {
        if (this.auditTable.size <= limit)
            return;
        const sorted = [...this.auditTable.entries()]
            .map(([key, record]) => ({ key, at: record.at }))
            .sort((a, b) => a.at - b.at);
        const excess = this.auditTable.size - limit;
        for (const row of sorted.slice(0, excess))
            await this.auditTable.delete(row.key);
    }
    // ---- tasks --------------------------------------------------------------------
    getTask(taskId) { return this.taskTable.get(taskId); }
    listTasks() {
        return [...this.taskTable.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt);
    }
    async putTask(task) { await this.taskTable.put(task.taskId, task); }
    /** Single-key atomic read-modify-write for every task transition. */
    async updateTask(taskId, fn) {
        return await this.taskTable.update(taskId, fn);
    }
    // ---- leases -------------------------------------------------------------------
    getLease(leaseId) { return this.leaseTable.get(leaseId); }
    listLeases() { return [...this.leaseTable.entries()].map(([, record]) => record); }
    async putLease(lease) { await this.leaseTable.put(lease.leaseId, lease); }
    // ---- reports ------------------------------------------------------------------
    getReport(taskId, reportId) {
        return this.reportTable.get(`${taskId}:${reportId}`);
    }
    listReports(taskId) {
        const rows = [...this.reportTable.entries()].map(([, record]) => record);
        return (taskId === undefined ? rows : rows.filter(row => row.taskId === taskId)).sort((a, b) => a.createdAt - b.createdAt);
    }
    async putReport(report) {
        await this.reportTable.put(`${report.taskId}:${report.reportId}`, report);
    }
    // ---- intake -------------------------------------------------------------------
    getTrigger(id) { return this.triggerTable.get(id); }
    listTriggers(limit = 100) {
        return [...this.triggerTable.entries()].map(([, record]) => record).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit);
    }
    async putTrigger(record) { await this.triggerTable.put(record.triggerId, record); }
    getThread(id) { return this.threadTable.get(id); }
    listThreads() { return [...this.threadTable.entries()].map(([, record]) => record); }
    async putThread(record) { await this.threadTable.put(record.threadId, record); }
    getEval(id) { return this.evalTable.get(id); }
    listEvals() { return [...this.evalTable.entries()].map(([, record]) => record); }
    async putEval(record) { await this.evalTable.put(record.evalId, record); }
    getDecision(id) { return this.decisionTable.get(id); }
    listDecisions(limit = 50) {
        return [...this.decisionTable.entries()].map(([, record]) => record).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }
    async putDecision(record) { await this.decisionTable.put(record.decisionId, record); }
    getPolicy(version) { return this.policyTable.get(version); }
    listPolicies() { return [...this.policyTable.entries()].map(([, record]) => record); }
    async putPolicy(record) { await this.policyTable.put(record.version, record); }
    getMandate(id) { return this.mandateTable.get(id); }
    listMandates() { return [...this.mandateTable.entries()].map(([, record]) => record); }
    /** Mandates are immutable: only first insert is allowed. */
    async putMandateOnce(record) {
        if (this.mandateTable.get(record.mandateId) !== undefined)
            return false;
        await this.mandateTable.put(record.mandateId, record);
        return true;
    }
    getDelivery(id) { return this.deliveryTable.get(id); }
    async putDelivery(record) { await this.deliveryTable.put(record.deliveryId, record); }
    listDeliveries(limit = 50) {
        return [...this.deliveryTable.entries()].map(([, record]) => record).sort((a, b) => b.at - a.at).slice(0, limit);
    }
    getCursor(id) { return this.cursorTable.get(id); }
    async putCursor(record) { await this.cursorTable.put(record.cursorId, record); }
    getSubscription(id) { return this.subscriptionTable.get(id); }
    async putSubscription(record) {
        await this.subscriptionTable.put(record.subscriptionId, record);
    }
    // ---- runs ---------------------------------------------------------------------
    getRun(runId) { return this.runTable.get(runId); }
    listRuns() {
        return [...this.runTable.entries()].map(([, record]) => record).sort((a, b) => b.createdAt - a.createdAt);
    }
    async putRun(record) { await this.runTable.put(record.runId, record); }
    /** Single-key atomic read-modify-write for every run transition. */
    async updateRun(runId, fn) {
        return await this.runTable.update(runId, fn);
    }
    getRunActivity(activityId) {
        return this.runActivityTable.get(activityId);
    }
    listRunActivities(runId, limit = 200) {
        const rows = [...this.runActivityTable.entries()]
            .map(([, record]) => record)
            .filter(record => runId === undefined || record.runId === runId);
        return rows.sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, limit);
    }
    async appendRunActivity(record) {
        await this.runActivityTable.put(record.activityId, record);
        await this.trimRunActivities(record.runId);
    }
    async trimRunActivities(runId) {
        const rows = [...this.runActivityTable.entries()].map(([key, record]) => ({ key, record }));
        const perRun = rows.filter(row => row.record.runId === runId).sort((a, b) => a.record.at - b.record.at);
        for (const row of perRun.slice(0, Math.max(0, perRun.length - 200)))
            await this.runActivityTable.delete(row.key);
        if (rows.length <= 2_000)
            return;
        const oldest = rows.sort((a, b) => a.record.at - b.record.at);
        for (const row of oldest.slice(0, rows.length - 2_000))
            await this.runActivityTable.delete(row.key);
    }
    getRunWake(wakeId) { return this.runWakeTable.get(wakeId); }
    async putRunWake(record) { await this.runWakeTable.put(record.wakeId, record); }
    // ---- settings -----------------------------------------------------------------
    /**
     * One preference row; `namespace` scopes the key to its owning surface.
     *
     * The composite key is joined with `_`, not `:` or `.`: a per-record backend
     * writes each key as a path segment and accepts only `[a-zA-Z0-9_-]+`, so
     * the separator must satisfy that class rather than merely read well.
     */
    getSetting(namespace, key) {
        return this.settingTable.get(settingId(namespace, key));
    }
    listSettings(namespace) {
        const rows = [...this.settingTable.entries()].map(([, record]) => record);
        return (namespace === undefined ? rows : rows.filter(row => row.namespace === namespace))
            .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
    }
    async putSetting(record) {
        await this.settingTable.put(settingId(record.namespace, record.key), record);
    }
    async deleteSetting(namespace, key) {
        return await this.settingTable.delete(settingId(namespace, key));
    }
    /** Current active policy (the newest non-superseded record). */
    activePolicy() {
        return this.listPolicies()
            .filter(policy => policy.supersededBy === undefined)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
    }
    /** A `sending` row interrupted by a process stop has an unknown outcome. */
    async recover() {
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
        for (const [, wake] of this.runWakeTable.entries()) {
            if (wake.status !== 'sending' && wake.status !== 'pending')
                continue;
            await this.putRunWake({
                ...wake,
                status: 'unknown',
                updatedAt: Date.now(),
                error: 'process stopped while the wake was in flight; outcome is unknown',
            });
        }
        await this.trimAudit(this.config.auditLimit);
    }
    async close() {
        if (this.domain !== undefined)
            await this.domain.close();
    }
}
/** A fresh empty usage accumulator. */
export const emptyUsage = () => ({ ...EMPTY_USAGE });
