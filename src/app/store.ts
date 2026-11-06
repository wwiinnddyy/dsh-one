/**
 * The persistent store.
 *
 * Reads are synchronous (the host's table surface is a local key/value read);
 * writes are awaited so a command can report a durable result. A profile
 * without `storageDomain` gets the same interface in memory, which keeps the
 * plugin loadable in a bare test host.
 */

import type { Goal, Ticket } from '../core/model.js'
import type { GoalRepository, TicketRepository } from '../core/engine.js'
import type { EffectRecord, EffectStore } from './effects.js'
import { oneDomainSpec } from './spec.js'
import type { DshContextLike } from '../types.js'

export interface ManagedSessionRecord {
  readonly sessionId: string
  readonly role: 'router' | 'executor'
  readonly title?: string
  readonly cwd?: string
  readonly status: 'active' | 'missing' | 'error'
  readonly trusted: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeenAt?: number
  readonly error?: string
}

export interface SettingRecord {
  readonly namespace: string
  readonly key: string
  readonly value: string
  readonly updatedAt: number
  readonly updatedBy: 'human' | 'agent' | 'system'
}

export interface AuditRecord {
  readonly id: string
  readonly at: number
  readonly action: string
  readonly actorSessionId?: string
  readonly targetSessionId?: string
  readonly ticketId?: string
  readonly outcome: 'ok' | 'error' | 'observed'
  readonly detail?: string
}

/** One row of the assistant's own conversation. */
export interface ChatRecord {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
  readonly at: number
  /** Delivery / processing state for a user row, or the answer state for an assistant row. */
  readonly status?: 'sending' | 'delivered' | 'read' | 'replied' | 'waiting' | 'failed'
  /** The user row an assistant answer belongs to, so a recall can remove both. */
  readonly replyTo?: string
  readonly requestId?: string
  /** The host Session event seq that produced an assistant message, for dedupe. */
  readonly sessionSeq?: number
}

interface TableLike<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

interface DomainLike {
  table(name: string): TableLike<unknown>
  close?(): Promise<void>
}

interface DomainFacilityLike {
  open(spec: unknown): Promise<DomainLike>
  get?(name: string): DomainLike | undefined
}

/** Everything the plugin persists, behind one narrow interface. */
export interface Store extends TicketRepository, GoalRepository, EffectStore {
  readonly backend: 'domain' | 'memory'
  getTicket(ticketId: string): Ticket | undefined
  putTicket(ticket: Ticket): Promise<void>
  listTickets(): readonly Ticket[]
  getGoal(goalId: string): Goal | undefined
  putGoal(goal: Goal): Promise<void>
  listGoals(): readonly Goal[]
  getEffect(effectId: string): EffectRecord | undefined
  putEffect(record: EffectRecord): Promise<void>
  listEffects(): readonly EffectRecord[]
  getSession(sessionId: string): ManagedSessionRecord | undefined
  putSession(record: ManagedSessionRecord): Promise<void>
  listSessions(): readonly ManagedSessionRecord[]
  getSetting(namespace: string, key: string): SettingRecord | undefined
  putSetting(record: SettingRecord): Promise<void>
  deleteSetting(namespace: string, key: string): Promise<boolean>
  listSettings(namespace?: string): readonly SettingRecord[]
  appendAudit(record: AuditRecord, limit: number): Promise<void>
  listAudit(limit?: number): readonly AuditRecord[]
  getChat(id: string): ChatRecord | undefined
  putChat(record: ChatRecord): Promise<void>
  deleteChat(id: string): Promise<boolean>
  listChat(limit?: number): readonly ChatRecord[]
  chatBySessionSeq(seq: number): ChatRecord | undefined
}

function settingId(namespace: string, key: string): string {
  return `${namespace}.${key}`
}

function byUpdated<T extends { readonly updatedAt: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
}

function byAt<T extends { readonly at: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.at - a.at)
}

function chatRows<T extends ChatRecord>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

class MemoryTable<T> {
  private readonly rows = new Map<string, T>()

