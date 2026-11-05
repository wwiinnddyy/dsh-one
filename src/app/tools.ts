/**
 * The model-facing tool surface.
 *
 * Delegation is one entry point (`one_work`) instead of a family of tools per
 * subsystem. `one_status` is the read-only projection of tickets, sessions and
 * workspaces, which is what the Router reads before choosing a worker.
 */

import type { Ticket } from '../core/model.js'
import type { DshContextLike, ToolDefinitionLike, ToolRunContextLike, AgentLike } from '../types.js'
import { asRecord, asString } from './args.js'
import { stageOf } from '../core/stage.js'
import { senderLabelFor } from './sender.js'
import type { OneRuntime } from './runtime.js'
import type { ManagedSessionRecord } from './store.js'
import { workspaceKey, workspaceLabel } from './paths.js'

const ticketProperties = {
  ticketId: { type: 'string' },
  title: { type: 'string' },
  goal: { type: 'string' },
  cwd: { type: 'string' },
  status: { type: 'string', enum: ['open', 'ended'] },
  outcome: { type: 'string', enum: ['completed', 'dropped', 'cancelled'] },
  stage: {
    type: 'string',
    enum: [
      'person/delivery', 'person/answer', 'person/review', 'person/blocked', 'person/failed',
      'working/queued', 'idle', 'working', 'ended',
    ],
  },
  createdAt: { type: 'integer' },
  updatedAt: { type: 'integer' },
} as const

const workOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...ticketProperties,
    path: { type: 'string' },
    workspaceId: { type: 'string' },
    sessionId: { type: 'string' },
    goalId: { type: 'string' },
    sent: { type: 'boolean' },
  },
  required: [],
} as const

const workParameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'create_goal', 'assign', 'report', 'answer', 'complete', 'stop', 'create_workspace', 'message'],
      description: 'What to do.',
    },
    ticketId: { type: 'string', description: 'Existing ticket for assign/report/answer/complete/stop.' },
    title: { type: 'string', description: 'create: short ticket title.' },
    goal: { type: 'string', description: 'create: the outcome to reach, with acceptance evidence.' },
    cwd: { type: 'string', description: 'create/assign/create_workspace: absolute workspace directory.' },
    goalId: { type: 'string', description: 'create: optional goal id to attach the ticket to.' },
    sessionId: { type: 'string', description: 'assign/report/message: the target Session id.' },
    assignmentId: { type: 'string', description: 'report: the assignment id from the dispatch message.' },
    reportKind: {
      type: 'string',
      enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'],
      description: 'report: structured state.',
    },
    summary: { type: 'string', description: 'report: one-line state and evidence summary.' },
    detail: { type: 'string' },
    evidence: { type: 'string' },
    text: { type: 'string', description: 'answer/stop/message: the answer, reason, or message text.' },
    name: { type: 'string', description: 'create_workspace: display name for the new workspace.' },
  },
  required: ['action'],
  additionalProperties: false,
} as const

const statusParameters = {
  type: 'object',
  properties: {
    include: {
      type: 'array',
      items: { type: 'string', enum: ['tickets', 'sessions', 'workspaces'] },
      description: 'Which sections to return. Defaults to all.',
    },
  },
  additionalProperties: false,
} as const

const statusOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    open: { type: 'integer' },
    ended: { type: 'integer' },
    byStage: { type: 'object', additionalProperties: { type: 'integer' } },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticketId: { type: 'string' },
          title: { type: 'string' },
          stage: { type: 'string' },
          cwd: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
    },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          role: { type: 'string' },
          cwd: { type: 'string' },
          running: { type: 'boolean' },
        },
      },
    },
    workspaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          label: { type: 'string' },
          sessions: { type: 'integer' },
        },
      },
    },
  },
  required: ['total', 'open', 'ended', 'byStage'],
} as const

