/** Durable state for dsh-one, backed by `ctx.storageDomain` with an in-memory fallback. */

import { z } from 'zod'
import type { DshContextLike, AuditRecord, ManagedSessionRecord, OneConfig, OutboxRecord } from './types.js'

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
}

const modelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

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
})

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
})

const auditSchema = z.object({
  id: z.string(),
  at: z.number().int().nonnegative(),
  action: z.string(),
  actorSessionId: z.string().optional(),
  targetSessionId: z.string().optional(),
  requestId: z.string().optional(),
  outcome: z.enum(['ok', 'error', 'observed']),
  detail: z.string().optional(),
})

/** Domain declaration consumed by `ctx.storageDomain.open`. */
export const oneDomainSpec = {
  name: 'dsh-one',
  version: 1,
  tables: {
    sessions: { valueSchema: managedSessionSchema },
    outbox: { valueSchema: outboxSchema },
    audit: { valueSchema: auditSchema },
  },
} as const

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

/** One opened storage surface. */
export class OneStore {
  readonly degraded: boolean
  private readonly sessions: TableLike<ManagedSessionRecord>
  private readonly outbox: TableLike<OutboxRecord>
  private readonly audits: TableLike<AuditRecord>
  private readonly domain: DomainLike | undefined

  private constructor(
    sessions: TableLike<ManagedSessionRecord>,
    outbox: TableLike<OutboxRecord>,
    audits: TableLike<AuditRecord>,
    domain: DomainLike | undefined,
    degraded: boolean,
  ) {
    this.sessions = sessions
    this.outbox = outbox
    this.audits = audits
    this.domain = domain
    this.degraded = degraded
  }

  /**
   * Open the `dsh-one` domain when the host provides `ctx.storageDomain`.
   * A host without that service keeps working in memory for one process;
   * the degradation is reported by `one_sessions`.
   */
  static async open(ctx: DshContextLike, config: OneConfig): Promise<OneStore> {
    const facility = ctx.get('storageDomain') as DomainFacilityLike | undefined
    if (facility === undefined || typeof facility.open !== 'function') {
      return new OneStore(
        new MemoryTable<ManagedSessionRecord>(),
        new MemoryTable<OutboxRecord>(),
        new MemoryTable<AuditRecord>(),
        undefined,
        true,
      )
    }
    const domain = await facility.open(oneDomainSpec)
    const store = new OneStore(
      domain.table('sessions') as TableLike<ManagedSessionRecord>,
      domain.table('outbox') as TableLike<OutboxRecord>,
      domain.table('audit') as TableLike<AuditRecord>,
      domain,
      false,
    )
    await store.recoverInterruptedSends()
    await store.trimAudit(config.auditLimit)
    return store
  }

  getSession(sessionId: string): ManagedSessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(): ManagedSessionRecord[] {
    return [...this.sessions.entries()].map(([, record]) => record)
  }

  async putSession(record: ManagedSessionRecord): Promise<void> {
    await this.sessions.put(record.sessionId, record)
  }

  getOutbox(requestId: string): OutboxRecord | undefined {
    return this.outbox.get(requestId)
  }

  listOutbox(): OutboxRecord[] {
    return [...this.outbox.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt)
  }

  async putOutbox(record: OutboxRecord): Promise<void> {
    await this.outbox.put(record.requestId, record)
  }

  listAudit(limit = 50): AuditRecord[] {
    return [...this.audits.entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  async appendAudit(record: AuditRecord, limit: number): Promise<void> {
    await this.audits.put(record.id, record)
    await this.trimAudit(limit)
  }

  private async trimAudit(limit: number): Promise<void> {
    if (this.audits.size <= limit) return
    const sorted = [...this.audits.entries()]
      .map(([key, record]) => ({ key, at: record.at }))
      .sort((a, b) => a.at - b.at)
    const excess = this.audits.size - limit
    for (const row of sorted.slice(0, excess)) {
      await this.audits.delete(row.key)
    }
  }

  /**
   * A `sending` row interrupted by a process stop has an unknown outcome.
   * Keep it visible and never silently retry: the caller must use a fresh
   * request id after checking the target session.
   */
  private async recoverInterruptedSends(): Promise<void> {
    for (const record of this.listOutbox()) {
      if (record.status !== 'sending') continue
      await this.putOutbox({
        ...record,
        status: 'unknown',
        updatedAt: Date.now(),
        error: 'process stopped while the send was in flight; outcome is unknown',
      })
    }
  }

  async close(): Promise<void> {
    if (this.domain !== undefined) await this.domain.close()
  }
}
