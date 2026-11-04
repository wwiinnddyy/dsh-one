/** Task delegation runtime: state machine, leases, worker slots, budget, recovery, retry. */

import type {
  AgentLike,
  AssignResult,
  CreateTaskInput,
  CreateTaskResult,
  DelegateConfig,
  DshContextLike,
  PanelTask,
  PermissionPresetsLike,
  ResolvedAgent,
  SessionControllerLike,
  TaskAssignment,
  TaskAttention,
  TaskControlInput,
  TaskCreateOptions,
  TaskInput,
  TaskRecord,
  TaskReportInput,
  TaskReport,
  TaskService,
  TaskUsage,
  TaskView,
} from '../types.js'
import { OneError } from '../types.js'
import type { OneStore } from '../store/store.js'
import { emptyUsage } from '../store/store.js'
import type { OneCore } from '../core/registry.js'
import {
  canonicalWorkspace,
  classifyError,
  hashOf,
  nextId,
  now as systemNow,
  preview,
  taskInputRequestId,
} from '../util.js'

export interface TaskRuntimeHooks {
  readonly now?: () => number
}

export type CreateTaskOptions = TaskCreateOptions

type Listener = () => void

const ACTIVE_ASSIGNMENT_STATUSES: readonly TaskAssignment['status'][] = ['assigned', 'running', 'waiting']

/** The task service other rows and the panel read. */
export type TaskRuntimeService = TaskService

export class TaskRuntime implements TaskService {
  readonly mode: 'observe' | 'active'
  private readonly ctx: DshContextLike
  private readonly config: DelegateConfig
  private readonly store: OneStore
  private readonly core: OneCore
  private readonly now: () => number
  private readonly listeners = new Set<Listener>()
  private chain: Promise<unknown> = Promise.resolve()
  private pumping = false

