/** Shared contracts for dsh-one's host half and its three plugin rows. */

/** Minimal Agent surface used by commands and tools. */
export interface AgentLike {
  readonly id: string
  readonly session: {
    readonly id?: string
    readonly header: { readonly cwd?: string; readonly parentSession?: string; readonly origin?: string }
  }
  readonly ctx?: {
    readonly tools?: {
      register(definition: ToolDefinitionLike): () => void
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
    }
  }
  cancel?(cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }): void
  followup?(message: unknown): void
  steer?(message: unknown): void
  inject?(message: unknown): void
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

/** Resolved Agent surface returned by `sessionController.resolveAgent`. */
export interface ResolvedAgent {
  readonly agent?: AgentLike
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Host session controller: the implementation behind the `session/*` Remote namespace. */
export interface SessionControllerLike {
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ readonly items: readonly SessionSummary[] }>
  create(request: SessionCreateRequest): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>
  selectModel(request: SessionSelectModelRequest): Promise<{ readonly selected: ModelSelection }>
  modelCatalog(): Promise<ModelCatalog>
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<unknown>
  cancel?(request: { readonly sessionId: string }): { readonly accepted: true }
  resolveAgent?(sessionId: string): Promise<ResolvedAgent>
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

/** Minimal HTTP request/response surface used by `ctx.webServer`. */
export interface HttpRequestLike {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): unknown
  resume?(): void
  destroy?(): void
}

export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
  readonly headersSent?: boolean
}

export interface WebRouteLike {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

export interface ConnectionLike {
  requestRejection(request: { readonly headers: Record<string, string | string[] | undefined> }): 401 | 403 | undefined
}

export interface PermissionPresetsLike {
  catalog(): { readonly options: readonly { readonly value: string; readonly name?: string }[]; readonly defaultPreset?: string }
  resolve(name: string): unknown
  set(session: unknown, name: string): void
}

export interface AgentPresetsLike {
  list(): Promise<readonly { readonly id: string }[]>
  resolve(id?: string): Promise<{ readonly id: string; readonly failure?: string }>
}

export interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
}

/** Cordis context subset used by this plugin. */
export interface DshContextLike {
  effect(callback: () => (() => void) | void, label?: string): unknown
  get(name: string): unknown
  provide?(name: string, value: unknown): () => void
  on?(event: string, listener: (...args: any[]) => unknown): () => void
  inject?(names: string[], callback: (ctx: DshContextLike) => void): unknown
  readonly tools: { register(definition: ToolDefinitionLike): () => void }
  readonly commands: { register(definition: CommandDefinitionLike): () => void }
}

export type OneMode = 'observe' | 'active'

/** Core row configuration. */
export interface OneConfig {
  /** User-facing assistant name shown in every surface; the package id stays stable. */
  readonly displayName: string
  /**
   * Directory the assistant owns, created on demand. A Session without a `cwd`
   * belongs to no Workspace, and the DSH client then refuses to open it until
   * the user picks one, so the assistant must always have a home.
   */
  readonly assistantHomeRoot: string
  readonly mode: OneMode
  /**
   * Whether the assistant's own sends deliver while `mode` is `observe`.
   *
   * The assistant is the user's proxy, so its sends are the user speaking
   * through it; other agents stay bound by `mode`. `observe` records them
   * instead, which is what a dry-run profile wants.
   */
  readonly assistantSendMode: OneMode
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
  readonly panelEnabled: boolean
}

export type TaskMode = 'observe' | 'active'
export type TaskStatus = 'queued' | 'assigned' | 'running' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'done' | 'cancelled'
export type AssignmentStatus = 'assigned' | 'running' | 'waiting' | 'ready' | 'unknown' | 'done' | 'failed' | 'cancelled'
export type PromptStatus = 'pending' | 'sent' | 'unknown' | 'failed'
export type ReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
export type TaskOrigin = 'human' | 'agent' | 'source'
export type WorkspaceMode = 'lease' | 'shared'

