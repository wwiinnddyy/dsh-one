/**
 * The workbench HTTP surface.
 *
 * The host's plugin web server only serves GET/HEAD (any other method is
 * rejected with 405 before a plugin handler runs), so writes travel as GET
 * query parameters. They still go through the same Engine and Settings
 * services as the tools, so a click and a model call cannot diverge.
 */

import type {
  ConnectionLike,
  DshContextLike,
  HttpRequestLike,
  HttpResponseLike,
  WebServerLike,
} from '../types.js'
import type { OneRuntime } from './runtime.js'
import { stageOf } from '../core/stage.js'
import { workspaceKey, workspaceLabel } from './paths.js'

export function registerPanelApi(ctx: DshContextLike, runtime: OneRuntime): () => void {
  const server = ctx.get('webServer') as WebServerLike | undefined
  if (server === undefined) return () => {}
  const disposers = [
    server.register({ kind: 'exact', path: '/one/api/overview', handler: (req, res) => guard(ctx, req, res, () => overview(runtime, res)) }),
    server.register({ kind: 'exact', path: '/one/api/tickets', handler: (req, res) => guard(ctx, req, res, () => tickets(runtime, res)) }),
    server.register({ kind: 'exact', path: '/one/api/tickets/stop', handler: (req, res) => guard(ctx, req, res, () => stopTicket(runtime, req, res)) }),
    server.register({ kind: 'exact', path: '/one/api/workspaces', handler: (req, res) => guard(ctx, req, res, () => workspaces(runtime, res)) }),
    server.register({ kind: 'exact', path: '/one/api/assistant', handler: (req, res) => guard(ctx, req, res, () => assistant(runtime, req, res)) }),
    server.register({ kind: 'exact', path: '/one/api/settings', handler: (req, res) => guard(ctx, req, res, () => settings(runtime, req, res)) }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function guard(
  ctx: DshContextLike,
  req: HttpRequestLike,
  res: HttpResponseLike,
  handler: () => Promise<void> | void,
): Promise<void> | void {
  const connection = ctx.get('connection') as ConnectionLike | undefined
  const rejection = connection?.requestRejection({ headers: req.headers })
  if (rejection !== undefined) {
    json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return
  }
  return handler()
}

async function overview(runtime: OneRuntime, res: HttpResponseLike): Promise<void> {
  const tickets = runtime.engine.list()
  const byStage: Record<string, number> = {}
  for (const ticket of tickets) {
    const stage = stageOf(ticket)
    byStage[stage] = (byStage[stage] ?? 0) + 1
  }
  const sessions = await runtime.sessions.list()
  const records = runtime.store.listSessions()
  const workspaces = [...new Map(
    records.filter(item => item.cwd !== undefined).map(item => [workspaceKey(item.cwd as string), item.cwd as string]),
  ).entries()].map(([key, path]) => ({
    path,
    label: workspaceLabel(path),
    sessions: records.filter(item => item.cwd !== undefined && workspaceKey(item.cwd) === key).length,
  }))
  json(res, 200, {
    displayName: runtime.assistantName(),
    defaultDisplayName: runtime.config.displayName,
    assistantSessionId: runtime.assistantSessionId() ?? null,
    backend: runtime.store.backend,
    tickets: {
      total: tickets.length,
      open: tickets.filter(item => item.status === 'open').length,
      ended: tickets.filter(item => item.status === 'ended').length,
      byStage,
    },
    sessions: sessions.map(item => {
      const managed = records.find(record => record.sessionId === item.sessionId)
      return {
        sessionId: item.sessionId,
        ...(managed === undefined ? {} : { role: managed.role }),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        running: item.running,
      }
    }),
    workspaces,
    goals: runtime.engine.listGoals().map(goal => runtime.engine.goalView(goal.goalId)),
  })
}

function tickets(runtime: OneRuntime, res: HttpResponseLike): void {
  const rows = runtime.engine.list()
    .map(ticket => runtime.engine.view(ticket.ticketId))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .map(item => ({
      ticketId: item.ticketId,
      title: item.title,
      goal: item.goal,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      status: item.status,
      ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
      stage: item.stage,
      ...(item.latestReport === undefined ? {} : { latestReport: item.latestReport.summary }),
      ...(item.attention === undefined ? {} : { question: item.attention.question }),
      updatedAt: item.updatedAt,
    }))
  json(res, 200, { items: rows })
}

async function stopTicket(runtime: OneRuntime, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const ticketId = urlOf(req).searchParams.get('ticketId')
  if (ticketId === null || ticketId.trim() === '') return json(res, 400, { error: 'ticketId is required' })
  try {
    const ticket = await runtime.engine.stop({ ticketId, reason: 'stopped from the workbench' })
    json(res, 200, { ticketId: ticket.ticketId, status: ticket.status })
  } catch (error: unknown) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function workspaces(runtime: OneRuntime, res: HttpResponseLike): void {
  const records = runtime.store.listSessions()
  const rows = [...new Map(
    records.filter(item => item.cwd !== undefined).map(item => [workspaceKey(item.cwd as string), item.cwd as string]),
  ).entries()].map(([key, path]) => ({
    path,
    label: workspaceLabel(path),
    sessions: records
      .filter(item => item.cwd !== undefined && workspaceKey(item.cwd) === key)
      .map(item => ({ sessionId: item.sessionId, role: item.role })),
  }))
  json(res, 200, { items: rows })
}

async function assistant(runtime: OneRuntime, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const create = urlOf(req).searchParams.get('create') === '1'
  if (!create) {
    const sessionId = runtime.assistantSessionId()
    return json(res, 200, { sessionId: sessionId ?? null })
  }
  try {
    const created = await runtime.ensureAssistant()
    json(res, 200, created)
  } catch (error: unknown) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function settings(runtime: OneRuntime, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const query = urlOf(req).searchParams
  try {
    if (query.get('resetName') === '1') {
      await runtime.settings.resetDisplayName()
    } else if (query.get('displayName') !== null) {
      await runtime.settings.setDisplayName(query.get('displayName') ?? '')
    }
    if (query.get('resetPersona') === '1') {
      await runtime.settings.clearPersona()
    } else if (query.get('persona') !== null) {
      const persona = query.get('persona') ?? ''
      if (persona.trim() === '') await runtime.settings.clearPersona()
      else await runtime.settings.setPersona(persona)
    }
    if (query.get('notifyMuted') !== null) {
      await runtime.settings.setNotifyMuted(query.get('notifyMuted') === 'true')
    }
    json(res, 200, settingsPayload(runtime))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    json(res, 400, { error: message })
  }
}

function settingsPayload(runtime: OneRuntime): Record<string, unknown> {
  return {
    displayName: runtime.assistantName(),
    defaultDisplayName: runtime.config.displayName,
    overridden: runtime.store.getSetting('one', 'displayName') !== undefined,
    persona: runtime.settings.persona() ?? null,
    notifyMuted: runtime.settings.notifyMuted(),
    backend: runtime.store.backend,
  }
}

function json(res: HttpResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

export function urlOf(req: HttpRequestLike): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1')
}