  get(key: string): T | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[string, T]> {
    return [...this.rows.entries()][Symbol.iterator]()
  }

  async put(key: string, value: T): Promise<void> {
    this.rows.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.rows.delete(key)
  }
}

/** In-memory implementation of the same store contract. */
export class MemoryStore implements Store {
  readonly backend = 'memory' as const
  private readonly tickets = new MemoryTable<Ticket>()
  private readonly goals = new MemoryTable<Goal>()
  private readonly effects = new MemoryTable<EffectRecord>()
  private readonly sessions = new MemoryTable<ManagedSessionRecord>()
  private readonly settings = new MemoryTable<SettingRecord>()
  private readonly audit = new MemoryTable<AuditRecord>()
  private readonly chat = new MemoryTable<ChatRecord>()

  getTicket(ticketId: string): Ticket | undefined { return this.tickets.get(ticketId) }
  async putTicket(ticket: Ticket): Promise<void> { await this.tickets.put(ticket.ticketId, ticket) }
  listTickets(): readonly Ticket[] { return [...this.tickets.entries()].map(([, value]) => value) }

  getGoal(goalId: string): Goal | undefined { return this.goals.get(goalId) }
  async putGoal(goal: Goal): Promise<void> { await this.goals.put(goal.goalId, goal) }
  listGoals(): readonly Goal[] { return [...this.goals.entries()].map(([, value]) => value) }

  getEffect(effectId: string): EffectRecord | undefined { return this.effects.get(effectId) }
  async putEffect(record: EffectRecord): Promise<void> { await this.effects.put(record.effectId, record) }
  listEffects(): readonly EffectRecord[] { return [...this.effects.entries()].map(([, value]) => value) }

  getSession(sessionId: string): ManagedSessionRecord | undefined { return this.sessions.get(sessionId) }
  async putSession(record: ManagedSessionRecord): Promise<void> { await this.sessions.put(record.sessionId, record) }
  listSessions(): readonly ManagedSessionRecord[] { return [...this.sessions.entries()].map(([, value]) => value) }

  getSetting(namespace: string, key: string): SettingRecord | undefined {
    return this.settings.get(settingId(namespace, key))
  }
  async putSetting(record: SettingRecord): Promise<void> {
    await this.settings.put(settingId(record.namespace, record.key), record)
  }
  async deleteSetting(namespace: string, key: string): Promise<boolean> {
    return await this.settings.delete(settingId(namespace, key))
  }
  listSettings(namespace?: string): readonly SettingRecord[] {
    return [...this.settings.entries()]
      .map(([, value]) => value)
      .filter(item => namespace === undefined || item.namespace === namespace)
  }

  async appendAudit(record: AuditRecord, limit: number): Promise<void> {
    await this.audit.put(record.id, record)
    const rows = byAt([...this.audit.entries()].map(([, value]) => value))
    for (const extra of rows.slice(limit)) await this.audit.delete(extra.id)
  }
  listAudit(limit = 50): readonly AuditRecord[] {
    return byAt([...this.audit.entries()].map(([, value]) => value)).slice(0, limit)
  }

  getChat(id: string): ChatRecord | undefined { return this.chat.get(id) }
  async putChat(record: ChatRecord): Promise<void> { await this.chat.put(record.id, record) }
  async deleteChat(id: string): Promise<boolean> { return await this.chat.delete(id) }
  listChat(limit = 200): readonly ChatRecord[] {
    return chatRows([...this.chat.entries()].map(([, value]) => value)).slice(-limit)
  }
  chatBySessionSeq(seq: number): ChatRecord | undefined {
    return [...this.chat.entries()].map(([, value]) => value).find(item => item.sessionSeq === seq)
  }
}

/** Storage-domain-backed implementation. */
export class DomainStore implements Store {
  readonly backend = 'domain' as const
  private readonly domain: DomainLike

  constructor(domain: DomainLike) {
    this.domain = domain
  }

  private table<T>(name: string): TableLike<T> {
    return this.domain.table(name) as TableLike<T>
  }