/** Delegate row configuration. */
export interface DelegateConfig {
  readonly taskMode: TaskMode
  /** Whether a run started from the assistant session executes or only records. */
  readonly assistantRunMode: 'execute' | 'observe'
  readonly maxWorkers: number
  readonly workspaceMode: WorkspaceMode
  readonly leaseTtlMs: number
  readonly defaultWorkspaceRoot: string
  readonly workerAgentPreset: string
  readonly workerPermissionPreset: string
  readonly workerToolAllow: readonly string[]
  readonly workerToolDeny: readonly string[]
  readonly tokenBudget: number
  readonly retryLimit: number
  readonly reportMaxChars: number
  readonly commandTimeoutMs: number
  readonly defaultTaskPriority: number
  /** Maximum steps one run may create (1-20). */
  readonly runMaxTasks: number
  /** Default wall-clock budget one run may use. */
  readonly runDeadlineMs: number
  /** Window in which run events are merged into one decision. */
  readonly wakeCoalesceMs: number
  /** Host-side watchdog period for run projections and deadlines. */
  readonly watchdogTickMs: number
}

export interface TaskUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly lastUsageSeq: number
}

export interface TaskAssignment {
  readonly assignmentId: string
  readonly kind: 'initial' | 'retry'
  readonly sessionId: string
  readonly status: AssignmentStatus
  readonly promptStatus: PromptStatus
  readonly promptRequestId: string
  readonly permissionPreset?: string
  readonly agentPreset?: string
  readonly leaseId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly error?: string
}

export interface TaskInput {
  readonly inputId: string
  readonly kind: 'work' | 'recovery' | 'policy-changed' | 'human'
  readonly text: string
  readonly requestId: string
  readonly createdAt: number
  readonly deliveredAt?: number
  readonly deliveryStatus: 'pending' | 'sent' | 'unknown' | 'failed'
}

export interface TaskReport {
  readonly reportId: string
  readonly kind: ReportKind
  readonly summary: string
  readonly detail?: string
  readonly evidence?: string
  readonly assignmentId: string
  readonly sessionId: string
  readonly seq: number
  readonly createdAt: number
}

export interface TaskAttention {
  readonly kind: 'report' | 'blocked' | 'failed' | 'waiting' | 'budget' | 'mandate'
  readonly reason: string
  readonly since: number
}

export interface TaskSourceRef {
  readonly sourceId: string
  readonly threadId: string
  readonly externalId: string
  readonly url?: string
}

export interface TaskRecord {
  readonly taskId: string
  readonly title: string
  readonly goal: string
  readonly status: TaskStatus
  readonly origin: TaskOrigin
  readonly priority: number
  readonly cwd: string
  readonly workspaceMode: WorkspaceMode
  readonly assignments: readonly TaskAssignment[]
  readonly inputs: readonly TaskInput[]
  readonly latestReport?: TaskReport
  readonly attention?: TaskAttention
  readonly mandateId?: string
  readonly source?: TaskSourceRef
  /** The run this task is one step of, when it was planned by a run. */
  readonly runId?: string
  /**
   * The assistant header frozen at creation time, so a retry or recovery prompt
   * keeps the name the task was created under even after the assistant is renamed.
   */
  readonly assistantLabel?: string
  readonly usage: TaskUsage
  readonly tokenBudget: number
  readonly createdBy?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly blockedReason?: string
}

export interface LeaseRecord {
  readonly leaseId: string
  readonly workspace: string
  readonly ownerTaskId: string
  readonly ownerAssignmentId: string
  readonly status: 'active' | 'released' | 'expired'
  readonly acquiredAt: number
  readonly heartbeatAt: number
  readonly expiresAt: number
}

export interface ReportRecord extends TaskReport {
  readonly taskId: string
}

export interface CreateTaskInput {
  readonly title: string
  readonly goal: string
  readonly cwd?: string
  readonly priority?: number
  readonly tokenBudget?: number
  readonly origin?: TaskOrigin
  readonly createdBy?: string
  readonly mandateId?: string
  readonly source?: TaskSourceRef
  readonly runId?: string
}

export interface CreateTaskResult {
  readonly task: TaskRecord
  readonly created: boolean
  readonly observed: boolean
}

export interface AssignResult {
  readonly task: TaskRecord
  readonly started: boolean
  readonly waitingForSlot: boolean
  readonly waitingForLease: boolean
}

export interface TaskReportInput {
  readonly taskId: string
  readonly reportId: string
  readonly kind: ReportKind
  readonly summary: string
  readonly detail?: string
  readonly evidence?: string
  readonly callerSessionId?: string
  readonly seq?: number
}

