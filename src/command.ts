/** `/one` human command: sessions, send, model, status, audit. It never opens a model turn. */

import type { CommandDefinitionLike, CommandInvocationLike, CommandResultLike, DshContextLike, OneConfig } from './types.js'
import { OneError } from './types.js'
import { OneCore, agentSessionId } from './core.js'
import { classifyError, parseModelRoute, splitFirstToken } from './util.js'

const USAGE = [
  'Usage:',
  '  /one sessions [all]                      list registered and host sessions',
  '  /one sessions add <sessionId> [cwd]      explicitly trust a session',
  '  /one send [--steer] [--id <requestId>] <sessionId> <text>',
  '  /one model <sessionId> <provider>/<model> [reasoningEffort]',
  '  /one status <requestId>                  read the outbox row',
  '  /one audit [limit]                       recent audit rows',
  '  /one help',
].join('\n')

/** Register the single `/one` command. */
export function registerOneCommand(ctx: DshContextLike, core: OneCore, config: OneConfig): () => void {
  const definition: CommandDefinitionLike = {
    name: 'one',
    description: 'DSH One: list sessions, send to another session, or select its model',
    input: { hint: 'sessions | send | model | status | audit | help' },
    async handler(invocation: CommandInvocationLike): Promise<CommandResultLike> {
      try {
        return await handle(invocation, core)
      } catch (error: unknown) {
        if (error instanceof OneError) return { kind: 'error', text: `${error.code}: ${error.message}` }
        const classified = classifyError(error)
        return { kind: 'error', text: `${classified.code}: ${classified.message}` }
      }
    },
  }
  const dispose = ctx.commands.register(definition)
  return dispose
}

async function handle(invocation: CommandInvocationLike, core: OneCore): Promise<CommandResultLike> {
  const { token, rest } = splitFirstToken(invocation.rawInput)
  switch (token) {
    case '':
    case 'help':
      return { kind: 'success', text: USAGE }
    case 'sessions':
      return handleSessions(rest, invocation, core)
    case 'send':
      return handleSend(rest, invocation, core)
    case 'model':
      return handleModel(rest, invocation, core)
    case 'status':
      return handleStatus(rest, core)
    case 'audit':
      return handleAudit(rest, core)
    default:
      return { kind: 'error', text: `unknown /one action "${token}"\n${USAGE}` }
  }
}

async function handleSessions(rest: string, invocation: CommandInvocationLike, core: OneCore): Promise<CommandResultLike> {
  const { token, rest: after } = splitFirstToken(rest)
  if (token === 'add') {
    const { token: sessionId, rest: cwdText } = splitFirstToken(after)
    if (sessionId === '') return { kind: 'error', text: 'usage: /one sessions add <sessionId> [cwd]' }
    const record = await core.registerSession({
      sessionId,
      ...(cwdText.trim() === '' ? {} : { cwd: cwdText.trim() }),
    })
    return {
      kind: 'success',
      text: `registered ${record.sessionId}${record.cwd === undefined ? '' : ` at ${record.cwd}`}; trusted=true`,
    }
  }
  const all = token === 'all' || token === ''
  const listed = await core.listSessions()
  const items = listed.items.filter(item => all || item.registered)
  const lines = items.map(item => {
    const flags = [
      item.running ? 'running' : 'idle',
      item.registered ? 'registered' : 'unlisted',
      item.trusted ? 'trusted' : 'restricted',
      item.subagent ? 'subagent' : 'ordinary',
      ...(item.status === undefined || item.status === 'active' ? [] : [item.status]),
    ]
    const model = item.model === undefined ? '' : ` model=${item.model.provider}/${item.model.model}`
    return `${item.sessionId}  ${flags.join(',')}${model}${item.cwd === undefined ? '' : `  ${item.cwd}`}`
  })
  return {
    kind: 'success',
    text: [
      `sessions: ${items.length}${listed.degraded ? ' (memory storage)' : ''}`,
      ...lines,
      ...(listed.error === undefined ? [] : [`error: ${listed.error}`]),
    ].join('\n'),
  }
}

async function handleSend(rest: string, invocation: CommandInvocationLike, core: OneCore): Promise<CommandResultLike> {
  const tokens = rest.trim().split(/\s+/u)
  let mode: 'queue' | 'steer' = 'queue'
  let requestId: string | undefined
  const body: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '--steer') {
      mode = 'steer'
      continue
    }
    if (token === '--id') {
      requestId = tokens[index + 1]
      index += 1
      continue
    }
    body.push(token)
  }
  const [sessionId, ...textParts] = body
  const text = textParts.join(' ').trim()
  if (sessionId === undefined || text === '') {
    return { kind: 'error', text: 'usage: /one send [--steer] [--id <requestId>] <sessionId> <text>' }
  }
  const result = await core.send({
    targetSessionId: sessionId,
    text,
    ...(requestId === undefined ? {} : { requestId }),
    mode,
    callerSessionId: agentSessionId(invocation.agent),
    source: 'command',
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  })
  return {
    kind: result.status === 'failed' || result.status === 'cancelled' ? 'error' : 'success',
    text: `${result.requestId} -> ${result.targetSessionId}: ${result.status}, attempts=${result.attempts}${result.error === undefined ? '' : `, error=${result.error}`}`,
  }
}

async function handleModel(rest: string, invocation: CommandInvocationLike, core: OneCore): Promise<CommandResultLike> {
  const tokens = rest.trim().split(/\s+/u)
  const [sessionId, route, reasoningEffort] = tokens
  if (sessionId === undefined || route === undefined) {
    return { kind: 'error', text: 'usage: /one model <sessionId> <provider>/<model> [reasoningEffort]' }
  }
  const parsed = parseModelRoute(route)
  if (parsed === undefined) return { kind: 'error', text: 'model route must be <provider>/<model>' }
  const result = await core.selectModel({
    targetSessionId: sessionId,
    provider: parsed.provider,
    model: parsed.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    callerSessionId: agentSessionId(invocation.agent),
    source: 'command',
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  })
  return {
    kind: 'success',
    text: `${result.sessionId}: ${result.selected ? 'selected' : 'observed'} ${result.provider}/${result.model}${result.fallbackUsed ? ' (fallback)' : ''}`,
  }
}

function handleStatus(rest: string, core: OneCore): CommandResultLike {
  const requestId = rest.trim()
  if (requestId === '') return { kind: 'error', text: 'usage: /one status <requestId>' }
  const record = core.getOutbox(requestId)
  return {
    kind: 'success',
    text: [
      `request ${record.requestId}`,
      `target ${record.targetSessionId}`,
      `status ${record.status} attempts=${record.attempts}`,
      `mode ${record.mode} source ${record.source}`,
      ...(record.error === undefined ? [] : [`error ${record.error}`]),
    ].join('\n'),
  }
}

function handleAudit(rest: string, core: OneCore): CommandResultLike {
  const limit = Number.parseInt(rest.trim() === '' ? '20' : rest.trim(), 10)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { kind: 'error', text: 'audit limit must be 1..200' }
  const rows = core.listAudit(limit)
  return {
    kind: 'success',
    text: rows.length === 0
      ? 'no audit rows'
      : rows.map(row => `${row.at} ${row.action} ${row.outcome}${row.targetSessionId === undefined ? '' : ` -> ${row.targetSessionId}`}${row.detail === undefined ? '' : `  ${row.detail}`}`).join('\n'),
  }
}
