/** Durable state for dsh-one, backed by `ctx.storageDomain` with an in-memory fallback. */

import type {
  AuditRecord,
  CursorRecord,
  DecisionRecord,
  DeliveryRecord,
  DshContextLike,
  EvalRecord,
  LeaseRecord,
  MandateRecord,
  ManagedSessionRecord,
  OneConfig,
  OutboxRecord,
  PolicyRecord,
  ReportRecord,
  SettingRecord,
  SubscriptionRecord,
  TaskRecord,
  ThreadRecord,
  TriggerRecord,
} from '../types.js'
import { oneDomainSpec } from './spec.js'

interface TableLike<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  readonly size: number
  put(key: string, value: T): Promise<void>
  update(key: string, fn: (current: T) => T): Promise<T>
  delete(key: string): Promise<boolean>
}

interface DomainLike {
  table(name: string): TableLike<unknown>
  close(): Promise<void>
}

interface DomainFacilityLike {
  open(spec: unknown): Promise<DomainLike>
  get?(name: string): DomainLike | undefined
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  lastUsageSeq: -1,
}

class MemoryTable<T> implements TableLike<T> {
  private readonly records = new Map<string, T>()

  get(key: string): T | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, T]> {
    return ([...this.records.entries()] as [string, T][])[Symbol.iterator]()
  }

  get size(): number {
    return this.records.size
  }

  async put(key: string, value: T): Promise<void> {
    this.records.set(key, value)
  }

  async update(key: string, fn: (current: T) => T): Promise<T> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing record "${key}"`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

/** Path-safe table key for one preference row (`[a-zA-Z0-9_-]+`). */
function settingId(namespace: string, key: string): string {
  return `${namespace}_${key}`
}

/** One opened storage surface over the shared `dsh-one` domain. */
export class OneStore {
  readonly degraded: boolean
  private readonly domain: DomainLike | undefined
  private readonly sessionsTable: TableLike<ManagedSessionRecord>
  private readonly outboxTable: TableLike<OutboxRecord>
  private readonly auditTable: TableLike<AuditRecord>
  private readonly taskTable: TableLike<TaskRecord>
  private readonly leaseTable: TableLike<LeaseRecord>
  private readonly reportTable: TableLike<ReportRecord>
  private readonly triggerTable: TableLike<TriggerRecord>
  private readonly threadTable: TableLike<ThreadRecord>
  private readonly evalTable: TableLike<EvalRecord>
  private readonly decisionTable: TableLike<DecisionRecord>
  private readonly policyTable: TableLike<PolicyRecord>
  private readonly mandateTable: TableLike<MandateRecord>
  private readonly deliveryTable: TableLike<DeliveryRecord>
  private readonly cursorTable: TableLike<CursorRecord>
  private readonly subscriptionTable: TableLike<SubscriptionRecord>
  private readonly settingTable: TableLike<SettingRecord>
  private readonly config: OneConfig

  private constructor(config: OneConfig, domain: DomainLike | undefined, degraded: boolean) {
    this.config = config
    this.domain = domain
    this.degraded = degraded
    const table = <T>(name: string, memory: TableLike<T>): TableLike<T> =>
      domain === undefined ? memory : domain.table(name) as TableLike<T>
    this.sessionsTable = table('sessions', new MemoryTable<ManagedSessionRecord>())
    this.outboxTable = table('outbox', new MemoryTable<OutboxRecord>())
    this.auditTable = table('audit', new MemoryTable<AuditRecord>())
    this.taskTable = table('tasks', new MemoryTable<TaskRecord>())
    this.leaseTable = table('leases', new MemoryTable<LeaseRecord>())
    this.reportTable = table('reports', new MemoryTable<ReportRecord>())
    this.triggerTable = table('triggers', new MemoryTable<TriggerRecord>())
    this.threadTable = table('threads', new MemoryTable<ThreadRecord>())
    this.evalTable = table('evals', new MemoryTable<EvalRecord>())
    this.decisionTable = table('decisions', new MemoryTable<DecisionRecord>())
    this.policyTable = table('policies', new MemoryTable<PolicyRecord>())
    this.mandateTable = table('mandates', new MemoryTable<MandateRecord>())
    this.deliveryTable = table('deliveries', new MemoryTable<DeliveryRecord>())
    this.cursorTable = table('cursors', new MemoryTable<CursorRecord>())
    this.subscriptionTable = table('subscriptions', new MemoryTable<SubscriptionRecord>())
    this.settingTable = table('settings', new MemoryTable<SettingRecord>())
  }

  /** Build one store; the caller owns recovery and lifecycle. */
  static async create(ctx: DshContextLike, config: OneConfig): Promise<OneStore> {
    const facility = ctx.get('storageDomain') as DomainFacilityLike | undefined
    if (facility === undefined || typeof facility.open !== 'function') {
      const memory = new OneStore(config, undefined, true)
      await memory.recover()
      return memory
    }
    let domain: DomainLike
    try {
      domain = await facility.open(oneDomainSpec)
    } catch (error: unknown) {
      const existing = typeof facility.get === 'function' ? facility.get('dsh_one') : undefined
      if (existing === undefined) throw error
      domain = existing
    }
    const store = new OneStore(config, domain, false)
    await store.recover()
    return store
  }

  // ---- sessions -----------------------------------------------------------------
  getSession(sessionId: string): ManagedSessionRecord | undefined { return this.sessionsTable.get(sessionId) }
  listSessions(): ManagedSessionRecord[] { return [...this.sessionsTable.entries()].map(([, record]) => record) }
  async putSession(record: ManagedSessionRecord): Promise<void> { await this.sessionsTable.put(record.sessionId, record) }

  // ---- outbox -------------------------------------------------------------------
  getOutbox(requestId: string): OutboxRecord | undefined { return this.outboxTable.get(requestId) }
  listOutbox(): OutboxRecord[] {
    return [...this.outboxTable.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt)
  }
  async putOutbox(record: OutboxRecord): Promise<void> { await this.outboxTable.put(record.requestId, record) }

  // ---- audit --------------------------------------------------------------------
  listAudit(limit = 50): AuditRecord[] {
    return [...this.auditTable.entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }
  async appendAudit(record: AuditRecord, limit: number): Promise<void> {
    await this.auditTable.put(record.id, record)
    await this.trimAudit(limit)
  }
  private async trimAudit(limit: number): Promise<void> {
    if (this.auditTable.size <= limit) return
    const sorted = [...this.auditTable.entries()]
      .map(([key, record]) => ({ key, at: record.at }))
      .sort((a, b) => a.at - b.at)
    const excess = this.auditTable.size - limit
    for (const row of sorted.slice(0, excess)) await this.auditTable.delete(row.key)
  }

  // ---- tasks --------------------------------------------------------------------
  getTask(taskId: string): TaskRecord | undefined { return this.taskTable.get(taskId) }
  listTasks(): TaskRecord[] {
    return [...this.taskTable.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt)
  }
  async putTask(task: TaskRecord): Promise<void> { await this.taskTable.put(task.taskId, task) }
  /** Single-key atomic read-modify-write for every task transition. */
  async updateTask(taskId: string, fn: (current: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    return await this.taskTable.update(taskId, fn)
  }

  // ---- leases -------------------------------------------------------------------
  getLease(leaseId: string): LeaseRecord | undefined { return this.leaseTable.get(leaseId) }
  listLeases(): LeaseRecord[] { return [...this.leaseTable.entries()].map(([, record]) => record) }
  async putLease(lease: LeaseRecord): Promise<void> { await this.leaseTable.put(lease.leaseId, lease) }

  // ---- reports ------------------------------------------------------------------
  getReport(taskId: string, reportId: string): ReportRecord | undefined {
    return this.reportTable.get(`${taskId}:${reportId}`)
  }
  listReports(taskId?: string): ReportRecord[] {
    const rows = [...this.reportTable.entries()].map(([, record]) => record)
    return (taskId === undefined ? rows : rows.filter(row => row.taskId === taskId)).sort((a, b) => a.createdAt - b.createdAt)
  }
  async putReport(report: ReportRecord): Promise<void> {
    await this.reportTable.put(`${report.taskId}:${report.reportId}`, report)
  }

  // ---- intake -------------------------------------------------------------------
  getTrigger(id: string): TriggerRecord | undefined { return this.triggerTable.get(id) }
  listTriggers(limit = 100): TriggerRecord[] {
    return [...this.triggerTable.entries()].map(([, record]) => record).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit)
  }
  async putTrigger(record: TriggerRecord): Promise<void> { await this.triggerTable.put(record.triggerId, record) }

  getThread(id: string): ThreadRecord | undefined { return this.threadTable.get(id) }
  listThreads(): ThreadRecord[] { return [...this.threadTable.entries()].map(([, record]) => record) }
  async putThread(record: ThreadRecord): Promise<void> { await this.threadTable.put(record.threadId, record) }

  getEval(id: string): EvalRecord | undefined { return this.evalTable.get(id) }
  listEvals(): EvalRecord[] { return [...this.evalTable.entries()].map(([, record]) => record) }
  async putEval(record: EvalRecord): Promise<void> { await this.evalTable.put(record.evalId, record) }

  getDecision(id: string): DecisionRecord | undefined { return this.decisionTable.get(id) }
  listDecisions(limit = 50): DecisionRecord[] {
    return [...this.decisionTable.entries()].map(([, record]) => record).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }
  async putDecision(record: DecisionRecord): Promise<void> { await this.decisionTable.put(record.decisionId, record) }

  getPolicy(version: string): PolicyRecord | undefined { return this.policyTable.get(version) }
  listPolicies(): PolicyRecord[] { return [...this.policyTable.entries()].map(([, record]) => record) }
  async putPolicy(record: PolicyRecord): Promise<void> { await this.policyTable.put(record.version, record) }

  getMandate(id: string): MandateRecord | undefined { return this.mandateTable.get(id) }
  listMandates(): MandateRecord[] { return [...this.mandateTable.entries()].map(([, record]) => record) }
  /** Mandates are immutable: only first insert is allowed. */
  async putMandateOnce(record: MandateRecord): Promise<boolean> {
    if (this.mandateTable.get(record.mandateId) !== undefined) return false
    await this.mandateTable.put(record.mandateId, record)
    return true
  }

  getDelivery(id: string): DeliveryRecord | undefined { return this.deliveryTable.get(id) }
  async putDelivery(record: DeliveryRecord): Promise<void> { await this.deliveryTable.put(record.deliveryId, record) }
  listDeliveries(limit = 50): DeliveryRecord[] {
    return [...this.deliveryTable.entries()].map(([, record]) => record).sort((a, b) => b.at - a.at).slice(0, limit)
  }

  getCursor(id: string): CursorRecord | undefined { return this.cursorTable.get(id) }
  async putCursor(record: CursorRecord): Promise<void> { await this.cursorTable.put(record.cursorId, record) }

  getSubscription(id: string): SubscriptionRecord | undefined { return this.subscriptionTable.get(id) }
  async putSubscription(record: SubscriptionRecord): Promise<void> {
    await this.subscriptionTable.put(record.subscriptionId, record)
  }

  // ---- settings -----------------------------------------------------------------
  /**
   * One preference row; `namespace` scopes the key to its owning surface.
   *
   * The composite key is joined with `_`, not `:` or `.`: a per-record backend
   * writes each key as a path segment and accepts only `[a-zA-Z0-9_-]+`, so
   * the separator must satisfy that class rather than merely read well.
   */
  getSetting(namespace: string, key: string): SettingRecord | undefined {
    return this.settingTable.get(settingId(namespace, key))
  }
  listSettings(namespace?: string): SettingRecord[] {
    const rows = [...this.settingTable.entries()].map(([, record]) => record)
    return (namespace === undefined ? rows : rows.filter(row => row.namespace === namespace))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key))
  }
  async putSetting(record: SettingRecord): Promise<void> {
    await this.settingTable.put(settingId(record.namespace, record.key), record)
  }
  async deleteSetting(namespace: string, key: string): Promise<boolean> {
    return await this.settingTable.delete(settingId(namespace, key))
  }

  /** Current active policy (the newest non-superseded record). */
  activePolicy(): PolicyRecord | undefined {
    return this.listPolicies()
      .filter(policy => policy.supersededBy === undefined)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  /** A `sending` row interrupted by a process stop has an unknown outcome. */
  private async recover(): Promise<void> {
    for (const record of this.listOutbox()) {
      if (record.status !== 'sending') continue
      await this.putOutbox({
        ...record,
        status: 'unknown',
        updatedAt: Date.now(),
        error: 'process stopped while the send was in flight; outcome is unknown',
      })
    }
    await this.trimAudit(this.config.auditLimit)
  }

  async close(): Promise<void> {
    if (this.domain !== undefined) await this.domain.close()
  }
}

/** A fresh empty usage accumulator. */
export const emptyUsage = (): TaskRecord['usage'] => ({ ...EMPTY_USAGE })