/** Register the two model-facing tools. */
export function registerOneTools(ctx: DshContextLike, runtime: OneRuntime): () => void {
  const disposers = [
    ctx.tools.register(workTool(runtime)),
    ctx.tools.register(statusTool(runtime)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function toJson(ticket: Ticket): Record<string, unknown> {
  return {
    ticketId: ticket.ticketId,
    title: ticket.title,
    goal: ticket.goal,
    ...(ticket.cwd === undefined ? {} : { cwd: ticket.cwd }),
    status: ticket.status,
    ...(ticket.outcome === undefined ? {} : { outcome: ticket.outcome }),
    stage: stageOf(ticket),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }
}

function isAssistant(runtime: OneRuntime, agent: AgentLike | undefined): boolean {
  const assistant = runtime.assistantSessionId()
  return assistant !== undefined && agent?.id === assistant
}

function requireAgent(exec: ToolRunContextLike): AgentLike {
  if (exec.agent === undefined) throw new Error('one/no-agent: this tool requires a calling session')
  return exec.agent
}

function workTool(runtime: OneRuntime): ToolDefinitionLike {
  return {
    name: 'one_work',
    description:
      'The single entry for delegated work. create a ticket; create_workspace to make a folder a workspace; '
      + 'assign it to an existing session (sessionId) or a session in a workspace (cwd); report its state; '
      + 'answer a question; complete or stop it; message another session.',
    parameters: workParameters,
    timeoutMs: runtime.config.commandTimeoutMs,
    output: {
      schema: workOutput,
      render(_args, value) {
        const row = value as Record<string, unknown>
        if (typeof row['ticketId'] === 'string') {
          return [{ type: 'text', text: `one_work ${row['ticketId']}: ${String(row['status'])} · ${String(row['stage'])}` }]
        }
        if (typeof row['path'] === 'string') {
          return [{ type: 'text', text: `one_work workspace: ${row['path']}` }]
        }
        if (typeof row['goalId'] === 'string') {
          return [{ type: 'text', text: `one_work goal: ${row['goalId']}` }]
        }
        return [{ type: 'text', text: `one_work ${String(row['action'] ?? 'done')}` }]
      },
    },
    async execute(args, exec) {
      const record = asRecord(args) ?? {}
      const action = asString(record['action'])
      if (action === undefined) throw new Error('one/invalid-argument: action is required')
      if (runtime.config.mode === 'observe') {
        throw new Error('one/observe-mode: the deployment is in observe mode; no work is changed or delivered')
      }
      const agent = requireAgent(exec)
      const ticketId = asString(record['ticketId'])
      switch (action) {
        case 'create_goal': {
          const title = asString(record['title'])
          if (title === undefined) throw new Error('one/invalid-argument: title is required')
          const goal = await runtime.engine.createGoal({
            title,
            ...(asString(record['cwd']) === undefined ? {} : { cwd: asString(record['cwd']) as string }),
          })
          return { goalId: goal.goalId, title: goal.title }
        }
        case 'create': {
          const title = asString(record['title'])
          const goal = asString(record['goal'])
          if (title === undefined || goal === undefined) {
            throw new Error('one/invalid-argument: title and goal are required')
          }
          const assistant = isAssistant(runtime, agent)
          const goalId = asString(record['goalId'])
          const created = await runtime.engine.createTicket({
            title,
            goal,
            ...(asString(record['cwd']) === undefined ? {} : { cwd: asString(record['cwd']) as string }),
            ...(goalId === undefined ? {} : { goalId }),
            ...(ticketId === undefined ? {} : { ticketId }),
            origin: assistant ? 'assistant' : 'agent',
            ...(assistant ? { assistantLabel: senderLabelFor(runtime.assistantName()) } : {}),
          })
          if (goalId !== undefined) await runtime.engine.attachToGoal(goalId, created.ticketId)
          return toJson(created)
        }
        case 'create_workspace': {
          const path = asString(record['cwd'])
          if (path === undefined) throw new Error('one/invalid-argument: cwd is required')
          const created = await runtime.workspace.create({
            path,
            ...(asString(record['name']) === undefined ? {} : { name: asString(record['name']) as string }),
          })
          return { path: created.path, ...(created.workspaceId === undefined ? {} : { workspaceId: created.workspaceId }) }
        }
        case 'assign': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          const sessionId = asString(record['sessionId'])
          const cwd = asString(record['cwd'])
          let worker: ManagedSessionRecord
          if (sessionId !== undefined) {
            if (!await runtime.sessions.exists(sessionId)) {
              throw new Error(`one/session-not-found: session "${sessionId}" is not in session/list`)
            }
            worker = await runtime.sessions.register(sessionId, 'executor', cwd)
          } else if (cwd !== undefined) {
            runtime.workspace.assertAllowed(cwd)
            worker = await findOrCreateWorker(runtime, cwd)
          } else {
            throw new Error('one/invalid-argument: sessionId or cwd is required')
          }
          const assigned = await runtime.engine.assign({ ticketId, sessionId: worker.sessionId })
          const assignment = assigned.assignments.find(item => item.status === 'running')
          if (assignment !== undefined) await runtime.executor.enqueueLaunch(assigned.ticketId, assignment.assignmentId)
          runtime.executor.schedule()
          return toJson(assigned)
        }
        case 'report': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          const assignmentId = asString(record['assignmentId'])
          const sessionId = asString(record['sessionId'])
          const kind = asString(record['reportKind'])
          const summary = asString(record['summary'])
          if (assignmentId === undefined || sessionId === undefined || kind === undefined || summary === undefined) {
            throw new Error('one/invalid-argument: assignmentId, sessionId, reportKind and summary are required')
          }
          const reported = await runtime.engine.report({
            ticketId,
            assignmentId,
            sessionId,
            kind: kind as 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped',
            summary,
            ...(asString(record['detail']) === undefined ? {} : { detail: asString(record['detail']) as string }),
            ...(asString(record['evidence']) === undefined ? {} : { evidence: asString(record['evidence']) as string }),
          })
          // The Router is only woken by states a person can act on.
          if (kind === 'ready' || kind === 'blocked' || kind === 'failed' || kind === 'dropped') {
            await runtime.executor.enqueueRelay(`[工单 ${ticketId}] ${kind}: ${summary}`)
            runtime.executor.schedule()
          }
          return toJson(reported)
        }
        case 'answer': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          const text = asString(record['text'])
          if (text === undefined) throw new Error('one/invalid-argument: text is required')
          return toJson(await runtime.engine.answer({ ticketId, answer: text }))
        }
        case 'complete': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          return toJson(await runtime.engine.complete({
            ticketId,
            ...(asString(record['text']) === undefined ? {} : { reason: asString(record['text']) as string }),
          }))
        }
        case 'stop': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          return toJson(await runtime.engine.stop({
            ticketId,
            ...(asString(record['text']) === undefined ? {} : { reason: asString(record['text']) as string }),
          }))
        }
        case 'message': {
          const sessionId = asString(record['sessionId'])
          const text = asString(record['text'])
          if (sessionId === undefined || text === undefined) {
            throw new Error('one/invalid-argument: sessionId and text are required')
          }
          if (!await runtime.sessions.exists(sessionId)) {
            throw new Error(`one/session-not-found: session "${sessionId}" is not in session/list`)
          }
          const managed = runtime.store.getSession(sessionId)
          if (managed?.cwd !== undefined) runtime.workspace.assertAllowed(managed.cwd)
          const assistant = isAssistant(runtime, agent)
          const delivered = assistant ? `${senderLabelFor(runtime.assistantName())}\n\n${text}` : text
          await runtime.executor.enqueueReply(sessionId, delivered)
          runtime.executor.schedule()
          return { action: 'message', sessionId, sent: true }
        }
        default:
          throw new Error(`one/invalid-argument: unknown action "${action}"`)
      }
    },
  }
}

