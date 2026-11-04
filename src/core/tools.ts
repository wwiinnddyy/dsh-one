/** The `one_sessions`, `one_send`, and `one_model` model-facing tools. */

import type { AgentLike, DshContextLike, OneConfig, SelectModelResult, SendResult, SessionView, ToolDefinitionLike, ToolRunContextLike } from '../types.js'
import { OneError } from '../types.js'
import { OneCore, agentSessionId } from './registry.js'
import { asBoolean, asRecord, asString } from '../util.js'

const sessionsParameters = {
  type: 'object',
  properties: {
    all: {
      type: 'boolean',
      description: 'Include every session from session/list. False returns only registered sessions.',
    },
    workspace: {
      type: 'string',
      description: 'Optional absolute or prefix path used to filter sessions by cwd.',
    },
  },
  additionalProperties: false,
} as const

const sessionsOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          running: { type: 'boolean' },
          blank: { type: 'boolean' },
          subagent: { type: 'boolean' },
          registered: { type: 'boolean' },
          trusted: { type: 'boolean' },
          model: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
            required: ['provider', 'model'],
          },
          status: { type: 'string', enum: ['active', 'missing', 'error'] },
          lastSeenAt: { type: 'integer' },
        },
        required: ['sessionId', 'running', 'blank', 'subagent', 'registered', 'trusted'],
      },
    },
    degraded: { type: 'boolean' },
    reconciledAt: { type: 'integer' },
    error: { type: 'string' },
  },
  required: ['items', 'degraded'],
} as const

const sendParameters = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Target ordinary DSH session id.' },
    text: { type: 'string', description: 'User message text delivered to the target session.' },
    requestId: {
      type: 'string',
      description: 'Optional idempotency key. Reusing it returns the earlier outcome instead of sending twice.',
    },
    mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue for the next turn, steer for the nearest step.' },
  },
  required: ['sessionId', 'text'],
  additionalProperties: false,
} as const

const sendOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requestId: { type: 'string' },
    targetSessionId: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'sending', 'sent', 'observed', 'failed', 'unknown', 'cancelled'] },
    accepted: { type: 'boolean' },
    observed: { type: 'boolean' },
    attempts: { type: 'integer' },
    error: { type: 'string' },
  },
  required: ['requestId', 'targetSessionId', 'status', 'accepted', 'observed', 'attempts'],
} as const

const modelParameters = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Target ordinary DSH session id.' },
    provider: { type: 'string', description: 'Provider route id from session/modelCatalog.' },
    model: { type: 'string', description: 'Model id from the selected provider.' },
    reasoningEffort: { type: 'string', description: 'Optional reasoning effort id advertised by the model.' },
  },
  required: ['sessionId', 'provider', 'model'],
  additionalProperties: false,
} as const

const modelOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoningEffort: { type: 'string' },
    selected: { type: 'boolean' },
    observed: { type: 'boolean' },
    fallbackUsed: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['sessionId', 'provider', 'model', 'selected', 'observed', 'fallbackUsed'],
} as const

/** Register the three tools. */
export function registerOneTools(ctx: DshContextLike, core: OneCore, config: OneConfig): () => void {
  const disposers = [
    ctx.tools.register(sessionsTool(core, config)),
    ctx.tools.register(sendTool(core, config)),
    ctx.tools.register(modelTool(core, config)),
    ctx.tools.register(workspacesTool(core, config)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

const workspacesParameters = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Optional case-insensitive Workspace path fragment; omit for every Workspace.',
    },
    includeInstructions: {
      type: 'boolean',
      description: 'Include outstanding cross-session instructions. Defaults to true.',
    },
  },
  additionalProperties: false,
} as const

const workspacesOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          label: { type: 'string' },
          running: { type: 'number' },
          unregistered: { type: 'number' },
          lastActivityAt: { type: 'number' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                running: { type: 'boolean' },
                registered: { type: 'boolean' },
                blank: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    homeless: { type: 'array', items: { type: 'object', additionalProperties: true } },
    instructions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    totals: { type: 'object', additionalProperties: true },
  },
} as const

/**
 * List the Workspaces the assistant can command, their Sessions, and the
 * instructions it already sent. Read-only, like `one_sessions`.
 */