  constructor(
    ctx: DshContextLike,
    config: DelegateConfig,
    store: OneStore,
    core: OneCore,
    hooks: TaskRuntimeHooks = {},
  ) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.core = core
    this.now = hooks.now ?? systemNow
    this.mode = config.taskMode
  }

  get controller(): SessionControllerLike | undefined {
    return this.ctx.get('sessionController') as SessionControllerLike | undefined
  }

  /** Recover interrupted assignments and leases once the host has settled. */
  async start(): Promise<void> {
    await this.enqueue(async () => {
      const at = this.now()
      for (const task of this.store.listTasks()) {
        if (isTerminal(task.status)) continue
        const assignments = task.assignments.map(assignment => {
          if (!ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) return assignment
          return {
            ...assignment,
            status: 'unknown' as const,
            promptStatus: 'unknown' as const,
            updatedAt: at,
            error: 'host restarted while the assignment was active',
          }
        })
          .map(assignment => assignment)
        const interrupted = assignments.some((assignment, index) => task.assignments[index]?.status !== assignment.status)
        if (!interrupted) continue
        const unseen = task.assignments.filter(assignment => assignment.promptStatus === 'pending').length > 0
        await this.store.putTask({
          ...task,
          assignments,
          status: 'blocked',
          blockedReason: 'host-restarted',
          attention: { kind: 'blocked', reason: 'host restarted while work was assigned; retry after checking state', since: at },
          updatedAt: at,
        })
        await this.core.audit({
          action: 'task_recovered',
          taskId: task.taskId,
          outcome: 'error',
          detail: unseen ? 'assignment and unsent input marked unknown' : 'running assignment marked unknown',
        })
      }
      for (const lease of this.store.listLeases()) {
        if (lease.status !== 'active') continue
        await this.store.putLease({ ...lease, status: 'expired', heartbeatAt: at, expiresAt: at })
      }
    })
    this.emit()
  }

  /** Create one task. Agent-initiated tools observe by default. */
  async createTask(input: CreateTaskInput, options: CreateTaskOptions): Promise<CreateTaskResult> {
    if (options.source === 'tool' && this.config.taskMode === 'observe') {
      await this.core.audit({
        action: 'task_observed',
        actorSessionId: options.callerSessionId,
        outcome: 'observed',
        detail: `${input.title}: ${preview(input.goal)}`,
      })
      const observed: TaskRecord = this.placeholder(input, options)
      return { task: observed, created: false, observed: true }
    }
    const result = await this.enqueue(async () => {
      if (options.taskId !== undefined) {
        const existing = this.store.getTask(options.taskId)
        if (existing !== undefined) return { task: existing, created: false, observed: false }
      }
      const cwd = this.resolveWorkspace(input.cwd ?? this.config.defaultWorkspaceRoot, options.callerCwd, options.callerSessionId)
      const at = this.now()
      const taskId = options.taskId ?? nextId('task')
      const inputId = 'input-initial'
      const workInput: TaskInput = {
        inputId,
        kind: 'work',
        text: this.workText(taskId, input.title, input.goal, cwd),
        requestId: taskInputRequestId(taskId, inputId),
        createdAt: at,
        deliveryStatus: 'pending',
      }
      const task: TaskRecord = {
        taskId,
        title: input.title,
        goal: input.goal,
        status: 'queued',
        origin: input.origin ?? (options.source === 'tool' ? 'agent' : 'human'),
        priority: input.priority ?? this.config.defaultTaskPriority,
        cwd,
        workspaceMode: this.config.workspaceMode,
        assignments: [],
        inputs: [workInput],
        ...(input.mandateId === undefined ? {} : { mandateId: input.mandateId }),
        ...(input.source === undefined ? {} : { source: input.source }),
        usage: emptyUsage(),
        tokenBudget: input.tokenBudget ?? this.config.tokenBudget,
        ...(input.createdBy ?? options.callerSessionId) === undefined
          ? {}
          : { createdBy: input.createdBy ?? options.callerSessionId as string },
        createdAt: at,
        updatedAt: at,
      }
      await this.store.putTask(task)
      await this.core.audit({
        action: 'task_created',
        actorSessionId: options.callerSessionId,
        taskId,
        outcome: 'ok',
        detail: `${task.origin}: ${preview(input.title)}`,
      })
      return { task, created: true, observed: false }
    })
    this.emit()
    if (options.autoAssign === true) await this.assign(result.task.taskId, { callerSessionId: options.callerSessionId })
    return result
  }

  /** Make one task eligible and try to start it immediately. */
  async assign(taskId: string, options: { callerSessionId?: string } = {}): Promise<AssignResult> {
    const task = this.requireTask(taskId)
    if (isTerminal(task.status)) throw new OneError('one/task-terminal', `task "${taskId}" is ${task.status}`, { taskId })
    if (task.status === 'blocked') throw new OneError('one/task-blocked', 'retry a blocked task instead of assigning it', { taskId })
    if (task.status !== 'queued') {
      const assignment = task.assignments.find(item => ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
      return {
        task,
        started: assignment !== undefined,
        waitingForSlot: false,
        waitingForLease: false,
      }
    }
    const capacityReason = await this.enqueue(async () => await this.pumpInternal())
    const current = this.requireTask(taskId)
    await this.core.audit({
      action: 'task_assign_requested',
      actorSessionId: options.callerSessionId,
      taskId,
      outcome: 'ok',
      detail: capacityReason,
    })
    this.emit()
    const assignment = current.assignments.find(item => ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
    return {
      task: current,
      started: assignment !== undefined,
      waitingForSlot: assignment === undefined && capacityReason === 'slot',
      waitingForLease: assignment === undefined && capacityReason === 'lease',
    }
  }

  /** Pump the queue: start as many eligible tasks as the slot and lease rules allow. */
  async pump(): Promise<void> {
    await this.enqueue(async () => {
      await this.pumpInternal()
    })
    this.emit()
  }

  /** Refresh active leases and retry lease-blocked queue entries. */
  async heartbeat(): Promise<void> {
    await this.enqueue(async () => {
      for (const lease of this.store.listLeases()) {
        if (lease.status !== 'active') continue
        const at = this.now()
        await this.store.putLease({ ...lease, heartbeatAt: at, expiresAt: at + this.config.leaseTtlMs })
      }
      await this.pumpInternal()
    })
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.store.getTask(taskId)
  }

  listTasks(): TaskRecord[] {
    return this.store.listTasks()
  }

  listViews(): TaskView[] {
    return this.store.listTasks().map(task => ({
      ...task,
      assignment: task.assignments.find(item => ACTIVE_ASSIGNMENT_STATUSES.includes(item.status)),
    }))
  }

  /** Structured worker report; `reportId` is the idempotency key. */
  async report(input: TaskReportInput): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId)
    const existing = this.store.getReport(input.taskId, input.reportId)
    if (existing !== undefined) return this.requireTask(input.taskId)
    const active = task.assignments.find(item => ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
    if (input.callerSessionId !== undefined && active !== undefined && active.sessionId !== input.callerSessionId) {
      throw new OneError('one/report-wrong-session', 'only the current worker session may report this task', {
        taskId: input.taskId,
        caller: input.callerSessionId,
        worker: active.sessionId,
      })
    }
    const assignment = active ?? task.assignments[task.assignments.length - 1]
    if (assignment === undefined) throw new OneError('one/no-assignment', 'this task has no assignment to report on', { taskId: input.taskId })
    const at = this.now()
    const summary = truncate(input.summary, this.config.reportMaxChars)
    const detail = input.detail === undefined ? undefined : truncate(input.detail, this.config.reportMaxChars)
    const report: TaskReport = {
      reportId: input.reportId,
      kind: input.kind,
      summary,
      ...(detail === undefined ? {} : { detail }),
      ...(input.evidence === undefined ? {} : { evidence: truncate(input.evidence, this.config.reportMaxChars) }),
      assignmentId: assignment.assignmentId,
      sessionId: input.callerSessionId ?? assignment.sessionId,
      seq: input.seq ?? -1,
      createdAt: at,
    }
    await this.store.putReport({ ...report, taskId: input.taskId })
    const nextStatus = reportStatus(input.kind)
    const attention = reportAttention(input.kind, summary, at)
    const updated = await this.store.updateTask(input.taskId, current => {
      if (current.latestReport?.reportId === input.reportId) return current
      return {
        ...current,
        status: nextStatus,
        latestReport: report,
        ...(attention === undefined ? { attention: undefined } : { attention }),
        assignments: current.assignments.map(item =>
          item.assignmentId === assignment.assignmentId
            ? { ...item, status: reportAssignmentStatus(input.kind), updatedAt: at, error: input.kind === 'failed' ? summary : item.error }
            : item,
        ),
        updatedAt: at,
      }
    })
    if (input.kind !== 'progress') await this.releaseLeasesForTask(task.taskId)
    if (input.kind !== 'progress') void this.pump()
    await this.core.audit({
      action: `task_report_${input.kind}`,
      taskId: task.taskId,
      targetSessionId: report.sessionId,
      outcome: input.kind === 'failed' || input.kind === 'blocked' ? 'error' : 'ok',
      detail: preview(summary),
    })
    this.emit()
    return updated
  }

  /** Human control over a task: complete, cancel, retry, or release a stuck lease. */
  async control(input: TaskControlInput): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId)
    const at = this.now()
    if (input.action === 'complete') {
      if (task.status !== 'ready') throw new OneError('one/task-not-ready', `task "${task.taskId}" is ${task.status}`, { taskId: task.taskId })
      await this.cancelAgent(task)
      await this.releaseLeasesForTask(task.taskId)
      const updated = await this.store.updateTask(task.taskId, current => ({
        ...current,
        status: 'done',
        attention: undefined,
        assignments: finishAssignments(current, 'done', at),
        completedAt: at,
        updatedAt: at,
      }))
      await this.core.audit({ action: 'task_completed', taskId: task.taskId, outcome: 'ok', detail: input.reason })
      this.emit()
      void this.pump()
      return updated
    }
    if (input.action === 'cancel') {
      if (isTerminal(task.status)) return task
      await this.cancelAgent(task)
      await this.releaseLeasesForTask(task.taskId)
      const updated = await this.store.updateTask(task.taskId, current => ({
        ...current,
        status: 'cancelled',
        attention: undefined,
        blockedReason: input.reason ?? 'cancelled by operator',
        assignments: finishAssignments(current, 'cancelled', at),
        completedAt: at,
        updatedAt: at,
      }))
      await this.core.audit({ action: 'task_cancelled', taskId: task.taskId, outcome: 'ok', detail: input.reason })
      this.emit()
      void this.pump()
      return updated
    }
    if (input.action === 'release') {
      await this.releaseLeasesForTask(task.taskId)
      await this.core.audit({ action: 'task_lease_released', taskId: task.taskId, outcome: 'ok', detail: input.reason })
      this.emit()
      return this.requireTask(task.taskId)
    }
    // retry
    if (task.status !== 'blocked' && task.status !== 'failed') {
      throw new OneError('one/task-not-retryable', `retry requires blocked or failed, got ${task.status}`, { taskId: task.taskId })
    }
    const retries = task.assignments.filter(item => item.kind === 'retry').length
    if (retries >= this.config.retryLimit) {
      throw new OneError('one/retry-limit', `task "${task.taskId}" reached the retry limit`, { taskId: task.taskId, limit: this.config.retryLimit })
    }
    const inputId = `input-retry-${retries + 1}`
    const recovery: TaskInput = {
      inputId,
      kind: 'recovery',
      text: this.recoveryText(task, input.reason),
      requestId: taskInputRequestId(task.taskId, inputId),
      createdAt: at,
      deliveryStatus: 'pending',
    }
    const updated = await this.store.updateTask(task.taskId, current => ({
      ...current,
      status: 'queued',
      attention: undefined,
      blockedReason: undefined,
      inputs: [...current.inputs, recovery],
      assignments: current.assignments.map(item =>
        ACTIVE_ASSIGNMENT_STATUSES.includes(item.status) ? { ...item, status: 'failed' as const, updatedAt: at } : item,
      ),
      updatedAt: at,
    }))
    await this.core.audit({ action: 'task_retry_queued', taskId: task.taskId, outcome: 'ok', detail: preview(input.reason ?? 'operator retry') })
    await this.pump()
    return this.requireTask(updated.taskId)
  }

  /** Append a policy-change input and deliver it to the running worker when present. */
  async addInput(taskId: string, text: string, kind: TaskInput['kind']): Promise<TaskRecord> {
    const task = this.requireTask(taskId)
    if (isTerminal(task.status)) return task
    const at = this.now()
    const inputId = `input-${kind}-${hashOf({ taskId, at, text })}`
    const entry: TaskInput = {
      inputId,
      kind,
      text,
      requestId: taskInputRequestId(taskId, inputId),
      createdAt: at,
      deliveryStatus: 'pending',
    }
    const updated = await this.store.updateTask(taskId, current => ({
      ...current,
      inputs: [...current.inputs, entry],
      updatedAt: at,
    }))
    const active = updated.assignments.find(item => ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
    if (active !== undefined) await this.deliverInput(updated, active, entry, 'steer')
    this.emit()
    return this.requireTask(taskId)
  }

  /** Force a task into blocked with an attention row (mandate/policy failures). */
  async blockTask(taskId: string, reason: string, kind: TaskAttention['kind'] = 'mandate'): Promise<TaskRecord> {
    const task = this.requireTask(taskId)
    if (isTerminal(task.status)) return task
    const at = this.now()
    await this.cancelAgent(task)
    await this.releaseLeasesForTask(taskId)
    const updated = await this.store.updateTask(taskId, current => ({
      ...current,
      status: 'blocked',
      blockedReason: reason,
      attention: { kind, reason, since: at },
      updatedAt: at,
      assignments: current.assignments.map(item =>
        ACTIVE_ASSIGNMENT_STATUSES.includes(item.status) ? { ...item, status: 'unknown' as const, updatedAt: at } : item,
      ),
    }))
    await this.core.audit({ action: 'task_blocked', taskId, outcome: 'error', detail: reason })
    this.emit()
    return updated
  }

  /** Session event feed from the host. */
  handleSessionEvent(session: { readonly id?: string } | undefined, event: unknown): void {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const record = event as { type?: string; seq?: number; data?: Record<string, unknown> }
    if (record.type !== 'assistant/message' && record.type !== 'turn/end') return
    const taskId = this.store.listTasks().find(item =>
      item.assignments.some(assignment => assignment.sessionId === sessionId && ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)),
    )?.taskId
    void this.enqueue(async () => {
      const task = this.store.listTasks().find(item =>
        item.assignments.some(assignment => assignment.sessionId === sessionId && ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)),
      )
      if (task === undefined) return
      if (record.type === 'assistant/message') await this.accumulateUsage(task, sessionId, record)
      else await this.onTurnEnd(task, sessionId, record)
    })
      .then(() => this.emit())
      .catch(error => {
        void this.core.audit({ action: 'task_event_failed', taskId, outcome: 'error', detail: classifyError(error).message })
      })
  }

  snapshot(): { attention: PanelTask[]; running: PanelTask[]; history: PanelTask[] } {
    const tasks = this.store.listTasks()
    const attention: PanelTask[] = []
    const running: PanelTask[] = []
    const history: PanelTask[] = []
    for (const task of tasks) {
      const item: PanelTask = {
        id: task.taskId,
        title: task.title,
        status: task.status,
        detail: task.latestReport?.summary ?? task.blockedReason,
        updatedAt: task.updatedAt,
        cwd: task.cwd,
        sessionId: task.assignments.find(a => ACTIVE_ASSIGNMENT_STATUSES.includes(a.status))?.sessionId,
      }
      if (task.attention !== undefined || task.status === 'ready') attention.push(item)
      else if (task.status === 'assigned' || task.status === 'running' || task.status === 'waiting') running.push(item)
      else history.push(item)
    }
    return {
      attention: attention.sort((a, b) => b.updatedAt - a.updatedAt),
      running: running.sort((a, b) => b.updatedAt - a.updatedAt),
      history: history.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
    }
  }

  health(): { leases: number; workers: number; maxWorkers: number } {
    const at = this.now()
    const leases = this.store.listLeases().filter(lease => lease.status === 'active' && lease.expiresAt > at).length
    const workers = this.store.listTasks().filter(task =>
      task.assignments.some(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)),
    ).length
    return { leases, workers, maxWorkers: this.config.maxWorkers }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A panel observer must not break task transitions.
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Queue pump. Returns why no assignment started when the target task did not. */
  private async pumpInternal(): Promise<'started' | 'slot' | 'lease' | 'empty'> {
    if (this.pumping) return 'slot'
    this.pumping = true
    try {
      this.expireLeases()
      const tasks = this.store.listTasks().filter(task => task.status === 'queued')
      if (tasks.length === 0) return 'empty'
      const humanQueued = tasks.some(task => task.origin === 'human')
      const active = this.store.listTasks().filter(task =>
        task.assignments.some(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)),
      )
      const humanActive = active.some(task => task.origin === 'human')
      const capacity = this.config.maxWorkers + (humanQueued || humanActive ? 1 : 0)
      if (active.length >= capacity) return 'slot'
      const ordered = [...tasks].sort((a, b) =>
        Number(b.origin === 'human') - Number(a.origin === 'human')
        || b.priority - a.priority
        || a.createdAt - b.createdAt,
      )
      let reason: 'started' | 'slot' | 'lease' = 'slot'
      let started = active.length
      for (const task of ordered) {
        if (started >= capacity) return reason === 'started' ? 'started' : 'slot'
        if (this.leaseConflict(task, undefined)) {
          reason = 'lease'
          continue
        }
        const result = await this.startTask(task)
        if (result) started += 1
        reason = 'started'
      }
      return reason
    } finally {
      this.pumping = false
    }
  }

  private async startTask(task: TaskRecord): Promise<boolean> {
    if (this.controller === undefined) {
      await this.failTask(task, 'sessionController is unavailable', 'blocked')
      return false
    }
    if (task.tokenBudget > 0 && task.usage.totalTokens >= task.tokenBudget) {
      await this.blockTask(task.taskId, 'budget-exceeded', 'budget')
      return false
    }
    const input = task.inputs.find(item => item.deliveryStatus === 'pending')
    if (input === undefined) return false
    const at = this.now()
    const assignmentId = nextId('assign')
    const lease = await this.acquireLease(task, assignmentId)
    if (task.workspaceMode === 'lease' && lease === undefined) return false
    let sessionId: string
    try {
      const created = await this.controller.create({
        cwd: task.cwd,
        ...(this.config.workerAgentPreset === '' ? {} : { agentPreset: this.config.workerAgentPreset }),
      })
      sessionId = created.sessionId
    } catch (error: unknown) {
      await this.releaseLease(lease)
      await this.failTask(task, `worker session creation failed: ${classifyError(error).message}`, 'blocked')
      return false
    }
    const assignment: TaskAssignment = {
      assignmentId,
      kind: input.kind === 'recovery' ? 'retry' : 'initial',
      sessionId,
      status: 'assigned',
      promptStatus: 'pending',
      promptRequestId: input.requestId,
      ...(this.config.workerPermissionPreset === '' ? {} : { permissionPreset: this.config.workerPermissionPreset }),
      ...(this.config.workerAgentPreset === '' ? {} : { agentPreset: this.config.workerAgentPreset }),
      ...(lease === undefined ? {} : { leaseId: lease.leaseId }),
      createdAt: at,
      updatedAt: at,
    }
    const assigned = await this.store.updateTask(task.taskId, current => ({
      ...current,
      status: 'assigned',
      attention: undefined,
      blockedReason: undefined,
      assignments: [...current.assignments, assignment],
      updatedAt: at,
    }))
    await this.core.trustWorkerSession({ sessionId, cwd: task.cwd, title: `one: ${task.title}` })
    let agent: AgentLike | undefined
    try {
      agent = await this.resolveAgent(sessionId)
    } catch (error: unknown) {
      await this.failAssignment(assigned, assignment, `worker agent could not be resolved: ${classifyError(error).message}`, 'blocked')
      return false
    }
    if (agent === undefined) {
      await this.failAssignment(assigned, assignment, 'worker agent could not be resolved', 'blocked')
      return false
    }
    await this.applyWorkerComposition(agent, assignment)
    const delivered = await this.deliverInput(assigned, assignment, input, 'queue')
    return delivered
  }

  private async deliverInput(
    task: TaskRecord,
    assignment: TaskAssignment,
    input: TaskInput,
    mode: 'queue' | 'steer',
  ): Promise<boolean> {
    const controller = this.controller
    if (controller === undefined) return false
    const at = this.now()
    await this.store.updateTask(task.taskId, current => ({
      ...current,
      status: 'running',
      updatedAt: at,
      assignments: current.assignments.map(item =>
        item.assignmentId === assignment.assignmentId
          ? { ...item, status: 'running', promptStatus: 'pending', updatedAt: at }
          : item,
      ),
      inputs: current.inputs.map(item =>
        item.inputId === input.inputId ? { ...item, deliveryStatus: 'pending', deliveredAt: at } : item,
      ),
    }))
    try {
      await controller.prompt({
        requestId: input.requestId,
        sessionId: assignment.sessionId,
        mode,
        content: [{ type: 'text', text: input.text }],
      }, AbortSignal.timeout(this.config.commandTimeoutMs))
      await this.store.updateTask(task.taskId, current => ({
        ...current,
        status: 'running',
        updatedAt: this.now(),
        assignments: current.assignments.map(item =>
          item.assignmentId === assignment.assignmentId
            ? { ...item, status: 'running', promptStatus: 'sent', updatedAt: this.now() }
            : item,
        ),
        inputs: current.inputs.map(item =>
          item.inputId === input.inputId
            ? { ...item, deliveryStatus: 'sent', deliveredAt: this.now() }
            : item,
        ),
      }))
      await this.touchLease(task.taskId)
      return true
    } catch (error: unknown) {
      const message = classifyError(error).message
      await this.store.updateTask(task.taskId, current => ({
        ...current,
        inputs: current.inputs.map(item =>
          item.inputId === input.inputId ? { ...item, deliveryStatus: 'failed' } : item,
        ),
      }))
      await this.failAssignment(this.requireTask(task.taskId), assignment, `dispatch failed: ${message}`, 'blocked')
      return false
    }
  }

  private async resolveAgent(sessionId: string): Promise<AgentLike | undefined> {
    const controller = this.controller
    if (controller?.resolveAgent === undefined) {
      const agents = this.ctx.get('agents') as { get?(id: string): AgentLike | undefined } | undefined
      return agents?.get?.(sessionId)
    }
    const result: ResolvedAgent = await controller.resolveAgent(sessionId)
    if (result.agent !== undefined) return result.agent
    if (result.error !== undefined) {
      throw new OneError('one/agent-unavailable', result.error.message ?? 'worker agent unavailable', {
        sessionId,
        code: result.error.code,
      })
    }
    return undefined
  }

  private async applyWorkerComposition(agent: AgentLike, assignment: TaskAssignment): Promise<void> {
    const presets = this.ctx.get('permissionPresets') as PermissionPresetsLike | undefined
    if (presets !== undefined && this.config.workerPermissionPreset !== '') {
      try {
        presets.resolve(this.config.workerPermissionPreset)
        presets.set(agent.session, this.config.workerPermissionPreset)
      } catch (error: unknown) {
        await this.core.audit({
          action: 'worker_permission_failed',
          targetSessionId: assignment.sessionId,
          outcome: 'error',
          detail: classifyError(error).message,
        })
      }
    }
    const restrict = agent.ctx?.tools?.restrict
    if (restrict === undefined) return
    const allow = this.config.workerToolAllow
    const deny = this.config.workerToolDeny
    try {
      if (allow.length > 0) restrict.call(agent.ctx?.tools, { allow })
      else if (deny.length > 0) restrict.call(agent.ctx?.tools, { deny })
    } catch (error: unknown) {
      // A restricted name outside the global layer fails the whole filter; mask each name.
      for (const name of deny) {
        try {
          restrict.call(agent.ctx?.tools, { deny: [name] })
        } catch {
          // Expected for a scope-local name.
        }
      }
      await this.core.audit({
        action: 'worker_tools_partial',
        targetSessionId: assignment.sessionId,
        outcome: 'error',
        detail: classifyError(error).message,
      })
    }
  }

  private async onTurnEnd(task: TaskRecord, sessionId: string, event: { seq?: number; data?: Record<string, unknown> }): Promise<void> {
    const assignment = task.assignments.find(item => item.sessionId === sessionId && ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
    if (assignment === undefined) return
    const at = this.now()
    const reason = event.data?.['reason'] as { kind?: string; error?: { message?: string } } | undefined
    if (task.tokenBudget > 0 && task.usage.totalTokens >= task.tokenBudget) {
      await this.cancelAgent(task)
      await this.blockTask(task.taskId, 'budget-exceeded', 'budget')
      return
    }
    const latest = task.latestReport
    const reportedThisAssignment = latest !== undefined && latest.assignmentId === assignment.assignmentId
    if (reason?.kind === 'error' || reason?.kind === 'aborted' || reason?.kind === 'max-tokens') {
      const detail = reason.error?.message ?? `turn ended with ${reason.kind}`
      await this.failAssignment(task, assignment, detail, 'failed')
      return
    }
    if (reportedThisAssignment && latest !== undefined) {
      // A terminal report already settled the task; progress alone leaves it open.
      if (latest.kind !== 'progress') return
    }
    // Fallback only: never treat the last assistant text as success.
    await this.store.updateTask(task.taskId, current => ({
      ...current,
      status: 'blocked',
      blockedReason: 'turn-ended-without-report',
      attention: { kind: 'blocked', reason: 'worker turn ended without a structured report', since: at },
      assignments: current.assignments.map(item =>
        item.assignmentId === assignment.assignmentId
          ? { ...item, status: 'unknown', updatedAt: at, error: 'turn ended without a report' }
          : item,
      ),
      updatedAt: at,
    }))
    await this.releaseLeasesForTask(task.taskId)
    await this.core.audit({
      action: 'task_unreported_turn_end',
      taskId: task.taskId,
      targetSessionId: sessionId,
      outcome: 'error',
      detail: 'turn ended without a structured report',
    })
  }

  private async accumulateUsage(task: TaskRecord, sessionId: string, event: { seq?: number; data?: Record<string, unknown> }): Promise<void> {
    const usage = event.data?.['usage'] as Partial<TaskUsage> | undefined
    if (usage === undefined) return
    const seq = typeof event.seq === 'number' ? event.seq : -1
    let overBudget = false
    const updated = await this.store.updateTask(task.taskId, current => {
      if (seq <= current.usage.lastUsageSeq) return current
      const inputTokens = current.usage.inputTokens + (usage.inputTokens ?? 0)
      const outputTokens = current.usage.outputTokens + (usage.outputTokens ?? 0)
      const cacheReadTokens = current.usage.cacheReadTokens + (usage.cacheReadTokens ?? 0)
      const cacheWriteTokens = current.usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0)
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
      overBudget = current.tokenBudget > 0 && totalTokens > current.tokenBudget
      return {
        ...current,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, lastUsageSeq: seq },
        updatedAt: this.now(),
      }
    })
    await this.touchLease(task.taskId)
    if (overBudget) {
      void sessionId
      await this.cancelAgent(updated)
      await this.blockTask(updated.taskId, 'budget-exceeded', 'budget')
    }
  }

  private async failTask(task: TaskRecord, reason: string, status: 'blocked' | 'failed'): Promise<void> {
    const at = this.now()
    await this.releaseLeasesForTask(task.taskId)
    await this.store.updateTask(task.taskId, current => ({
      ...current,
      status,
      blockedReason: reason,
      attention: { kind: status === 'failed' ? 'failed' : 'blocked', reason, since: at },
      updatedAt: at,
      assignments: current.assignments.map(item =>
        ACTIVE_ASSIGNMENT_STATUSES.includes(item.status)
          ? { ...item, status: status === 'failed' ? 'failed' as const : 'unknown' as const, updatedAt: at, error: reason }
          : item,
      ),
    }))
    await this.core.audit({ action: 'task_dispatch_failed', taskId: task.taskId, outcome: 'error', detail: reason })
    this.emit()
  }

  private async failAssignment(task: TaskRecord, assignment: TaskAssignment, reason: string, status: 'blocked' | 'failed'): Promise<void> {
    const at = this.now()
    await this.store.updateTask(task.taskId, current => ({
      ...current,
      status,
      blockedReason: reason,
      attention: { kind: status === 'failed' ? 'failed' : 'blocked', reason, since: at },
      updatedAt: at,
      assignments: current.assignments.map(item =>
        item.assignmentId === assignment.assignmentId
          ? { ...item, status: status === 'failed' ? 'failed' as const : 'unknown' as const, updatedAt: at, error: reason }
          : item,
      ),
    }))
    await this.releaseLeasesForTask(task.taskId)
    await this.core.audit({
      action: 'task_assignment_failed',
      taskId: task.taskId,
      targetSessionId: assignment.sessionId,
      outcome: 'error',
      detail: reason,
    })
    this.emit()
  }

  private async cancelAgent(task: TaskRecord): Promise<void> {
    const assignment = task.assignments.find(item => ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
    if (assignment === undefined) return
    const agents = this.ctx.get('agents') as { get?(id: string): AgentLike | undefined } | undefined
    const agent = agents?.get?.(assignment.sessionId)
    if (agent?.cancel !== undefined) {
      agent.cancel({ kind: 'hook', reason: 'dsh-one: task stopped' })
      return
    }
    this.controller?.cancel?.({ sessionId: assignment.sessionId })
  }

  private leaseConflict(task: TaskRecord, assignmentId: string | undefined): boolean {
    if (task.workspaceMode === 'shared') return false
    const key = canonicalWorkspace(task.cwd)
    return this.store.listLeases().some(lease =>
      lease.status === 'active'
      && lease.expiresAt > this.now()
      && lease.workspace === key
      && lease.ownerTaskId !== task.taskId
      && (assignmentId === undefined || lease.ownerAssignmentId !== assignmentId),
    )
  }

  private async acquireLease(task: TaskRecord, assignmentId: string): Promise<{ leaseId: string } | undefined> {
    if (task.workspaceMode === 'shared') return undefined
    if (this.leaseConflict(task, assignmentId)) return undefined
    const existing = this.store.listLeases().find(lease =>
      lease.status === 'active' && lease.ownerTaskId === task.taskId && lease.workspace === canonicalWorkspace(task.cwd),
    )
    if (existing !== undefined) {
      await this.store.putLease({ ...existing, ownerAssignmentId: assignmentId, heartbeatAt: this.now(), expiresAt: this.now() + this.config.leaseTtlMs })
      return { leaseId: existing.leaseId }
    }
    const at = this.now()
    const lease = {
      leaseId: nextId('lease'),
      workspace: canonicalWorkspace(task.cwd),
      ownerTaskId: task.taskId,
      ownerAssignmentId: assignmentId,
      status: 'active' as const,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at + this.config.leaseTtlMs,
    }
    await this.store.putLease(lease)
    return { leaseId: lease.leaseId }
  }

  private async releaseLease(lease: { leaseId: string } | undefined): Promise<void> {
    if (lease === undefined) return
    const record = this.store.getLease(lease.leaseId)
    if (record === undefined || record.status !== 'active') return
    await this.store.putLease({ ...record, status: 'released', heartbeatAt: this.now(), expiresAt: this.now() })
  }

  private async releaseLeasesForTask(taskId: string): Promise<void> {
    for (const lease of this.store.listLeases()) {
      if (lease.status !== 'active' || lease.ownerTaskId !== taskId) continue
      await this.store.putLease({ ...lease, status: 'released', heartbeatAt: this.now(), expiresAt: this.now() })
    }
  }

  private async touchLease(taskId: string): Promise<void> {
    const at = this.now()
    for (const lease of this.store.listLeases()) {
      if (lease.status !== 'active' || lease.ownerTaskId !== taskId) continue
      await this.store.putLease({ ...lease, heartbeatAt: at, expiresAt: at + this.config.leaseTtlMs })
    }
  }

  private expireLeases(): void {
    const at = this.now()
    for (const lease of this.store.listLeases()) {
      if (lease.status !== 'active' || lease.expiresAt > at) continue
      // Expiry is a read-side decision; the stale row is corrected on the next write.
      void this.store.putLease({ ...lease, status: 'expired' })
    }
  }

  private resolveWorkspace(requested: string, callerCwd: string | undefined, callerSessionId: string | undefined): string {
    const candidate = requested !== '' ? requested : callerCwd
    if (candidate === undefined || candidate === '') {
      throw new OneError('one/workspace-required', 'this task requires a workspace cwd', { callerSessionId })
    }
    const roots = this.core.isWorkspaceAllowed(candidate)
    if (!roots) {
      throw new OneError('one/workspace-forbidden', `workspace "${candidate}" is outside the allowed roots`, { cwd: candidate })
    }
    return candidate
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId)
    if (task === undefined) throw new OneError('one/task-not-found', `task "${taskId}" was not found`, { taskId })
    return task
  }

  private placeholder(input: CreateTaskInput, options: CreateTaskOptions): TaskRecord {
    const at = this.now()
    const cwd = input.cwd ?? (this.config.defaultWorkspaceRoot !== '' ? this.config.defaultWorkspaceRoot : options.callerCwd ?? '')
    return {
      taskId: options.taskId ?? `observed-${hashOf({ title: input.title, goal: input.goal, at })}`,
      title: input.title,
      goal: input.goal,
      status: 'queued',
      origin: input.origin ?? 'agent',
      priority: input.priority ?? this.config.defaultTaskPriority,
      cwd,
      workspaceMode: this.config.workspaceMode,
      assignments: [],
      inputs: [],
      usage: emptyUsage(),
      tokenBudget: input.tokenBudget ?? this.config.tokenBudget,
      createdAt: at,
      updatedAt: at,
    }
  }

  private workText(taskId: string, title: string, goal: string, cwd: string): string {
    return [
      `[DSH One task ${taskId}]`,
      `Task: ${title}`,
      '',
      'Goal:',
      goal,
      '',
      `Workspace: ${cwd}`,
      '',
      'Report through the one_task_report tool. Progress, waiting, ready, blocked, failed and dropped each need a stable reportId.',
      'The final chat text is not a result. Do not mark work ready without evidence.',
      'Stay inside the workspace. If another task holds its lease, stop and report blocked.',
    ].join('\n')
  }

  private recoveryText(task: TaskRecord, reason: string | undefined): string {
    return [
      `[DSH One task ${task.taskId} · retry]`,
      `Previous attempt: ${reason ?? task.blockedReason ?? 'unknown'}`,
      '',
      'DeepSeek Harness may have restarted while this work was in flight. Before repeating any external action:',
      '1. Inspect the working directory and confirm the expected files exist.',
      '2. Check git status and the current branch/commit.',
      '3. For a PR or issue, check its current state and comments.',
      '4. Only then continue from the earliest step that is not provably complete.',
      '',
      'Goal:',
      task.goal,
      '',
      'Use one_task_report for every state change.',
    ].join('\n')
  }
}