async function findOrCreateWorker(runtime: OneRuntime, cwd: string): Promise<ManagedSessionRecord> {
  const key = workspaceKey(cwd)
  const busy = new Set(runtime.engine.list()
    .flatMap(ticket => ticket.assignments.filter(item => item.status === 'running').map(item => item.sessionId)))
  const existing = runtime.sessions.workersInWorkspace(cwd)
    .find(record => !busy.has(record.sessionId) && record.status === 'active')
  if (existing !== undefined) {
    if (await runtime.sessions.exists(existing.sessionId)) return existing
    await runtime.store.putSession({ ...existing, status: 'missing', updatedAt: Date.now() })
  }
  return await runtime.sessions.create({ role: 'executor', cwd, title: workspaceLabel(key) })
}

function statusTool(runtime: OneRuntime): ToolDefinitionLike {
  return {
    name: 'one_status',
    description: 'Read tickets grouped by stage, plus known sessions and workspaces. Read-only.',
    parameters: statusParameters,
    timeoutMs: runtime.config.commandTimeoutMs,
    output: {
      schema: statusOutput,
      render(_args, value) {
        const result = value as { total: number; open: number; ended: number }
        return [{ type: 'text', text: `one_status: ${result.total} tickets, ${result.open} open, ${result.ended} ended` }]
      },
    },
    async execute(args) {
      const record = asRecord(args) ?? {}
      const include = Array.isArray(record['include'])
        ? record['include'].filter((item): item is string => typeof item === 'string')
        : ['tickets', 'sessions', 'workspaces']
      const tickets = runtime.engine.list()
      const byStage: Record<string, number> = {}
      for (const ticket of tickets) {
        const stage = stageOf(ticket)
        byStage[stage] = (byStage[stage] ?? 0) + 1
      }
      const sessions = await runtime.sessions.list()
      const records = runtime.store.listSessions()
      const sessionRows = sessions.map(item => {
        const managed = records.find(record => record.sessionId === item.sessionId)
        return {
          sessionId: item.sessionId,
          ...(managed === undefined ? {} : { role: managed.role }),
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          running: item.running,
        }
      })
      const workspaces = [...new Map(
        records
          .filter(item => item.cwd !== undefined)
          .map(item => [workspaceKey(item.cwd as string), item.cwd as string]),
      ).entries()].map(([key, path]) => ({
        path,
        label: workspaceLabel(path),
        sessions: records.filter(item => item.cwd !== undefined && workspaceKey(item.cwd) === key).length,
      }))
      return {
        total: tickets.length,
        open: tickets.filter(item => item.status === 'open').length,
        ended: tickets.filter(item => item.status === 'ended').length,
        byStage,
        ...(include.includes('tickets')
          ? {
            tickets: tickets.map(ticket => ({
              ticketId: ticket.ticketId,
              title: ticket.title,
              stage: stageOf(ticket),
              ...(ticket.cwd === undefined ? {} : { cwd: ticket.cwd }),
              ...(ticket.assignments.find(item => item.status === 'running') === undefined
                ? {}
                : { sessionId: ticket.assignments.find(item => item.status === 'running')?.sessionId as string }),
            })),
          }
          : {}),
        ...(include.includes('sessions') ? { sessions: sessionRows } : {}),
        ...(include.includes('workspaces') ? { workspaces } : {}),
      }
    },
  }
}