export interface TaskControlInput {
  readonly taskId: string
  readonly action: 'complete' | 'cancel' | 'retry' | 'release'
  readonly reason?: string
  readonly callerSessionId?: string
}

export interface TaskView extends TaskRecord {
  readonly assignment?: TaskAssignment
}

export interface TaskCreateOptions {
  /** `assistant` is the user-directed assistant session; it bypasses `taskMode: observe`. */
  readonly source: 'tool' | 'command' | 'source' | 'assistant'
  /** Explicit posture for a run step; overrides the source-based default. */
  readonly mode?: 'execute' | 'observed'
  readonly callerSessionId?: string
  readonly callerCwd?: string
  readonly taskId?: string
  readonly autoAssign?: boolean
  /**
   * Origin header frozen onto the task, so every prompt this task ever sends
   * carries the name it was created under. Only the assistant path sets it.
   */
  readonly assistantLabel?: string
}

export interface PanelTask {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly detail?: string
  readonly updatedAt: number
  readonly cwd?: string
  readonly sessionId?: string
}

export interface TaskPanelSnapshot {
  readonly attention: readonly PanelTask[]
  readonly running: readonly PanelTask[]
  readonly history: readonly PanelTask[]
}

/** The task service the delegate row provides to ingress, tools, commands, and the panel. */
export interface TaskService {
  readonly mode: 'observe' | 'active'
  createTask(input: CreateTaskInput, options: TaskCreateOptions): Promise<CreateTaskResult>
  assign(taskId: string, options?: { readonly callerSessionId?: string }): Promise<AssignResult>
  getTask(taskId: string): TaskRecord | undefined
  listTasks(): TaskRecord[]
  report(input: TaskReportInput): Promise<TaskRecord>
  control(input: TaskControlInput): Promise<TaskRecord>
  addInput(taskId: string, text: string, kind: TaskInput['kind']): Promise<TaskRecord>
  blockTask(taskId: string, reason: string, kind?: TaskAttention['kind']): Promise<TaskRecord>
  snapshot(): TaskPanelSnapshot
  health(): { readonly leases: number; readonly workers: number; readonly maxWorkers: number }
  subscribe(listener: () => void): () => void
}

export type RunMode = 'execute' | 'observed'
export type RunOrigin = 'human' | 'assistant' | 'agent'
export type RunStatus = 'active' | 'needs-you' | 'done' | 'failed' | 'cancelled' | 'exhausted'
export type RunWakeReason = 'done' | 'needs-you' | 'failed'

/** One planned step. The task row owns its state; this is the plan only. */
export interface RunStep {
  readonly index: number
  readonly taskId: string
  readonly title: string
  readonly goal: string
  readonly cwd?: string
}

export interface RunLimits {
  readonly maxTasks: number
  readonly deadlineMs: number
}

/** Durable goal ledger row. */
export interface RunRecord {
  readonly runId: string
  readonly goal: string
  readonly title: string
  readonly cwd: string
  readonly cwdLabel: string
  readonly origin: RunOrigin
  readonly mode: RunMode
  readonly assistantSessionId?: string
  readonly status: RunStatus
  readonly paused: boolean
  readonly pauseReason?: string
  readonly steps: readonly RunStep[]
  readonly limits: RunLimits
  readonly deadlineAt: number
  /** Monotonic counter for activity rows. */
  readonly activitySeq: number
  /** Last observed task status per step, so a transition is written once. */
  readonly seen: Readonly<Record<string, string>>
  readonly attention?: { readonly reason: string; readonly taskId?: string; readonly since: number }
  readonly verdict?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt?: number
}

export interface RunStepView extends RunStep {
  readonly status: TaskStatus
  readonly latestReport?: string
  readonly attention?: string
  readonly updatedAt?: number
}

/** A run plus the current projection of its steps. */
export interface RunView {
  readonly runId: string
  readonly goal: string
  readonly title: string
  readonly cwd: string
  readonly cwdLabel: string
  readonly origin: RunOrigin
  readonly mode: RunMode
  readonly assistantSessionId?: string
  readonly status: RunStatus
  readonly paused: boolean
  readonly pauseReason?: string
  readonly steps: readonly RunStepView[]
  readonly limits: RunLimits
  readonly deadlineAt: number
  readonly attention?: { readonly reason: string; readonly taskId?: string; readonly since: number }
  readonly verdict?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt?: number
  readonly progress: { readonly done: number; readonly total: number }
  readonly elapsedMs: number
}

