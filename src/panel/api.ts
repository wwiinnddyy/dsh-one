/** Read-only `/one/api/*` routes for the Web client panel. */

import type {
  ConnectionLike,
  DshContextLike,
  HttpResponseLike,
  HttpRequestLike,
  IntakeService,
  PanelItem,
  PanelOverview,
  TaskService,
  WebServerLike,
} from '../types.js'
import type { OneCore } from '../core/registry.js'
import type { SettingsService } from '../core/settings.js'
import { readBody, jsonResponse } from '../source/github.js'
import { classifyError, now as systemNow } from '../util.js'

/** Register the panel's read endpoints and the one settings write endpoint. */
export function registerPanelApi(
  ctx: DshContextLike,
  core: OneCore,
  settings: SettingsService,
): () => void {
  const server = ctx.get('webServer') as WebServerLike | undefined
  if (server === undefined || typeof server.register !== 'function') return () => {}
  const disposers = [
    server.register({ kind: 'exact', path: '/one/api/overview', handler: wrap(ctx, async (req, res) => {
      jsonResponse(res, 200, buildPanelOverview(ctx, core, settings))
    }) }),
    server.register({ kind: 'exact', path: '/one/api/tasks', handler: wrap(ctx, async (_req, res) => {
      const tasks = taskService(ctx)
      jsonResponse(res, 200, { items: tasks === undefined ? [] : tasks.listTasks() })
    }) }),
    server.register({ kind: 'exact', path: '/one/api/decisions', handler: wrap(ctx, async (_req, res) => {
      const intake = intakeService(ctx)
      jsonResponse(res, 200, { items: intake === undefined ? [] : intake.decisions(30) })
    }) }),
    server.register({
      kind: 'exact',
      path: '/one/api/settings',
      handler: wrap(ctx, async (req, res) => {
        await handleSettingsRoute(ctx, settings, req, res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: '/one/api/assistant',
      handler: wrap(ctx, async (req, res) => {
        await handleAssistantRoute(ctx, core, settings, req, res)
      }),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function wrap(
  ctx: DshContextLike,
  handler: (req: HttpRequestLike, res: HttpResponseLike) => Promise<void>,
): (req: HttpRequestLike, res: HttpResponseLike) => Promise<void> {
  return async (req, res) => {
    if (rejectUnauthenticated(ctx, req, res)) return
    try {
      await handler(req, res)
    } catch (error: unknown) {
      jsonResponse(res, 500, { error: classifyError(error).message })
    }
  }
}

/** Raw web routes do not inherit the /api authentication fence. */
function rejectUnauthenticated(ctx: DshContextLike, req: HttpRequestLike, res: HttpResponseLike): boolean {
  const connection = ctx.get('connection') as ConnectionLike | undefined
  const rejection = connection === undefined ? 503 : connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({
    error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
  }))
  return true
}

function taskService(ctx: DshContextLike): TaskService | undefined {
  return ctx.get('oneTasks') as TaskService | undefined
}function intakeService(ctx: DshContextLike): IntakeService | undefined {
  return ctx.get('oneIntake') as IntakeService | undefined
}

/**
 * GET reads the current name, PUT persists one (`{ displayName }`), and
 * DELETE restores the row default. The route sits behind the same
 * authentication fence as the read endpoints, because it writes user state.
 */
async function handleSettingsRoute(
  ctx: DshContextLike,
  settings: SettingsService,
  req: HttpRequestLike,
  res: HttpResponseLike,
): Promise<void> {
  void ctx
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    jsonResponse(res, 200, settingsPayload(settings))
    return
  }
  if (method === 'DELETE') {
    const name = await settings.resetName()
    jsonResponse(res, 200, { ...settingsPayload(settings), displayName: name })
    return
  }
  if (method !== 'PUT' && method !== 'POST') {
    jsonResponse(res, 405, { error: 'method not allowed' })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req, 8_192))
  } catch (error: unknown) {
    const status = (error as { status?: number }).status
    jsonResponse(res, status === 413 ? 413 : 400, { error: classifyError(error).message })
    return
  }
  const requested = typeof body === 'object' && body !== null
    ? (body as { displayName?: unknown; reset?: unknown })
    : undefined
  if (requested?.reset === true) {
    const name = await settings.resetName()
    jsonResponse(res, 200, { ...settingsPayload(settings), displayName: name })
    return
  }
  if (typeof requested?.displayName !== 'string') {
    jsonResponse(res, 400, { error: 'displayName must be a string' })
    return
  }
  try {
    const name = await settings.setName(requested.displayName)
    jsonResponse(res, 200, { ...settingsPayload(settings), displayName: name })
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    jsonResponse(res, code === 'one/name-too-long' || code === 'one/name-invalid' || code === 'one/name-empty' ? 400 : 500, {
      error: classifyError(error).message,
      ...(code === undefined ? {} : { code }),
    })
  }
}

function settingsPayload(settings: SettingsService): Record<string, unknown> {
  return {
    displayName: settings.displayName(),
    defaultDisplayName: settings.defaultDisplayName(),
    overridden: settings.hasOverride(),
    sessionId: settings.assistantSessionId() ?? null,
  }
}

/**
 * The assistant entry's backend.
 *
 * `GET` reports the assistant's session without creating anything. `POST`
 * creates the session when it is missing and returns its id, so the client can
 * open a real conversation with `uiWorkspace.openSession()`. A stored id that
 * the host no longer lists is replaced rather than returned, because a stale id
 * would open an empty or failing conversation.
 */
async function handleAssistantRoute(
  ctx: DshContextLike,
  core: OneCore,
  settings: SettingsService,
  req: HttpRequestLike,
  res: HttpResponseLike,
): Promise<void> {
  void ctx
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    jsonResponse(res, 200, {
      displayName: settings.displayName(),
      sessionId: settings.assistantSessionId() ?? null,
    })
    return
  }
  if (method === 'DELETE') {
    await settings.clearAssistantSessionId()
    jsonResponse(res, 200, { sessionId: null })
    return
  }
  if (method !== 'POST' && method !== 'PUT') {
    jsonResponse(res, 405, { error: 'method not allowed' })
    return
  }

  const stored = settings.assistantSessionId()
  if (stored !== undefined) {
    const live = await core.sessionExists(stored)
    if (live) {
      jsonResponse(res, 200, { sessionId: stored, created: false })
      return
    }
  }
  const created = await core.createAssistantSession(settings.displayName())
  await settings.setAssistantSessionId(created.sessionId, 'system')
  jsonResponse(res, 200, { sessionId: created.sessionId, created: true })
}

/** Build the same overview the HTTP route serves; the DSH Go panel reads it directly. */
export function buildPanelOverview(
  ctx: DshContextLike,
  core: OneCore,
  settings: SettingsService,
): PanelOverview {
  const at = systemNow()
  const tasks = taskService(ctx)
  const intake = intakeService(ctx)
  const taskSnapshot = tasks?.snapshot() ?? { attention: [], running: [], history: [] }
  const intakeSnapshot = intake?.snapshot()
  const health = tasks?.health()
  const attention: PanelItem[] = [...taskSnapshot.attention].map(item => ({
    id: item.id,
    title: item.title,
    status: item.status,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    updatedAt: item.updatedAt,
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
  }))
  const running: PanelItem[] = [...taskSnapshot.running].map(item => ({
    id: item.id,
    title: item.title,
    status: item.status,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    updatedAt: item.updatedAt,
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
  }))
  const history: PanelItem[] = [
    ...taskSnapshot.history.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      updatedAt: item.updatedAt,
    })),
    ...(intakeSnapshot?.recent ?? []).map(item => ({ ...item })),
  ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
  const delegate = tasks === undefined ? 'unavailable' : tasks.mode
  const ingress = intake === undefined ? 'unavailable' : intake.health().acceptMode
  return {
    generatedAt: at,
    displayName: settings.displayName(),
    defaultDisplayName: settings.defaultDisplayName(),
    attention,
    running,
    history,
    health: {
      storage: core.degraded ? 'memory' : 'persistent',
      core: core.lastError === undefined ? 'ready' : 'degraded',
      delegate,
      ingress,
      ...(intakeSnapshot?.policyVersion === undefined ? {} : { policyVersion: intakeSnapshot.policyVersion }),
      leases: health?.leases ?? 0,
      workers: health?.workers ?? 0,
      maxWorkers: health?.maxWorkers ?? 0,
      ...(core.lastError === undefined && intakeSnapshot?.error === undefined
        ? {}
        : { lastError: core.lastError ?? intakeSnapshot?.error as string }),
    },
  }
}
