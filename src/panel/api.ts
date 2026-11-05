/** Read-only `/one/api/*` routes for the Web client panel. */

import type {
  ConnectionLike,
  DshContextLike,
  HttpResponseLike,
  HttpRequestLike,
  IntakeService,
  PanelItem,
  PanelOverview,
  RunService,
  RunView,
  TaskService,
  WebServerLike,
} from '../types.js'
import { OneError } from '../types.js'
import type { OneCore } from '../core/registry.js'
import type { SettingsService } from '../core/settings.js'
import { readBody, jsonResponse } from '../source/github.js'
import { classifyError, now as systemNow } from '../util.js'
import { DEFAULT_PERSONA, PERSONA_MAX_CHARS } from '../core/persona.js'
import { ensureAssistantWorkspace } from '../core/identity.js'

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
    server.register({
      kind: 'exact',
      path: '/one/api/runs',
      handler: wrap(ctx, async (req, res) => {
        await handleRunsRoute(ctx, settings, req, res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: '/one/api/run',
      handler: wrap(ctx, async (req, res) => {
        await handleRunRoute(ctx, req, res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: '/one/api/run/control',
      handler: wrap(ctx, async (req, res) => {
        await handleRunControlRoute(ctx, req, res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: '/one/api/activity',
      handler: wrap(ctx, async (req, res) => {
        await handleActivityRoute(ctx, req, res)
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
}

function runService(ctx: DshContextLike): RunService | undefined {
  return ctx.get('oneRuns') as RunService | undefined
}

function intakeService(ctx: DshContextLike): IntakeService | undefined {
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
    jsonResponse(res, 200, settingsPayload(settings, ctx))
    return
  }
  if (method === 'DELETE') {
    const name = await settings.resetName()
    jsonResponse(res, 200, { ...settingsPayload(settings, ctx), displayName: name })
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
    ? (body as {
      displayName?: unknown
      reset?: unknown
      persona?: unknown
      resetPersona?: unknown
      notifyMuted?: unknown
      runsPaused?: unknown
      quietFrom?: unknown
      quietTo?: unknown
    })
    : undefined
  if (requested?.resetPersona === true) {
    await settings.clearPersona()
    jsonResponse(res, 200, settingsPayload(settings, ctx))
    return
  }
  if (typeof requested?.persona === 'string') {
    try {
      await settings.setPersona(requested.persona)
      jsonResponse(res, 200, settingsPayload(settings, ctx))
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      jsonResponse(res, code === 'one/persona-empty' || code === 'one/persona-too-long' ? 400 : 500, {
        error: classifyError(error).message,
        ...(code === undefined ? {} : { code }),
      })
    }
    return
  }
  if (typeof requested?.notifyMuted === 'boolean') {
    await settings.setNotifyMuted(requested.notifyMuted, 'human')
    jsonResponse(res, 200, settingsPayload(settings, ctx))
    return
  }
  if (typeof requested?.runsPaused === 'boolean') {
    await settings.setRunsPaused(requested.runsPaused, 'human')
    jsonResponse(res, 200, settingsPayload(settings, ctx))
    return
  }
  if (requested?.quietFrom !== undefined || requested?.quietTo !== undefined) {
    const from = requested.quietFrom === null ? undefined : requested.quietFrom
    const to = requested.quietTo === null ? undefined : requested.quietTo
    if ((from === undefined) !== (to === undefined)
      || (from !== undefined && typeof from !== 'number')
      || (to !== undefined && typeof to !== 'number')) {
      jsonResponse(res, 400, { error: 'quietFrom and quietTo must both be numbers 0..1439, or both null' })
      return
    }
    try {
      await settings.setQuietHours(from as number | undefined, to as number | undefined, 'human')
      jsonResponse(res, 200, settingsPayload(settings, ctx))
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      jsonResponse(res, code === 'one/quiet-hours' ? 400 : 500, {
        error: classifyError(error).message,
        ...(code === undefined ? {} : { code }),
      })
    }
    return
  }
  if (requested?.reset === true) {
    const name = await settings.resetName()
    jsonResponse(res, 200, { ...settingsPayload(settings, ctx), displayName: name })
    return
  }
  if (typeof requested?.displayName !== 'string') {
    jsonResponse(res, 400, { error: 'displayName must be a string' })
    return
  }
  try {
    const name = await settings.setName(requested.displayName)
    jsonResponse(res, 200, { ...settingsPayload(settings, ctx), displayName: name })
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    jsonResponse(res, code === 'one/name-too-long' || code === 'one/name-invalid' || code === 'one/name-empty' ? 400 : 500, {
      error: classifyError(error).message,
      ...(code === undefined ? {} : { code }),
    })
  }
}

function settingsPayload(settings: SettingsService, ctx: DshContextLike): Record<string, unknown> {
  const quiet = settings.quietHours()
  const runs = runService(ctx)
  return {
    displayName: settings.displayName(),
    defaultDisplayName: settings.defaultDisplayName(),
    overridden: settings.hasOverride(),
    sessionId: settings.assistantSessionId() ?? null,
    home: settings.assistantHome() ?? null,
    notifyMuted: settings.notifyMuted(),
    runsPaused: settings.runsPaused(),
    quietFrom: quiet.from ?? null,
    quietTo: quiet.to ?? null,
    assistantRunMode: runs?.mode ?? 'unavailable',
    persona: settings.persona() ?? null,
    defaultPersona: DEFAULT_PERSONA,
    personaMaxChars: PERSONA_MAX_CHARS,
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
  const home = await core.resolveAssistantHome(settings.assistantHome())
  if (stored !== undefined) {
    // The stored Session is only reusable when it already lives in the home we
    // would create today. A Session made before the home existed carries some
    // other `cwd`, so reopening it would show a stale blank conversation.
    if (await core.assistantSessionReusable(stored, home)) {
      jsonResponse(res, 200, { sessionId: stored, created: false, home })
      return
    }
  }
  await settings.setAssistantHome(home, 'system')
  // Register the home as a real Workspace before creating the Session, so the
  // client resolves an existing Workspace id instead of inferring one.
  await ensureAssistantWorkspace(ctx, home, settings.displayName())
  const created = await core.createAssistantSession(home, settings.displayName())
  await settings.setAssistantSessionId(created.sessionId, 'system')
  // Seed the conversation with one assistant turn, so opening it shows a chat
  // that has already started rather than an empty box with no idea what it is.
  await core.greetAssistantSession(created.sessionId, settings.displayName())
  jsonResponse(res, 200, { sessionId: created.sessionId, created: true, home })
}

async function handleRunsRoute(
  ctx: DshContextLike,
  settings: SettingsService,
  req: HttpRequestLike,
  res: HttpResponseLike,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  const runs = runService(ctx)
  if (method === 'GET') {
    if (runs === undefined) {
      jsonResponse(res, 200, {
        generatedAt: systemNow(),
        assistant: { sessionId: settings.assistantSessionId() ?? null, displayName: settings.displayName() },
        pausedAll: settings.runsPaused(),
        groups: [],
        totals: { active: 0, needsYou: 0, done: 0, failed: 0, paused: 0 },
      })
      return
    }
    jsonResponse(res, 200, runs.summary())
    return
  }
  if (method !== 'POST') {
    jsonResponse(res, 405, { error: 'method not allowed' })
    return
  }
  if (runs === undefined) {
    jsonResponse(res, 503, { error: 'delegation is not mounted' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req, 8_192)) as Record<string, unknown>
  } catch (error: unknown) {
    const status = (error as { status?: number }).status
    jsonResponse(res, status === 413 ? 413 : 400, { error: classifyError(error).message })
    return
  }
  const goal = typeof body['goal'] === 'string' ? body['goal'].trim() : ''
  if (goal === '') {
    jsonResponse(res, 400, { error: 'goal is required' })
    return
  }
  const steps = Array.isArray(body['steps'])
    ? (body['steps'] as unknown[]).flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const title = typeof record['title'] === 'string' ? record['title'] : ''
      const stepGoal = typeof record['goal'] === 'string' ? record['goal'] : ''
      const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : undefined
      return title === '' || stepGoal === '' ? [] : [{ title, goal: stepGoal, ...(cwd === undefined ? {} : { cwd }) }]
    })
    : undefined
  try {
    const result = await runs.start({
      goal,
      ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      ...(typeof body['cwd'] === 'string' ? { cwd: body['cwd'] } : {}),
      ...(steps === undefined ? {} : { steps }),
      ...(typeof body['maxTasks'] === 'number' ? { maxTasks: body['maxTasks'] } : {}),
      ...(typeof body['deadlineMs'] === 'number' ? { deadlineMs: body['deadlineMs'] } : {}),
      ...(typeof body['idempotencyKey'] === 'string' ? { idempotencyKey: body['idempotencyKey'] } : {}),
      origin: 'human',
    })
    jsonResponse(res, 200, result)
  } catch (error: unknown) {
    const code = error instanceof OneError ? error.code : undefined
    jsonResponse(res, code === 'one/invalid-argument' || code === 'one/run-no-workspace' || code === 'one/workspace-forbidden' ? 400 : 500, {
      error: classifyError(error).message,
      ...(code === undefined ? {} : { code }),
    })
  }
}

async function handleRunRoute(ctx: DshContextLike, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    jsonResponse(res, 405, { error: 'method not allowed' })
    return
  }
  const runs = runService(ctx)
  if (runs === undefined) {
    jsonResponse(res, 503, { error: 'delegation is not mounted' })
    return
  }
  const runId = urlOf(req).searchParams.get('id') ?? ''
  if (runId === '') {
    jsonResponse(res, 400, { error: 'id is required' })
    return
  }
  const run = runs.get(runId)
  if (run === undefined) {
    jsonResponse(res, 404, { error: 'run not found' })
    return
  }
  jsonResponse(res, 200, { run, activities: runs.activities(runId, 50) })
}

async function handleRunControlRoute(ctx: DshContextLike, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    jsonResponse(res, 405, { error: 'method not allowed' })
    return
  }
  const runs = runService(ctx)
  if (runs === undefined) {
    jsonResponse(res, 503, { error: 'delegation is not mounted' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req, 4_096)) as Record<string, unknown>
  } catch (error: unknown) {
    jsonResponse(res, 400, { error: classifyError(error).message })
    return
  }
  const runId = typeof body['runId'] === 'string' ? body['runId'] : ''
  const action = body['action']
  if (runId === '' || (action !== 'pause' && action !== 'resume' && action !== 'cancel')) {
    jsonResponse(res, 400, { error: 'runId and action (pause|resume|cancel) are required' })
    return
  }
  try {
    const run = await runs.control({
      runId,
      action,
      ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
    })
    jsonResponse(res, 200, { run })
  } catch (error: unknown) {
    const code = error instanceof OneError ? error.code : undefined
    jsonResponse(res, code === 'one/run-not-found' ? 404 : code === 'one/run-terminal' ? 409 : 500, {
      error: classifyError(error).message,
      ...(code === undefined ? {} : { code }),
    })
  }
}

async function handleActivityRoute(ctx: DshContextLike, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    jsonResponse(res, 405, { error: 'method not allowed' })
    return
  }
  const runs = runService(ctx)
  if (runs === undefined) {
    jsonResponse(res, 200, { items: [], next: null })
    return
  }
  const url = urlOf(req)
  const runId = url.searchParams.get('id') ?? undefined
  const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
  const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100))
  const items = runs.activities(runId, limit).filter(item => Number.isFinite(after) ? item.at > after : true)
  jsonResponse(res, 200, { items, next: items[0]?.at ?? null })
}

function urlOf(req: HttpRequestLike): URL {
  return new URL(req.url ?? '/', 'http://localhost')
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
  const runs = runService(ctx)
  const runSummary = runs?.summary()
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
    ...(runSummary === undefined || runs === undefined
      ? {}
      : { runs: { ...runSummary.totals, mode: runs.mode } }),
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
