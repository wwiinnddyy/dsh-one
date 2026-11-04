/** Model-facing task tools: create, assign, status, report, control. */

import type {
  AgentLike,
  DshContextLike,
  TaskRecord,
  TaskService,
  ToolDefinitionLike,
  ToolRunContextLike,
} from '../types.js'
import { OneError } from '../types.js'
import { asNumber, asRecord, asString, preview } from '../util.js'

const createParameters = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short task title.' },
    goal: { type: 'string', description: 'What the worker must achieve, with acceptance evidence.' },
    cwd: { type: 'string', description: 'Absolute workspace directory. Defaults to the configured worker root.' },
    priority: { type: 'integer', description: 'Higher runs first. Human tasks always precede machine tasks.' },
    tokenBudget: { type: 'integer', description: 'Hard token budget for this task. Zero uses the deployment default.' },
    assign: { type: 'boolean', description: 'Start the task immediately when a worker slot is free.' },
  },
  required: ['title', 'goal'],
  additionalProperties: false,
} as const

const assignParameters = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Task to assign.' },
  },
  required: ['taskId'],
  additionalProperties: false,
} as const

const statusParameters = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'One task id. Omit to list recent tasks.' },
    limit: { type: 'integer', description: 'Maximum rows when listing.' },
  },
  additionalProperties: false,
} as const

const reportParameters = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Task this report belongs to.' },
    reportId: { type: 'string', description: 'Stable idempotency key for this report.' },
    kind: {
      type: 'string',
      enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'],
      description: 'Structured state. ready is not the same as a successful final chat message.',
    },
    summary: { type: 'string', description: 'One-line state and evidence summary.' },
    detail: { type: 'string', description: 'Longer explanation for the operator.' },
    evidence: { type: 'string', description: 'Commands, paths, commit ids, or links proving the state.' },
  },
  required: ['taskId', 'reportId', 'kind', 'summary'],
  additionalProperties: false,
} as const

const controlParameters = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    action: { type: 'string', enum: ['complete', 'cancel', 'retry'], description: 'Human control action.' },
    reason: { type: 'string', description: 'Why the action was requested.' },
  },
  required: ['taskId', 'action'],
  additionalProperties: false,
} as const

const taskOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    origin: { type: 'string' },
    cwd: { type: 'string' },
    created: { type: 'boolean' },
    observed: { type: 'boolean' },
    started: { type: 'boolean' },
    waitingForSlot: { type: 'boolean' },
    waitingForLease: { type: 'boolean' },
    latestReport: { type: 'string' },
    attention: { type: 'string' },
    totalTokens: { type: 'integer' },
    assignedSessionId: { type: 'string' },
  },
  required: ['taskId', 'title', 'status', 'origin', 'cwd', 'created', 'observed', 'totalTokens'],
} as const

const statusOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: taskOutput,
    },
  },
  required: ['items'],
} as const

/** Register the five task tools on the delegate row. */
export function registerTaskTools(ctx: DshContextLike, service: TaskService, timeoutMs: number): () => void {
  const disposers = [
    ctx.tools.register(createTool(service, timeoutMs)),
    ctx.tools.register(assignTool(service, timeoutMs)),
    ctx.tools.register(statusTool(service, timeoutMs)),
    ctx.tools.register(reportTool(service, timeoutMs)),
    ctx.tools.register(controlTool(service, timeoutMs)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function createTool(service: TaskService, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_task_create',
    description: 'Create a delegated task. In observe mode this records the intended task without creating it. Use one_task_assign to start it.',
    parameters: createParameters,
    timeoutMs,
    output: {
      schema: taskOutput,
      render(_args, value) {
        const result = value as ReturnType<typeof taskJson>
        return [{ type: 'text', text: `one_task_create ${result.taskId}: ${result.observed ? 'observed (not created)' : result.status}` }]
      },
    },
    async execute(args, exec) {
      const record = asRecord(args)
      const title = asString(record?.['title'])
      const goal = asString(record?.['goal'])
      if (title === undefined || goal === undefined) throw new OneError('one/invalid-argument', 'title and goal are required')
      const agent = requireAgent(exec)
      const cwd = asString(record?.['cwd'])
      const priority = asNumber(record?.['priority'])
      const tokenBudget = asNumber(record?.['tokenBudget'])
      const assign = record?.['assign'] === true
      const result = await service.createTask({
        title,
        goal,
        ...(cwd === undefined ? {} : { cwd }),
        ...(priority === undefined ? {} : { priority }),
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        origin: 'agent',
      }, {
        source: 'tool',
        callerSessionId: agent.id,
        ...(agent.session.header.cwd === undefined ? {} : { callerCwd: agent.session.header.cwd }),
        autoAssign: assign,
      })
      const current = service.getTask(result.task.taskId) ?? result.task
      return taskJson(current, result.created, result.observed)
    },
  }
}

function assignTool(service: TaskService, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_task_assign',
    description: 'Start a queued task on a worker session when a slot and workspace lease are free.',
    parameters: assignParameters,
    timeoutMs,
    output: {
      schema: taskOutput,
      render(_args, value) {
        const result = value as ReturnType<typeof taskJson>
        return [{ type: 'text', text: `one_task_assign ${result.taskId}: ${result.status}${result.started === true ? ' (started)' : ''}` }]
      },
    },
    async execute(args, exec) {
      const taskId = asString(asRecord(args)?.['taskId'])
      if (taskId === undefined) throw new OneError('one/invalid-argument', 'taskId is required')
      const agent = requireAgent(exec)
      const result = await service.assign(taskId, { callerSessionId: agent.id })
      return taskJson(service.getTask(taskId) ?? result.task, false, false, result)
    },
  }
}

function statusTool(service: TaskService, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_task_status',
    description: 'Read one task or list recent tasks. Read-only.',
    parameters: statusParameters,
    timeoutMs,
    output: {
      schema: statusOutput,
      render(_args, value) {
        const items = (value as { items: ReturnType<typeof taskJson>[] }).items
        return [{ type: 'text', text: items.length === 0 ? 'no tasks' : items.map(item => `${item.taskId}  ${item.status}  ${item.title}`).join('\n') }]
      },
    },
    async execute(args) {
      const record = asRecord(args) ?? {}
      const taskId = asString(record['taskId'])
      if (taskId !== undefined) {
        const task = service.getTask(taskId)
        if (task === undefined) throw new OneError('one/task-not-found', `task "${taskId}" was not found`, { taskId })
        return { items: [taskJson(task, false, false)] }
      }
      const limit = Math.max(1, Math.min(100, asNumber(record['limit']) ?? 20))
      const tasks = [...service.listTasks()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
      return { items: tasks.map(task => taskJson(task, false, false)) }
    },
  }
}

function reportTool(service: TaskService, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_task_report',
    description: 'Report a task state. The report is the authoritative result; a final assistant message is not. Reusing reportId is idempotent.',
    parameters: reportParameters,
    timeoutMs,
    output: {
      schema: taskOutput,
      render(_args, value) {
        const result = value as ReturnType<typeof taskJson>
        return [{ type: 'text', text: `one_task_report ${result.taskId}: ${result.status}${result.latestReport === undefined ? '' : ` · ${result.latestReport}`}` }]
      },
    },
    async execute(args, exec) {
      const record = asRecord(args)
      const taskId = asString(record?.['taskId'])
      const reportId = asString(record?.['reportId'])
      const kind = asString(record?.['kind'])
      const summary = asString(record?.['summary'])
      if (taskId === undefined || reportId === undefined || kind === undefined || summary === undefined) {
        throw new OneError('one/invalid-argument', 'taskId, reportId, kind, and summary are required')
      }
      if (!['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'].includes(kind)) {
        throw new OneError('one/invalid-argument', `unknown report kind "${kind}"`)
      }
      const agent = requireAgent(exec)
      const task = await service.report({
        taskId,
        reportId,
        kind: kind as 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped',
        summary,
        ...detailFields(record),
        callerSessionId: agent.id,
      })
      return taskJson(task, false, false)
    },
  }
}

