/** Stable ids and fingerprints shared by the domain and its adapters. */

import { createHash, randomUUID } from 'node:crypto'

/** A fresh opaque id with a readable prefix. */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

/**
 * A deterministic id derived from its inputs: equal inputs give equal ids.
 * Used where a retry or a replay must resolve to the same row.
 */
export function keyOf(prefix: string, value: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  return `${prefix}-${hash}`
}
