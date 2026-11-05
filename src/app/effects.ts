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
  getEffect(effectId: string): EffectRecord | undefined
  listEffects(): readonly EffectRecord[]
  putEffect(record: EffectRecord): Promise<void>
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
  async enqueue(kind: EffectKind, key: string, payload: unknown, dueAt?: number): Promise<EffectRecord> {
    const at = this.now()
    const waiting = this.store.listEffects().find(item =>
      item.kind === kind && item.key === key && item.status === 'pending')
    if (waiting !== undefined) {
      const replaced: EffectRecord = { ...waiting, payload, dueAt: dueAt ?? at, updatedAt: at }
      await this.store.putEffect(replaced)
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
    await this.store.putEffect(record)
    return record
  }

  /** Pending rows in execution order. */
  pending(): readonly EffectRecord[] {
    return this.store.listEffects()
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
      await this.store.putEffect(running)
      const handler = this.handlers.get(record.kind)
      if (handler === undefined) {
        await this.store.putEffect({ ...running, status: 'failed', error: `no handler for ${record.kind}`, updatedAt: this.now() })
        failed += 1
        continue
      }
      try {
        await handler(record.payload, running)
        await this.store.putEffect({ ...running, status: 'done', updatedAt: this.now() })
      } catch (error: unknown) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        if (running.attempts >= this.maxAttempts) {
          await this.store.putEffect({ ...running, status: 'failed', error: message, updatedAt: this.now() })
        } else {
          await this.store.putEffect({
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

  /** Reset effects left `running` by a host crash so they can be retried. */
  async recover(): Promise<number> {
    let recovered = 0
    for (const record of this.store.listEffects()) {
      if (record.status !== 'running') continue
      await this.store.putEffect({
        ...record,
        status: 'pending',
        dueAt: this.now(),
        error: 'recovered after host restart',
        updatedAt: this.now(),
      })
      recovered += 1
    }
    return recovered
  }
}
