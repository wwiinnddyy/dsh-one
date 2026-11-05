/**
 * The durable side-effect queue.
 *
 * A command writes what must happen *after* it commits — launch a worker,
 * deliver an Input, relay a report, reply to a person, assess a trigger. The
 * queue is the only place those actions run, so retry, ordering and health are
 * uniform instead of being re-invented per subsystem.
 */

import { newId } from '../core/ids.js'

export type EffectKind = 'launch' | 'delivery' | 'relay' | 'notice' | 'reply' | 'assessment'
export type EffectStatus = 'pending' | 'running' | 'done' | 'failed'

export interface EffectRecord {
  readonly effectId: string
  readonly kind: EffectKind
  readonly key: string
  readonly payload: unknown
  readonly status: EffectStatus
  readonly attempts: number
  readonly dueAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly error?: string
}

export interface EffectStore {
  get(effectId: string): EffectRecord | undefined
  list(): readonly EffectRecord[]
  put(record: EffectRecord): void
}

export type EffectHandler = (payload: unknown, record: EffectRecord) => void | Promise<void>

export interface EffectsOptions {
  readonly now?: () => number
  /** First retry delay; doubles per attempt. */
  readonly retryBaseMs?: number
  readonly maxAttempts?: number
}

export class EffectsQueue {
  private readonly store: EffectStore
  private readonly now: () => number
  private readonly retryBaseMs: number
  private readonly maxAttempts: number
  private readonly handlers = new Map<EffectKind, EffectHandler>()

  constructor(store: EffectStore, options: EffectsOptions = {}) {
    this.store = store
    this.now = options.now ?? Date.now
    this.retryBaseMs = options.retryBaseMs ?? 2_000
    this.maxAttempts = options.maxAttempts ?? 5
  }

  /** One handler per kind. Registering twice replaces the earlier one. */
  register(kind: EffectKind, handler: EffectHandler): void {
    this.handlers.set(kind, handler)
  }

  /**
   * Queue one effect. While an effect of the same kind and key is still
   * pending, re-enqueuing replaces its payload and makes it due now instead of
   * growing the queue.
   */
  enqueue(kind: EffectKind, key: string, payload: unknown, dueAt?: number): EffectRecord {
    const at = this.now()
    const waiting = this.store.list().find(item =>
      item.kind === kind && item.key === key && item.status === 'pending')
    if (waiting !== undefined) {
      const replaced: EffectRecord = {
        ...waiting,
        payload,
        dueAt: dueAt ?? at,
        updatedAt: at,
      }
      this.store.put(replaced)
      return replaced
    }
    const record: EffectRecord = {
      effectId: newId('effect'),
      kind,
      key,
      payload,
      status: 'pending',
      attempts: 0,
      dueAt: dueAt ?? at,
      createdAt: at,
      updatedAt: at,
    }
    this.store.put(record)
    return record
  }

  /** Pending rows in execution order. */
  pending(): readonly EffectRecord[] {
    return this.store.list()
      .filter(item => item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || a.effectId.localeCompare(b.effectId))
  }

  /**
   * Process due effects once. Each effect is marked running before its handler
   * runs, so a crash mid-flight leaves a `running` row the next start can
   * recover instead of silently losing it.
   */
  async drain(limit = 20): Promise<{ readonly processed: number; readonly failed: number }> {
    let processed = 0
    let failed = 0
    const due = this.pending().filter(item => item.dueAt <= this.now()).slice(0, limit)
    for (const record of due) {
      processed += 1
      const running: EffectRecord = {
        ...record,
        status: 'running',
        attempts: record.attempts + 1,
        updatedAt: this.now(),
      }
      this.store.put(running)
      const handler = this.handlers.get(record.kind)
      if (handler === undefined) {
        this.store.put({ ...running, status: 'failed', error: `no handler for ${record.kind}`, updatedAt: this.now() })
        failed += 1
        continue
      }
      try {
        await handler(record.payload, running)
        this.store.put({ ...running, status: 'done', updatedAt: this.now() })
      } catch (error: unknown) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        if (running.attempts >= this.maxAttempts) {
          this.store.put({ ...running, status: 'failed', error: message, updatedAt: this.now() })
        } else {
          this.store.put({
            ...running,
            status: 'pending',
            dueAt: this.now() + this.retryBaseMs * 2 ** (running.attempts - 1),
            error: message,
            updatedAt: this.now(),
          })
        }
      }
    }
    return { processed, failed }
  }
}
