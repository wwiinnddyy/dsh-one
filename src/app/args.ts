/** Small argument readers shared by the model-facing tools. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Parse a leading command word plus the remaining raw text. */
export function splitFirstToken(text: string): { token: string; rest: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { token: '', rest: '' }
  const match = /^(\S+)(?:\s+|$)([\s\S]*)$/u.exec(trimmed)
  if (match === null) return { token: trimmed, rest: '' }
  return { token: match[1] ?? '', rest: match[2] ?? '' }
}