function workspacesTool(core: OneCore, config: OneConfig): ToolDefinitionLike {
  return {
    name: 'one_workspaces',
    description:
      'List Workspaces with the sessions inside each, plus outstanding cross-session instructions. '
      + 'Sessions are grouped by their cwd, so this is the map to choose a target before calling one_send. Read-only.',
    parameters: workspacesParameters,
    timeoutMs: config.commandTimeoutMs,
    output: {
      schema: workspacesOutput,
      render(_args, value) {
        const result = value as {
          workspaces: readonly {
            readonly path: string
            readonly label: string
            readonly running: number
            readonly sessions: readonly { readonly sessionId: string; readonly title?: string; readonly registered: boolean }[]
          }[]
          homeless: readonly unknown[]
          instructions: readonly { readonly requestId: string; readonly targetSessionId: string; readonly status: string }[]
          totals: { readonly sessions: number; readonly running: number; readonly pendingInstructions: number }
        }
        const lines: string[] = []
        for (const workspace of result.workspaces) {
          lines.push(`${workspace.label}  (${workspace.sessions.length} sessions, ${workspace.running} running)  ${workspace.path}`)
          for (const session of workspace.sessions) {
            const title = session.title === undefined ? '' : `  ${session.title}`
            lines.push(`  ${session.sessionId}${session.registered ? '' : ' (unlisted)'}${title}`)
          }
        }
        if (result.homeless.length > 0) lines.push(`no workspace: ${result.homeless.length} session(s)`)
        const pending = result.instructions.filter(item => item.status === 'pending' || item.status === 'sending')
        for (const item of pending) lines.push(`outstanding ${item.requestId} -> ${item.targetSessionId} (${item.status})`)
        return [{
          type: 'text',
          text: [
            `dsh-one workspaces: ${result.workspaces.length} workspaces, ${result.totals.sessions} sessions, `
            + `${result.totals.running} running, ${result.totals.pendingInstructions} outstanding`,
            ...lines,
          ].join('\n'),
        }]
      },
    },
    async execute(args) {
      const record = asRecord(args) ?? {}
      const needle = asString(record['path'])?.toLowerCase()
      const includeInstructions = asBoolean(record['includeInstructions']) ?? true
      const overview = await core.workspaceOverview()
      const workspaces = needle === undefined
        ? overview.workspaces
        : overview.workspaces.filter(group => group.path.toLowerCase().includes(needle))
      return {
        workspaces: workspaces.map(group => ({
          path: group.path,
          label: group.label,
          running: group.running,
          unregistered: group.unregistered,
          ...(group.lastActivityAt === undefined ? {} : { lastActivityAt: group.lastActivityAt }),
          sessions: group.sessions.map(session => ({
            sessionId: session.sessionId,
            ...(session.title === undefined ? {} : { title: session.title }),
            running: session.running,
            registered: session.registered,
            blank: session.blank,
          })),
        })),
        homeless: overview.homeless.map(session => ({ ...session })),
        instructions: includeInstructions ? overview.instructions.map(item => ({ ...item })) : [],
        totals: { ...overview.totals },
      }
    },
  }
}

function sessionsTool(core: OneCore, config: OneConfig): ToolDefinitionLike {
  return {
    name: 'one_sessions',
    description: 'List DSH sessions with their workspace, run state, registration, and selected model. Read-only.',
    parameters: sessionsParameters,
    timeoutMs: config.commandTimeoutMs,
    output: {
      schema: sessionsOutput,
      render(_args, value) {
        const result = value as { items: SessionView[]; degraded: boolean; reconciledAt?: number; error?: string }
        const lines = result.items.map(item => {
          const flags = [item.running ? 'running' : 'idle', item.registered ? 'registered' : 'unlisted', item.subagent ? 'subagent' : 'ordinary']
          const model = item.model === undefined ? '' : ` model=${item.model.provider}/${item.model.model}`
          return `${item.sessionId}  ${flags.join(',')}${model}${item.cwd === undefined ? '' : `  ${item.cwd}`}`
        })
        const head = `dsh-one sessions: ${result.items.length}${result.degraded ? ' (memory storage)' : ''}`
        return [{ type: 'text', text: [head, ...lines, ...(result.error === undefined ? [] : [`error: ${result.error}`])].join('\n') }]
      },
    },
    async execute(args, exec) {
      const record = asRecord(args) ?? {}
      const all = asBoolean(record['all']) ?? true
      const workspace = asString(record['workspace'])
      const listed = await core.listSessions()
      const items = listed.items.filter(item => {
        if (!all && !item.registered) return false
        if (workspace !== undefined && item.cwd !== undefined && !item.cwd.startsWith(workspace)) return false
        return true
      })
      return {
        items: items.map(toJsonSession),
        degraded: listed.degraded,
        ...(listed.reconciledAt === undefined ? {} : { reconciledAt: listed.reconciledAt }),
        ...(listed.error === undefined ? {} : { error: listed.error }),
      }
    },
  }
}

