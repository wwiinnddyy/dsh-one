/**
 * The model-facing tool surface.
 *
 * Delegation is one entry point (`one_work`) instead of a family of tools per
 * subsystem: create a Ticket, bind it to a Session, report, answer, complete or
 * stop. `one_status` is the read-only projection.
 */

import type { Ticket } from '../core/model.js'
import type { Engine } from '../core/engine.js'
import type { DshContextLike, ToolDefinitionLike } from '../types.js'
import { asRecord, asString } from './args.js'
import { stageOf } from '../core/stage.js'

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
  properties: ticketProperties,
  required: ['ticketId', 'title', 'goal', 'status', 'stage', 'createdAt', 'updatedAt'],
} as const

const workParameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'assign', 'report', 'answer', 'complete', 'stop'],
      description: 'What to do with the ticket.',
    },
    ticketId: { type: 'string', description: 'Existing ticket for assign/report/answer/complete/stop.' },
    title: { type: 'string', description: 'create: short ticket title.' },
    goal: { type: 'string', description: 'create: the outcome to reach, with acceptance evidence.' },
    cwd: { type: 'string', description: 'create: absolute workspace directory.' },
    sessionId: { type: 'string', description: 'assign/report: the Executor Session id.' },
    assignmentId: { type: 'string', description: 'assign/report: existing assignment id.' },
    reportKind: {
      type: 'string',
      enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'],
      description: 'report: structured state.',
    },
    summary: { type: 'string', description: 'report: one-line state and evidence summary.' },
    detail: { type: 'string' },
    evidence: { type: 'string' },
    text: { type: 'string', description: 'answer/stop: the answer or the stop reason.' },
  },
  required: ['action'],
  additionalProperties: false,
} as const

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

const statusParameters = {
  type: 'object',
  properties: {},
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
  },
  required: ['total', 'open', 'ended', 'byStage'],
} as const

/** Register the two base tools. */
export function registerOneTools(ctx: DshContextLike, engine: Engine, timeoutMs = 30_000): () => void {
  const disposers = [
    ctx.tools.register(workTool(engine, timeoutMs)),
    ctx.tools.register(statusTool(engine, timeoutMs)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function workTool(engine: Engine, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_work',
    description:
      'The single entry for delegated work: create a ticket, bind it to an Executor Session, report its state, '
      + 'answer a question, complete it, or stop it. Reuse ticketId for idempotent creation.',
    parameters: workParameters,
    timeoutMs,
    output: {
      schema: workOutput,
      render(_args, value) {
        const ticket = value as Record<string, unknown>
        return [{ type: 'text', text: `one_work ${String(ticket['ticketId'])}: ${String(ticket['status'])} · ${String(ticket['stage'])}` }]
      },
    },
    async execute(args) {
      const record = asRecord(args) ?? {}
      const action = asString(record['action'])
      if (action === undefined) throw new Error('one/invalid-argument: action is required')
      const ticketId = asString(record['ticketId'])
      switch (action) {
        case 'create': {
          const title = asString(record['title'])
          const goal = asString(record['goal'])
          if (title === undefined || goal === undefined) {
            throw new Error('one/invalid-argument: title and goal are required')
          }
          return toJson(await engine.createTicket({
            title,
            goal,
            ...(asString(record['cwd']) === undefined ? {} : { cwd: asString(record['cwd']) as string }),
            ...(ticketId === undefined ? {} : { ticketId }),
          }))
        }
        case 'assign': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          const sessionId = asString(record['sessionId'])
          if (sessionId === undefined) throw new Error('one/invalid-argument: sessionId is required')
          return toJson(await engine.assign({
            ticketId,
            sessionId,
            ...(asString(record['assignmentId']) === undefined ? {} : { assignmentId: asString(record['assignmentId']) as string }),
          }))
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
          return toJson(await engine.report({
            ticketId,
            assignmentId,
            sessionId,
            kind: kind as 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped',
            summary,
            ...(asString(record['detail']) === undefined ? {} : { detail: asString(record['detail']) as string }),
            ...(asString(record['evidence']) === undefined ? {} : { evidence: asString(record['evidence']) as string }),
          }))
        }
        case 'answer': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          const text = asString(record['text'])
          if (text === undefined) throw new Error('one/invalid-argument: text is required')
          return toJson(await engine.answer({ ticketId, answer: text }))
        }
        case 'complete': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          return toJson(await engine.complete({ ticketId, ...(asString(record['text']) === undefined ? {} : { reason: asString(record['text']) as string }) }))
        }
        case 'stop': {
          if (ticketId === undefined) throw new Error('one/invalid-argument: ticketId is required')
          return toJson(await engine.stop({ ticketId, ...(asString(record['text']) === undefined ? {} : { reason: asString(record['text']) as string }) }))
        }
        default:
          throw new Error(`one/invalid-argument: unknown action "${action}"`)
      }
    },
  }
}

function statusTool(engine: Engine, timeoutMs: number): ToolDefinitionLike {
  return {
    name: 'one_status',
    description: 'Read the current tickets grouped by stage. Read-only.',
    parameters: statusParameters,
    timeoutMs,
    output: {
      schema: statusOutput,
      render(_args, value) {
        const result = value as { total: number; open: number; ended: number }
        return [{ type: 'text', text: `one_status: ${result.total} tickets, ${result.open} open, ${result.ended} ended` }]
      },
    },
    async execute() {
      const tickets = engine.list()
      const byStage: Record<string, number> = {}
      for (const ticket of tickets) {
        const stage = stageOf(ticket)
        byStage[stage] = (byStage[stage] ?? 0) + 1
      }
      return {
        total: tickets.length,
        open: tickets.filter(item => item.status === 'open').length,
        ended: tickets.filter(item => item.status === 'ended').length,
        byStage,
      }
    },
  }
}
