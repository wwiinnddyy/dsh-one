/** A refusal a person or an agent can cause, with a stable code. */
export class UserError extends Error {
  readonly code: string
  readonly values: Record<string, unknown>

  constructor(code: string, message: string, values: Record<string, unknown> = {}) {
    super(message)
    this.name = 'UserError'
    this.code = code
    this.values = values
  }
}