  getTicket(ticketId: string): Ticket | undefined { return this.table<Ticket>('tickets').get(ticketId) }
  async putTicket(ticket: Ticket): Promise<void> { await this.table<Ticket>('tickets').put(ticket.ticketId, ticket) }
  listTickets(): readonly Ticket[] { return [...this.table<Ticket>('tickets').entries()].map(([, value]) => value) }

  getGoal(goalId: string): Goal | undefined { return this.table<Goal>('goals').get(goalId) }
  async putGoal(goal: Goal): Promise<void> { await this.table<Goal>('goals').put(goal.goalId, goal) }
  listGoals(): readonly Goal[] { return [...this.table<Goal>('goals').entries()].map(([, value]) => value) }

  getEffect(effectId: string): EffectRecord | undefined { return this.table<EffectRecord>('effects').get(effectId) }
  async putEffect(record: EffectRecord): Promise<void> { await this.table<EffectRecord>('effects').put(record.effectId, record) }
  listEffects(): readonly EffectRecord[] { return [...this.table<EffectRecord>('effects').entries()].map(([, value]) => value) }

  getSession(sessionId: string): ManagedSessionRecord | undefined { return this.table<ManagedSessionRecord>('sessions').get(sessionId) }
  async putSession(record: ManagedSessionRecord): Promise<void> { await this.table<ManagedSessionRecord>('sessions').put(record.sessionId, record) }
  listSessions(): readonly ManagedSessionRecord[] { return [...this.table<ManagedSessionRecord>('sessions').entries()].map(([, value]) => value) }

  getSetting(namespace: string, key: string): SettingRecord | undefined {
    return this.table<SettingRecord>('settings').get(settingId(namespace, key))
  }
  async putSetting(record: SettingRecord): Promise<void> {
    await this.table<SettingRecord>('settings').put(settingId(record.namespace, record.key), record)
  }
  async deleteSetting(namespace: string, key: string): Promise<boolean> {
    return await this.table<SettingRecord>('settings').delete(settingId(namespace, key))
  }
  listSettings(namespace?: string): readonly SettingRecord[] {
    return [...this.table<SettingRecord>('settings').entries()]
      .map(([, value]) => value)
      .filter(item => namespace === undefined || item.namespace === namespace)
  }

  async appendAudit(record: AuditRecord, limit: number): Promise<void> {
    await this.table<AuditRecord>('audit').put(record.id, record)
    const rows = byAt([...this.table<AuditRecord>('audit').entries()].map(([, value]) => value))
    for (const extra of rows.slice(limit)) await this.table<AuditRecord>('audit').delete(extra.id)
  }
  listAudit(limit = 50): readonly AuditRecord[] {
    return byAt([...this.table<AuditRecord>('audit').entries()].map(([, value]) => value)).slice(0, limit)
  }

  getChat(id: string): ChatRecord | undefined { return this.table<ChatRecord>('chat').get(id) }
  async putChat(record: ChatRecord): Promise<void> { await this.table<ChatRecord>('chat').put(record.id, record) }
  async deleteChat(id: string): Promise<boolean> { return await this.table<ChatRecord>('chat').delete(id) }
  listChat(limit = 200): readonly ChatRecord[] {
    return chatRows([...this.table<ChatRecord>('chat').entries()].map(([, value]) => value)).slice(-limit)
  }
  chatBySessionSeq(seq: number): ChatRecord | undefined {
    return [...this.table<ChatRecord>('chat').entries()].map(([, value]) => value).find(item => item.sessionSeq === seq)
  }
}

/**
 * Open the durable store when the host offers one, else the memory fallback.
 * A domain that fails to open must not stop the plugin from loading.
 */
export async function acquireStore(ctx: DshContextLike): Promise<Store> {
  const facility = ctx.get('storageDomain') as DomainFacilityLike | undefined
  if (facility === undefined) return new MemoryStore()
  try {
    const existing = facility.get?.(oneDomainSpec.name)
    if (existing !== undefined) return new DomainStore(existing)
    return new DomainStore(await facility.open(oneDomainSpec))
  } catch {
    return new MemoryStore()
  }
}
