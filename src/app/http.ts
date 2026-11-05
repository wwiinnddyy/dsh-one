/**
 * The assistant page's HTTP surface.
 *
 * Writes travel as GET query parameters so the same routes work on every host
 * build. The assistant page is self-contained: it never opens a DSH Session in
 * the UI, so the user is never asked to pick a Workspace.
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
    server.register({ kind: 'exact', path: '/one/api/chat', handler: (req, res) => guard(ctx, req, res, () => chat(runtime, req, res)) }),
    server.register({ kind: 'exact', path: '/one/api/chat/clear', handler: (req, res) => guard(ctx, req, res, () => clearChat(runtime, req, res)) }),
    server.register({ kind: 'exact', path: '/one/api/settings/avatar', handler: (req, res) => guard(ctx, req, res, () => avatar(runtime, req, res)) }),
    server.register({ kind: 'exact', path: '/one/api/tickets', handler: (req, res) => guard(ctx, req, res, () => tickets(runtime, res)) }),
    server.register({ kind: 'exact', path: '/one/api/tickets/stop', handler: (req, res) => guard(ctx, req, res, () => stopTicket(runtime, req, res)) }),
    server.register({ kind: 'exact', path: '/one/api/workspaces', handler: (req, res) => guard(ctx, req, res, () => workspaces(runtime, res)) }),
    server.register({ kind: 'exact', path: '/one/api/assistant', handler: (req, res) => guard(ctx, req, res, () => assistant(runtime, res)) }),
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
    avatar: runtime.settings.avatar() ?? null,
    model: runtime.chat.status().model,
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

async function assistant(runtime: OneRuntime, res: HttpResponseLike): Promise<void> {
  // The assistant page owns its transcript; the model lives in ctx.llm. No
  // Session is ever created or opened, so there is nothing to "boot".
  json(res, 200, {
    sessionId: null,
    model: runtime.chat.status().backend,
    displayName: runtime.assistantName(),
  })
}

/** Read the transcript, or append one human message when `send` is present. */
async function chat(runtime: OneRuntime, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const query = urlOf(req).searchParams
  const send = query.get('send')
  try {
    if (send !== null) {
      const result = await runtime.chat.send(send)
      return json(res, 200, { ok: true, ...result })
    }
    const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 200) || 200))
    json(res, 200, { items: runtime.chat.list(limit), status: runtime.chat.status() })
  } catch (error: unknown) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Drop the transcript and start a fresh conversation. */
async function clearChat(runtime: OneRuntime, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { error: 'method not allowed' })
  try {
    await runtime.chat.clear()
    json(res, 200, { ok: true })
  } catch (error: unknown) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Upload or clear the assistant avatar. Kept as POST so a data URL never rides a query string. */
async function avatar(runtime: OneRuntime, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { error: 'method not allowed' })
  try {
    const body = parseBody(await readBody(req))
    if (body['avatar'] === null || body['avatar'] === '') await runtime.settings.clearAvatar()
    else if (typeof body['avatar'] === 'string') await runtime.settings.setAvatar(body['avatar'])
    json(res, 200, settingsPayload(runtime))
  } catch (error: unknown) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
    avatar: runtime.settings.avatar() ?? null,
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

const MAX_BODY_BYTES = 600_000

async function readBody(req: HttpRequestLike): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))))
    req.resume?.()
  })
}

function parseBody(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function urlOf(req: HttpRequestLike): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1')
}