function isTerminal(status: TaskRecord['status']): boolean {
  return status === 'done' || status === 'cancelled'
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function reportStatus(kind: TaskReportInput['kind']): TaskRecord['status'] {
  switch (kind) {
    case 'progress': return 'running'
    case 'waiting': return 'waiting'
    case 'ready': return 'ready'
    case 'blocked': return 'blocked'
    case 'failed': return 'failed'
    case 'dropped': return 'blocked'
  }
}

function reportAssignmentStatus(kind: TaskReportInput['kind']): TaskAssignment['status'] {
  switch (kind) {
    case 'progress': return 'running'
    case 'waiting': return 'waiting'
    case 'ready': return 'ready'
    case 'blocked': return 'unknown'
    case 'failed': return 'failed'
    case 'dropped': return 'unknown'
  }
}

function reportAttention(kind: TaskReportInput['kind'], summary: string, at: number): TaskAttention | undefined {
  switch (kind) {
    case 'progress': return undefined
    case 'waiting': return { kind: 'waiting', reason: summary, since: at }
    case 'ready': return { kind: 'report', reason: summary, since: at }
    case 'blocked': return { kind: 'blocked', reason: summary, since: at }
    case 'failed': return { kind: 'failed', reason: summary, since: at }
    case 'dropped': return { kind: 'report', reason: summary, since: at }
  }
}

function finishAssignments(task: TaskRecord, status: 'done' | 'cancelled', at: number): TaskAssignment[] {
  return task.assignments.map(item =>
    ACTIVE_ASSIGNMENT_STATUSES.includes(item.status) ? { ...item, status, updatedAt: at } : item,
  )
}
