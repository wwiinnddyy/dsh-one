/** Shared contracts for dsh-one's host half. */

/** Minimal Agent surface used by commands and tools. */
export interface AgentLike {
  readonly id: string
  readonly session: {
    readonly id?: string
    readonly header: { readonly cwd?: string; readonly parentSession?: string; readonly origin?: string }
  }
}

/** One row returned by `session/list`. */
export interface SessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly agentAvailable: boolean
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: Record<string, unknown>
}

/** One provider group in `session/modelCatalog`. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string; readonly reasoning?: { readonly efforts: readonly { readonly id: string }[]; readonly defaultEffort?: string } }[]
}

/** Host model catalog. */
export interface ModelCatalog {
  readonly default: ModelSelection
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface SessionCreateRequest {
  readonly workspaceId?: string
  readonly cwd?: string
  readonly sessionId?: string
  readonly agentPreset?: string
}

export interface SessionSelectModelRequest extends ModelSelection {
  readonly sessionId: string
}

export interface SessionPromptRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly clientTimeZone?: string
}

/** Host session controller: the implementation behind the `session/*` Remote namespace. */
export interface SessionControllerLike {
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ readonly items: readonly SessionSummary[] }>
  create(request: SessionCreateRequest): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>
  selectModel(request: SessionSelectModelRequest): Promise<{ readonly selected: ModelSelection }>
  modelCatalog(): Promise<ModelCatalog>
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<unknown>
}

export interface ToolRunContextLike {
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly timeoutMs?: number
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
}

export interface CommandInvocationLike {
  readonly agent: AgentLike
  readonly rawInput: string
  readonly signal?: AbortSignal
}

export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string }
  handler(invocation: CommandInvocationLike): CommandResultLike | Promise<CommandResultLike>
}

/** Cordis context subset used by this plugin. */
export interface DshContextLike {
  effect(callback: () => (() => void) | void, label?: string): unknown
  get(name: string): unknown
  readonly tools: { register(definition: ToolDefinitionLike): () => void }
  readonly commands: { register(definition: CommandDefinitionLike): () => void }
}

export type OneMode = 'observe' | 'active'

/** Deployment configuration. */
export interface OneConfig {
  readonly mode: OneMode
  readonly allowAllSessions: boolean
  readonly allowedSessionIds: readonly string[]
  readonly allowedWorkspaceRoots: readonly string[]
  readonly allowSessionCreation: boolean
  readonly maxSendAttempts: number
  readonly retryDelayMs: number
  readonly maxMessageChars: number
  readonly commandTimeoutMs: number
  readonly modelFallback: boolean
  readonly auditLimit: number
}

/** A session explicitly registered with dsh-one. */
export interface ManagedSessionRecord {
  readonly sessionId: string
  readonly title?: string
  readonly workspaceId?: string
  readonly cwd?: string
  readonly model?: ModelSelection
  readonly status: 'active' | 'missing' | 'error'
  readonly trusted: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeenAt?: number
  readonly error?: string
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'observed' | 'failed' | 'unknown' | 'cancelled'

/** Durable record for one cross-session send. The request id is the idempotency key. */
export interface OutboxRecord {
  readonly requestId: string
  readonly callerSessionId?: string
  readonly targetSessionId: string
  readonly text: string
  readonly mode: 'queue' | 'steer'
  readonly source: 'tool' | 'command'
  readonly status: OutboxStatus
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly error?: string
}

/** Append-only audit record. */
export interface AuditRecord {
  readonly id: string
  readonly at: number
  readonly action: string
  readonly actorSessionId?: string
  readonly targetSessionId?: string
  readonly requestId?: string
  readonly outcome: 'ok' | 'error' | 'observed'
  readonly detail?: string
}

/** Errors with a stable code for tool and command presentation. */
export class OneError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OneError'
    this.code = code
    this.details = details
  }
}

export interface SendInput {
  readonly targetSessionId: string
  readonly text: string
  readonly requestId?: string
  readonly mode?: 'queue' | 'steer'
  readonly callerSessionId?: string
  readonly source: 'tool' | 'command'
  readonly signal?: AbortSignal
}

export interface SendResult {
  readonly requestId: string
  readonly targetSessionId: string
  readonly status: OutboxStatus
  readonly accepted: boolean
  readonly observed: boolean
  readonly attempts: number
  readonly error?: string
}

export interface SelectModelInput {
  readonly targetSessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly callerSessionId?: string
  readonly source: 'tool' | 'command'
  readonly signal?: AbortSignal
}

export interface SelectModelResult {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly selected: boolean
  readonly observed: boolean
  readonly fallbackUsed: boolean
  readonly error?: string
}

export interface SessionView {
  readonly sessionId: string
  readonly title?: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
  readonly subagent: boolean
  readonly registered: boolean
  readonly trusted: boolean
  readonly model?: ModelSelection
  readonly status?: 'active' | 'missing' | 'error'
  readonly lastSeenAt?: number
}
