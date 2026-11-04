/** Small, dependency-free helpers shared by dsh-one's modules. */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const now = (): number => Date.now()

export const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    signal?.throwIfAborted()
    return
  }
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const nextId = (prefix: string): string => `${prefix}-${randomUUID()}`

/** Short stable hash used for policy and idempotency fingerprints. */
export const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/** Deterministic request identity for one task input. */
export const taskInputRequestId = (taskId: string, inputId: string): string => `one:${taskId}:${inputId}`

/** Deterministic task id for one source event so a replay cannot create a second task. */
export const sourceTaskId = (sourceId: string, externalId: string): string =>
  `task-${hashOf({ sourceId, externalId })}`

export interface ClassifiedError {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** Read a stable error code without trusting a particular error class. */
export function classifyError(error: unknown): ClassifiedError {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const code = typeof record['code'] === 'string'
      ? record['code']
      : typeof record['name'] === 'string' && record['name'] !== 'Error'
        ? record['name']
        : 'unknown'
    const message = typeof record['message'] === 'string' ? record['message'] : String(error)
    const details = isRecord(record['details']) ? record['details'] : {}
    return { code, message, details }
  }
  return { code: 'unknown', message: String(error), details: {} }
}

/** Whether a send failure is worth retrying. */
export function isRetryable(error: unknown): boolean {
  const { code, details } = classifyError(error)
  if (code === 'session/writer-held') return true
  if (code === 'session/agent-busy') {
    const reason = typeof details['reason'] === 'string' ? details['reason'] : ''
    return !reason.includes('subagent')
  }
  return code === 'gateway/internal' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
}

/** Whether a failure is specifically a subagent-address refusal. */
export function isSubagentRefusal(error: unknown): boolean {
  const { code, message, details } = classifyError(error)
  if (code !== 'session/agent-busy') return false
  const reason = typeof details['reason'] === 'string' ? details['reason'] : message
  return reason.includes('subagent')
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error === 'object' && error !== null) {
    const name = (error as Record<string, unknown>)['name']
    if (name === 'AbortError') return true
  }
  return classifyError(error).code === 'gateway/cancelled'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

/** Whether `target` is inside `root` (case-insensitive on Windows). */
export function pathWithin(root: string, target: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
  const normalizedTarget = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target)
  const diff = relative(normalizedRoot, normalizedTarget)
  if (diff === '') return true
  if (isAbsolute(diff)) return false
  return !diff.split(sep).includes('..')
}

/** Canonical workspace key used by leases; case-insensitive on Windows. */
export function canonicalWorkspace(cwd: string): string {
  const resolved = resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Truncate free text before it enters an audit or panel row. */
export function preview(text: string, limit = 120): string {
  const single = text.replace(/\s+/gu, ' ').trim()
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`
}

/** Render a model route as `provider/model`. */
export function formatModel(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Parse a `provider/model` route. */
export function parseModelRoute(value: string): { provider: string; model: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/** Parse a leading command word plus the remaining raw text. */
export function splitFirstToken(text: string): { token: string; rest: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { token: '', rest: '' }
  const match = /^(\S+)(?:\s+|$)([\s\S]*)$/u.exec(trimmed)
  if (match === null) return { token: trimmed, rest: '' }
  return { token: match[1] ?? '', rest: match[2] ?? '' }
}

/** Parse a JSON object body; returns undefined for malformed input. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}
