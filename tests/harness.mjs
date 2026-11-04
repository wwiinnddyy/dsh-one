/** Offline fake host used by the dsh-one test suite. */

import { apply as applyCore } from '../lib/index.js'
import { apply as applyDelegate } from '../lib/delegate.js'
import { apply as applyIngress } from '../lib/ingress.js'

export const TABLE_NAMES = [
  'sessions', 'outbox', 'audit', 'tasks', 'leases', 'reports', 'triggers', 'threads',
  'evals', 'decisions', 'policies', 'mandates', 'deliveries', 'cursors', 'subscriptions',
]

export function makeTable(seed = []) {
  const records = new Map(seed)
  return {
    records,
    get(key) { return records.get(key) },
    entries() { return ([...records.entries()])[Symbol.iterator]() },
    get size() { return records.size },
    async put(key, value) { records.set(key, value) },
    async update(key, fn) {
      const current = records.get(key)
      if (current === undefined) throw new Error(`missing ${key}`)
      const next = fn(current)
      records.set(key, next)
      return next
    },
    async delete(key) { return records.delete(key) },
  }
}

export function makeStorageDomain(seed = {}) {
  const tables = new Map(TABLE_NAMES.map(name => [name, makeTable(seed[name] ?? [])]))
  return {
    tables,
    opened: 0,
    closed: 0,
    async open(spec) {
      if (spec.name !== 'dsh_one') throw new Error(`unexpected domain ${spec.name}`)
      this.opened += 1
      return {
        table(name) {
          const table = tables.get(name)
          if (table === undefined) throw new Error(`missing table ${name}`)
          return table
        },
        async close() { tables.get('sessions').records.set('closed', true); return undefined },
      }
    },
  }
}

export function makeAgent(id, cwd) {
  const agent = {
    id,
    session: { id, header: { cwd } },
    cancels: [],
    follows: 0,
    ctx: {
      tools: {
        registrations: [],
        restrictions: [],
        register(definition) {
          this.registrations.push(definition)
          return () => {}
        },
        restrict(filter) {
          this.restrictions.push(filter)
          return () => {}
        },
      },
    },
    cancel(cause) {
      this.cancels.push(cause)
    },
    followup() { this.follows += 1 },
    steer() { this.follows += 1 },
    inject() {},
  }
  return agent
}

export function makeController({ sessions = [], promptImpl, catalog, selectModelImpl, agents } = {}) {
  const calls = { list: 0, create: [], prompt: [], selectModel: [], cancel: [], modelCatalog: 0 }
  const state = { sessions: [...sessions] }
  const agentMap = agents ?? new Map()
  return {
    calls,
    state,
    agentMap,
    async list() {
      calls.list += 1
      return { items: [...state.sessions] }
    },
    async create(request) {
      calls.create.push(request)
      const sessionId = request.sessionId ?? `worker-${calls.create.length}`
      if (!state.sessions.some(item => item.sessionId === sessionId)) {
        state.sessions.push({
          sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          agentAvailable: true,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        })
      }
      if (!agentMap.has(sessionId)) agentMap.set(sessionId, makeAgent(sessionId, request.cwd ?? 'C:\\work'))
      return { sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) }
    },
    async resolveAgent(sessionId) {
      const agent = agentMap.get(sessionId)
      return agent === undefined ? { error: { code: 'session/not-found', message: `missing ${sessionId}` } } : { agent }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      if (selectModelImpl !== undefined) return selectModelImpl(request)
      return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
    },
    async modelCatalog() {
      calls.modelCatalog += 1
      return catalog ?? {
        default: { provider: 'p', model: 'm1' },
        routableProviders: ['p'],
        groups: [{ id: 'p', name: 'P', models: [{ id: 'm1', name: 'M1' }] }],
        failures: [],
      }
    },
    async prompt(request, signal) {
      calls.prompt.push(request)
      if (promptImpl !== undefined) return promptImpl(request, signal)
      return {}
    },
    cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
  }
}

export function makePermissionPresets() {
  const calls = { set: [], resolve: [] }
  return {
    calls,
    catalog() {
      return {
        options: [
          { value: 'read-only', name: 'Read only' },
          { value: 'workspace-write', name: 'Workspace' },
        ],
        defaultPreset: 'workspace-write',
      }
    },
    resolve(name) {
      calls.resolve.push(name)
      return { sandbox: 'read-only', approval: 'never' }
    },
    set(session, name) {
      calls.set.push({ sessionId: session?.id, name })
    },
  }
}

export function makeWebServer() {
  const routes = new Map()
  return {
    routes,
    registered: 0,
    register(route) {
      this.registered += 1
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    async request(path, request) {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`route ${path} is not registered`)
      const response = makeResponse()
      await handler(request, response)
      return response
    },
  }
}