export type RunActivityKind =
  | 'run-started'
  | 'step-dispatched'
  | 'step-done'
  | 'step-failed'
  | 'step-blocked'
  | 'run-done'
  | 'run-failed'
  | 'run-paused'
  | 'run-resumed'
  | 'run-cancelled'
  | 'run-exhausted'
  | 'quiet-suppressed'
  | 'wake-sent'
  | 'wake-suppressed'
  | 'recovered'

/** One user-facing activity row; `audit` stays operator-facing. */
export interface RunActivityRecord {
  readonly activityId: string
  readonly runId: string
  readonly seq: number
  readonly taskId?: string
  readonly cwd: string
  readonly at: number
  readonly kind: RunActivityKind
  readonly level: 'info' | 'attention' | 'error'
  readonly title: string
  readonly detail?: string
  readonly dedupeKey?: string
}

export interface RunWakeRecord {
  readonly wakeId: string
  readonly runId: string
  readonly reason: RunWakeReason
  readonly requestId: string
  readonly status: 'pending' | 'sending' | 'sent' | 'suppressed' | 'failed' | 'unknown'
  readonly suppressedBy?: string
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly error?: string
}

export interface RunStartInput {
  readonly goal: string
  readonly title?: string
  readonly cwd?: string
  readonly steps?: readonly { readonly title: string; readonly goal: string; readonly cwd?: string }[]
  readonly maxTasks?: number
  readonly deadlineMs?: number
  readonly idempotencyKey?: string
  readonly origin: RunOrigin
  readonly callerSessionId?: string
  readonly callerCwd?: string
  readonly mode?: RunMode
}

export interface RunStartResult {
  readonly run: RunView
  readonly observed: boolean
}

export interface RunControlInput {
  readonly runId: string
  readonly action: 'pause' | 'resume' | 'cancel'
  readonly reason?: string
}

export interface RunGroup {
  readonly cwd: string
  readonly label: string
  readonly runs: readonly RunView[]
  readonly counts: {
    readonly active: number
    readonly needsYou: number
    readonly done: number
    readonly failed: number
    readonly paused: number
  }
}

export interface RunSummary {
  readonly generatedAt: number
  readonly assistant: { readonly sessionId: string | null; readonly displayName: string }
  readonly pausedAll: boolean
  readonly groups: readonly RunGroup[]
  readonly totals: {
    readonly active: number
    readonly needsYou: number
    readonly done: number
    readonly failed: number
    readonly paused: number
  }
}

/** The run service the delegate row provides to tools, commands, and the panel. */
export interface RunService {
  readonly mode: 'execute' | 'observe'
  start(input: RunStartInput): Promise<RunStartResult>
  get(runId: string): RunView | undefined
  list(): RunView[]
  summary(): RunSummary
  activities(runId?: string, limit?: number): RunActivityRecord[]
  control(input: RunControlInput): Promise<RunView>
  subscribe(listener: () => void): () => void
}

/** Intake row configuration. */
export type AcceptMode = 'off' | 'observe' | 'auto'

export interface PolicyRuleConfig {
  readonly id: string
  readonly text: string
  readonly required: boolean
  readonly denyPattern?: string
}

export interface AssessmentConfig {
  readonly enabled: boolean
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly timeoutMs: number
}

export interface GithubSourceConfig {
  readonly enabled: boolean
  readonly webhookPath: string
  readonly secretEnv: string
  readonly tokenEnv: string
  readonly repositories: readonly string[]
  readonly allowedActors: readonly string[]
  readonly botLogins: readonly string[]
  readonly requireMention: boolean
  readonly mentionLogin: string
  readonly eventTypes: readonly string[]
  readonly pollEnabled: boolean
  readonly pollIntervalMs: number
  readonly apiBaseUrl: string
  readonly requireHostAuth: boolean
}