function sendTool(core: OneCore, config: OneConfig): ToolDefinitionLike {
  return {
    name: 'one_send',
    description: 'Send a user message to another ordinary DSH session. In observe mode this records the intended send without delivering it. Reuse requestId for idempotent retries.',
    parameters: sendParameters,
    timeoutMs: config.commandTimeoutMs,
    output: {
      schema: sendOutput,
      render(_args, value) {
        const result = value as SendResult
        const state = result.observed ? 'observed (not sent)' : result.status
        return [{ type: 'text', text: `one_send ${result.requestId} -> ${result.targetSessionId}: ${state}, attempts=${result.attempts}${result.error === undefined ? '' : `, error=${result.error}`}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = asRecord(args)
      const sessionId = asString(record?.['sessionId'])
      const text = asString(record?.['text'])
      const requestId = asString(record?.['requestId'])
      const mode = asString(record?.['mode'])
      if (sessionId === undefined || text === undefined) {
        throw new OneError('one/invalid-argument', 'sessionId and text are required')
      }
      if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
        throw new OneError('one/invalid-argument', 'mode must be queue or steer')
      }
      return core.send({
        targetSessionId: sessionId,
        text,
        ...(requestId === undefined ? {} : { requestId }),
        ...(mode === undefined ? {} : { mode }),
        callerSessionId: agentSessionId(agent),
        source: 'tool',
        signal: exec.signal,
      })
    },
  }
}

function modelTool(core: OneCore, config: OneConfig): ToolDefinitionLike {
  return {
    name: 'one_model',
    description: 'Select the model used by another ordinary DSH session from session/modelCatalog. In observe mode this records the intended selection without applying it.',
    parameters: modelParameters,
    timeoutMs: config.commandTimeoutMs,
    output: {
      schema: modelOutput,
      render(_args, value) {
        const result = value as SelectModelResult
        const state = result.observed ? 'observed (not applied)' : result.selected ? 'selected' : 'not selected'
        return [{ type: 'text', text: `one_model ${result.sessionId}: ${state} ${result.provider}/${result.model}${result.fallbackUsed ? ' (fallback)' : ''}${result.error === undefined ? '' : `, error=${result.error}`}` }]
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = asRecord(args)
      const sessionId = asString(record?.['sessionId'])
      const provider = asString(record?.['provider'])
      const model = asString(record?.['model'])
      const reasoningEffort = asString(record?.['reasoningEffort'])
      if (sessionId === undefined || provider === undefined || model === undefined) {
        throw new OneError('one/invalid-argument', 'sessionId, provider, and model are required')
      }
      return core.selectModel({
        targetSessionId: sessionId,
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        callerSessionId: agentSessionId(agent),
        source: 'tool',
        signal: exec.signal,
      })
    },
  }
}

function requireAgent(exec: ToolRunContextLike): AgentLike {
  if (exec.agent === undefined) {
    throw new OneError('one/no-agent', 'this tool requires a calling agent session')
  }
  return exec.agent
}

function toJsonSession(item: SessionView): Record<string, unknown> {
  return {
    sessionId: item.sessionId,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    running: item.running,
    blank: item.blank,
    subagent: item.subagent,
    registered: item.registered,
    trusted: item.trusted,
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.lastSeenAt === undefined ? {} : { lastSeenAt: item.lastSeenAt }),
  }
}
