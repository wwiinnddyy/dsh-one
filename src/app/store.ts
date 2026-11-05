/**
 * The base store.
 *
 * The first base is in-memory on purpose: it proves the domain and the effect
 * queue without depending on a host storage backend. The next phase binds the
 * same ports to `ctx.storageDomain`.
 */

import type { Ticket } from '../core/model.js'
import type { TicketRepository } from '../core/engine.js'
import type { EffectRecord, EffectStore } from './effects.js'

export class MemoryTicketRepository implements TicketRepository {
  private readonly rows = new Map<string, Ticket>()

  get(ticketId: string): Ticket | undefined {
    return this.rows.get(ticketId)
  }

  put(ticket: Ticket): void {
    this.rows.set(ticket.ticketId, ticket)
  }

  list(): readonly Ticket[] {
    return [...this.rows.values()]
  }
}

export class MemoryEffectStore implements EffectStore {
  private readonly rows = new Map<string, EffectRecord>()

  get(effectId: string): EffectRecord | undefined {
    return this.rows.get(effectId)
  }

  list(): readonly EffectRecord[] {
    return [...this.rows.values()]
  }

  put(record: EffectRecord): void {
    this.rows.set(record.effectId, record)
  }
}

/** One memory store per plugin row, for tests and for hosts without storage. */
export class MemoryStore {
  readonly tickets = new MemoryTicketRepository()
  readonly effects = new MemoryEffectStore()
}