/** Ingress row configuration. */
export interface IngressConfig {
  readonly acceptMode: AcceptMode
  readonly maxBodyBytes: number
  readonly confirmReply: boolean
  readonly taskWorkspaceRoot: string
  readonly taskBudgetTokens: number
  readonly policyStrength: 'advisory' | 'standard' | 'strict'
  readonly policyScope: string
  readonly policyRules: readonly PolicyRuleConfig[]
  readonly assessment: AssessmentConfig
  readonly github: GithubSourceConfig
}

export interface DispatchEvent {
  readonly id: string
  readonly kind: 'issues' | 'issue_comment' | 'pull_request' | 'pull_request_review_comment'
  readonly sourceId: string
  readonly repository: string
  readonly actor: string
  readonly action: string
  readonly threadId: string
  readonly externalId: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url?: string
  readonly isPullRequest: boolean
  readonly createdAt: number
  readonly deliveryId?: string
}

export interface TriggerRecord {
  readonly triggerId: string
  readonly sourceId: string
  readonly repository: string
  readonly eventKind: string
  readonly externalEventId: string
  readonly actor: string
  readonly threadId: string
  readonly receivedAt: number
  readonly gate: 'pass' | 'reject' | 'ignore'
  readonly gateReason?: string
  readonly evalId?: string
  readonly decision?: 'would-accept' | 'accept' | 'decline' | 'observe-only' | 'no-delegate'
  readonly taskId?: string
  readonly payload?: string
}

export interface ThreadRecord {
  readonly threadId: string
  readonly sourceId: string
  readonly repository: string
  readonly externalId: string
  readonly number: number
  readonly title: string
  readonly url?: string
  readonly isPullRequest: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastTriggerId?: string
  readonly evalId?: string
  readonly taskId?: string
  readonly accepted: number
  readonly declined: number
}

export interface RuleAssessment {
  readonly ruleId: string
  readonly pass: boolean
  readonly note?: string
}

export interface EvalRecord {
  readonly evalId: string
  readonly triggerId: string
  readonly threadId: string
  readonly status: 'queued' | 'running' | 'settled'
  readonly policyVersion: string
  readonly gate: 'pass' | 'reject'
  readonly gateReason?: string
  readonly assessment?: readonly RuleAssessment[]
  readonly outcome?: 'accept' | 'decline' | 'would-accept'
  readonly reason?: string
  readonly payload?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt?: number
}

export interface DecisionRecord {
  readonly decisionId: string
  readonly evalId: string
  readonly threadId: string
  readonly triggerId: string
  readonly outcome: 'accept' | 'decline' | 'would-accept' | 'observe-only' | 'no-delegate'
  readonly reasons: readonly string[]
  readonly policyVersion: string
  readonly taskId?: string
  readonly mandateId?: string
  readonly createdAt: number
}

export interface PolicyRecord {
  readonly policyId: string
  readonly version: string
  readonly strength: 'advisory' | 'standard' | 'strict'
  readonly scope: string
  readonly rules: readonly PolicyRuleConfig[]
  readonly hash: string
  readonly createdAt: number
  readonly supersededBy?: string
}

export interface MandateRecord {
  readonly mandateId: string
  readonly taskId: string
  readonly threadId: string
  readonly policyVersion: string
  readonly strength: 'advisory' | 'standard' | 'strict'
  readonly scope: string
  readonly basis: readonly RuleAssessment[]
  readonly createdAt: number
}

export interface DeliveryRecord {
  readonly deliveryId: string
  readonly sourceId: string
  readonly direction: 'in' | 'out'
  readonly externalId: string
  readonly status: 'received' | 'duplicate' | 'accepted' | 'rejected' | 'failed' | 'sent'
  readonly at: number
  readonly detail?: string
}

export interface CursorRecord {
  readonly cursorId: string
  readonly sourceId: string
  readonly repository: string
  readonly value: string
  readonly etag?: string
  readonly updatedAt: number
}

export interface SubscriptionRecord {
  readonly subscriptionId: string
  readonly taskId: string
  readonly threadId: string
  readonly sourceId: string
  readonly mode: 'reply' | 'none'
  readonly createdAt: number
}

export interface IntakeResult {
  readonly trigger?: TriggerRecord
  readonly eval?: EvalRecord
  readonly decision?: DecisionRecord
  readonly taskId?: string
  readonly status: 'ignored' | 'duplicate' | 'observed' | 'accepted' | 'declined' | 'deferred'
  readonly reason?: string
}