export function makeConnection(rejection) {
  return {
    calls: 0,
    requestRejection() {
      this.calls += 1
      return rejection
    },
  }
}

export function makeReq({ method = 'GET', headers = {}, body } = {}) {
  const listeners = new Map()
  let emitted = false
  const emit = () => {
    if (emitted) return
    emitted = true
    const chunks = body === undefined ? [] : [Buffer.from(body)]
    queueMicrotask(() => {
      for (const chunk of chunks) {
        for (const listener of listeners.get('data') ?? []) listener(chunk)
      }
      for (const listener of listeners.get('end') ?? []) listener()
    })
  }
  return {
    method,
    headers,
    url: '/',
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      if (event === 'end') emit()
      return this
    },
    resume() {},
    destroy() {},
  }
}

export function makeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(body) {
      this.body = body
      this.headersSent = true
      return this
    },
    json() {
      return this.body === undefined ? undefined : JSON.parse(this.body)
    },
  }
}

export function makeCtx({ controller, storageDomain, webServer, connection, agents, permissionPresets, llm } = {}) {
  const tools = new Map()
  const commands = new Map()
  const services = new Map()
  const effects = []
  const listeners = new Map()
  const serviceResolver = () => {
    if (services.has('oneCore')) return
  }
  void serviceResolver
  const ctx = {
    root: null,
    effect(callback, label = 'effect') {
      const dispose = callback()
      effects.push({ label, dispose })
      return () => {
        const index = effects.findIndex(item => item.dispose === dispose)
        if (index !== -1) effects.splice(index, 1)
        if (typeof dispose === 'function') dispose()
      }
    },
    get(name) {
      if (services.has(name)) return services.get(name)
      if (name === 'sessionController') return controller
      if (name === 'storageDomain') return storageDomain
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      if (name === 'agents') return agents
      if (name === 'permissionPresets') return permissionPresets
      if (name === 'llm') return llm
      return undefined
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        const index = bucket.indexOf(listener)
        if (index !== -1) bucket.splice(index, 1)
      }
    },
    inject(names, callback) {
      const missing = names.filter(name => ctx.get(name) === undefined)
      if (missing.length === 0) callback(ctx)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
  }
  ctx.root = ctx
  const emitSession = (sessionId, event) => {
    for (const listener of listeners.get('session/event') ?? []) {
      listener({ id: sessionId }, event)
    }
  }
  const dispose = async () => {
    for (const item of [...effects].reverse()) {
      if (typeof item.dispose === 'function') {
        try {
          await item.dispose()
        } catch {
          // Best-effort teardown in tests.
        }
      }
    }
    effects.length = 0
  }
  return {
    ctx,
    tools,
    commands,
    services,
    effects,
    emitSession,
    dispose,
    listeners,
  }
}

/** Apply one or more plugin rows on a shared fake host. */
export async function createEnv(options = {}) {
  const agents = options.agents ?? new Map()
  const controller = options.controller ?? makeController({ sessions: options.sessions ?? [], agents })
  const storageDomain = options.storageDomain ?? makeStorageDomain(options.seed)
  const webServer = options.webServer ?? makeWebServer()
  const connection = options.connection ?? makeConnection(options.rejection)
  const permissionPresets = options.permissionPresets ?? makePermissionPresets()
  const host = makeCtx({ controller, storageDomain, webServer, connection, agents, permissionPresets, llm: options.llm })
  await applyCore(host.ctx, options.coreConfig ?? {})
  if (options.delegate !== false) await applyDelegate(host.ctx, options.delegateConfig ?? {})
  if (options.ingress === true) await applyIngress(host.ctx, options.ingressConfig ?? {})
  return {
    ...host,
    controller,
    storageDomain,
    webServer,
    connection,
    agents,
    permissionPresets,
    taskService: host.services.get('oneTasks'),
    intake: host.services.get('oneIntake'),
    core: host.services.get('oneCore'),
  }
}

/** A mention-shaped GitHub event. */
export function githubEvent(overrides = {}) {
  return {
    id: 'github:acme/repo:issue:1:delivery-1',
    kind: 'issues',
    sourceId: 'github',
    repository: 'acme/repo',
    actor: 'alice',
    action: 'opened',
    threadId: 'github:acme/repo:issue-1',
    externalId: 'issue-1',
    number: 1,
    title: 'Fix the failing test',
    body: '@one please fix the failing test and open a PR',
    url: 'https://github.com/acme/repo/issues/1',
    isPullRequest: false,
    createdAt: 1,
    deliveryId: 'delivery-1',
    ...overrides,
  }
}
