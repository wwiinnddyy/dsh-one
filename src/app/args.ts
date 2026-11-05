/** Small argument readers shared by the model-facing tools. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