function controlTool(service: TaskService, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_task_control',
    description: 'Complete a ready task, cancel a task, or retry a blocked/failed task. Retry creates a new assignment with a recovery prompt.',
    parameters: controlParameters,
    timeoutMs,
    output: {
      schema: taskOutput,
      render(_args, value) {
        const result = value as ReturnType<typeof taskJson>
        return [{ type: 'text', text: `one_task_control ${result.taskId}: ${result.status}` }]
      },
    },
    async execute(args, exec) {
      const record = asRecord(args)
      const taskId = asString(record?.['taskId'])
      const action = asString(record?.['action'])
      if (taskId === undefined || action === undefined) throw new OneError('one/invalid-argument', 'taskId and action are required')
      if (action !== 'complete' && action !== 'cancel' && action !== 'retry') {
        throw new OneError('one/invalid-argument', `unknown control action "${action}"`)
      }
      const agent = requireAgent(exec)
      const task = await service.control({
        taskId,
        action,
        ...(asString(record?.['reason']) === undefined ? {} : { reason: asString(record?.['reason']) as string }),
        callerSessionId: agent.id,
      })
      return taskJson(task, false, false)
    },
  }
}

function requireAgent(exec: ToolRunContextLike): AgentLike {
  if (exec.agent === undefined) throw new OneError('one/no-agent', 'this tool requires a calling agent session')
  return exec.agent
}

function detailFields(record: Record<string, unknown> | undefined): { detail?: string; evidence?: string } {
  const detail = asString(record?.['detail'])
  const evidence = asString(record?.['evidence'])
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function taskJson(
  task: TaskRecord,
  created: boolean,
  observed: boolean,
  extra: { started?: boolean; waitingForSlot?: boolean; waitingForLease?: boolean } = {},
): {
  taskId: string
  title: string
  status: string
  origin: string
  cwd: string
  created: boolean
  observed: boolean
  started?: boolean
  waitingForSlot?: boolean
  waitingForLease?: boolean
  latestReport?: string
  attention?: string
  totalTokens: number
  assignedSessionId?: string
} {
  const assignment = task.assignments.find(item => item.status === 'assigned' || item.status === 'running' || item.status === 'waiting')
    ?? task.assignments[task.assignments.length - 1]
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    origin: task.origin,
    cwd: task.cwd,
    created,
    observed,
    ...(extra.started === undefined ? {} : { started: extra.started }),
    ...(extra.waitingForSlot === undefined ? {} : { waitingForSlot: extra.waitingForSlot }),
    ...(extra.waitingForLease === undefined ? {} : { waitingForLease: extra.waitingForLease }),
    ...(task.latestReport === undefined ? {} : { latestReport: preview(task.latestReport.summary, 160) }),
    ...(task.attention === undefined ? {} : { attention: preview(task.attention.reason, 160) }),
    totalTokens: task.usage.totalTokens,
    ...(assignment === undefined ? {} : { assignedSessionId: assignment.sessionId }),
  }
}