export interface IntakePanelSnapshot {
  readonly recent: readonly PanelItem[]
  readonly acceptMode: AcceptMode
  readonly policyVersion?: string
  readonly pendingEvals: number
  readonly lastPollAt?: number
  readonly error?: string
}

/** The intake service the ingress row provides to the panel. */
export interface IntakeService {
  handle(event: DispatchEvent): Promise<IntakeResult>
  snapshot(): IntakePanelSnapshot
  decisions(limit?: number): DecisionRecord[]
  policy(): PolicyRecord | undefined
  health(): { readonly acceptMode: AcceptMode; readonly policyVersion?: string; readonly lastPollAt?: number; readonly error?: string }
  pollNow(): Promise<number>
  subscribe(listener: () => void): () => void
}

export interface PanelItem {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly detail?: string
  readonly updatedAt: number
  readonly sessionId?: string
  readonly cwd?: string
}

export interface PanelOverview {
  readonly generatedAt: number
  /** Resolved assistant name from the persisted setting, else the row default. */
  readonly displayName: string
  /** The name the row configuration declares; the UI uses it as the reset target. */
  readonly defaultDisplayName: string
  readonly attention: readonly PanelItem[]
  readonly running: readonly PanelItem[]
  readonly history: readonly PanelItem[]
  readonly runs?: {
    readonly active: number
    readonly needsYou: number
    readonly done: number
    readonly failed: number
    readonly paused: number
    readonly mode: 'execute' | 'observe'
  }
  readonly health: {
    readonly storage: 'persistent' | 'memory'
    readonly core: 'ready' | 'degraded'
    readonly delegate: 'active' | 'observe' | 'unavailable'
    readonly ingress: 'off' | 'observe' | 'auto' | 'unavailable'
    readonly policyVersion?: string
    readonly leases: number
    readonly workers: number
    readonly maxWorkers: number
    readonly lastError?: string
  }
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
  /** The raw text the caller supplied; conflict checks and audit read this. */
  readonly text: string
  /** The text actually handed to the host: `text` plus the origin header, when one applies. */
  readonly deliveredText?: string
  /** The origin header that was applied, kept so a retry delivers the same bytes. */
  readonly senderLabel?: string
  readonly mode: 'queue' | 'steer'
  readonly source: 'tool' | 'command' | 'wake' | 'assistant'
  readonly status: OutboxStatus
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly error?: string
}

/** One persisted user preference row, keyed by namespace and key. */
export interface SettingRecord {
  readonly namespace: string
  readonly key: string
  readonly value: string
  readonly updatedAt: number
  readonly updatedBy: 'human' | 'agent' | 'system'
}

/** Append-only audit record. */
export interface AuditRecord {
  readonly id: string
  readonly at: number
  readonly action: string
  readonly actorSessionId?: string
  readonly targetSessionId?: string
  readonly taskId?: string
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
  /** `assistant` is the user-directed assistant session; it carries a visible origin tag. */
  readonly source: 'tool' | 'command' | 'wake' | 'assistant'
  /**
   * Visible header prepended to the delivered text. Honored only for
   * `source: 'assistant'`, so no other path can forge an assistant origin.
   */
  readonly senderLabel?: string
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

/** What the assistant asks `one_session_create` for. */
export interface SessionCreateInput {
  readonly cwd: string
  /** The first message the new session receives, tagged with the assistant's header. */
  readonly message: string
  /**
   * Plugin-side label only. DSH derives the conversation title itself and
   * `sessionController.create` has no title field, so this never renames the chat.
   */
  readonly title?: string
  readonly agentPreset?: string
  readonly idempotencyKey?: string
  readonly callerSessionId?: string
  /** The assistant origin header applied to the first message; set by the tool gate. */
  readonly senderLabel?: string
  readonly signal?: AbortSignal
}

export interface SessionCreateResult {
  readonly sessionId: string
  readonly title?: string
  readonly cwd: string
  /** False when an earlier call with the same idempotency key had already created it. */
  readonly created: boolean
  readonly messageStatus: OutboxStatus
  readonly requestId?: string
  readonly observed: boolean
  readonly error?: string
}
