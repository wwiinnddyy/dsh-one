import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeAgent(id, cwd, followup = { count: 0 }) {
  return {
    id,
    session: { id, header: { cwd } },
    followup() {
      followup.count += 1
    },
    followupSpy: followup,
  }
}

function makeTable(seed = []) {
  const records = new Map(seed)
  return {
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

function makeStorageDomain(seedSessions = []) {
  const tables = new Map([
    ['sessions', makeTable(seedSessions.map(record => [record.sessionId, record]))],
    ['outbox', makeTable()],
    ['audit', makeTable()],
  ])
  return {
    tables,
    async open(spec) {
      assert.equal(spec.name, 'dsh-one')
      return {
        table(name) {
          const table = tables.get(name)
          if (table === undefined) throw new Error(`missing table ${name}`)
          return table
        },
        async close() {},
      }
    },
  }
}

function defaultCatalog() {
  return {
    default: { provider: 'p', model: 'm1' },
    routableProviders: ['p'],
    groups: [{ id: 'p', name: 'P', models: [{ id: 'm1', name: 'M1' }] }],
    failures: [],
  }
}

function makeController({ sessions = [], promptImpl, catalog = defaultCatalog(), selectModelImpl } = {}) {
  const calls = { list: 0, create: [], prompt: [], selectModel: [], modelCatalog: 0 }
  const state = { sessions: [...sessions] }
  return {
    calls,
    state,
    async list() {
      calls.list += 1
      return { items: [...state.sessions] }
    },
    async create(request) {
      calls.create.push(request)
      const sessionId = request.sessionId ?? `new-${calls.create.length}`
      if (!state.sessions.some(item => item.sessionId === sessionId)) {
        state.sessions.push({
          sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          agentAvailable: false,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        })
      }
      return { sessionId }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      if (selectModelImpl !== undefined) return selectModelImpl(request)
      return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
    },
    async modelCatalog() {
      calls.modelCatalog += 1
      return catalog
    },
    async prompt(request, signal) {
      calls.prompt.push(request)
      if (promptImpl !== undefined) return promptImpl(request, signal)
      return {}
    },
  }
}

function makeCtx(controller, storageDomain) {
  const tools = new Map()
  const commands = new Map()
  const effects = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'storageDomain') return storageDomain
      return undefined
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
  return { ctx, tools, commands, effects }
}

async function setup({ config = {}, controller, storageDomain, seedSessions = [] } = {}) {
  const controllerValue = controller ?? makeController()
  const domain = storageDomain ?? makeStorageDomain(seedSessions)
  const { ctx, tools, commands } = makeCtx(controllerValue, domain)
  await apply(ctx, config)
  return { controller: controllerValue, domain, tools, commands }
}

const baseSessions = [
  { sessionId: 'caller', updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
  { sessionId: 'target', updatedAt: 2, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
]

test('reconcile creates a registered session missing from session/list', async () => {
  const seed = [{
    sessionId: 'gone',
    status: 'active',
    trusted: true,
    createdAt: 1,
    updatedAt: 1,
  }]
  const controller = makeController({ sessions: [] })
  const { domain } = await setup({ controller, seedSessions: seed, config: { allowSessionCreation: true } })
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.create[0].sessionId, 'gone')
  const record = domain.tables.get('sessions').get('gone')
  assert.equal(record.status, 'active')
})

test('reconcile marks a missing session when creation is disabled', async () => {
  const seed = [{
    sessionId: 'gone',
    status: 'active',
    trusted: true,
    createdAt: 1,
    updatedAt: 1,
  }]
  const controller = makeController({ sessions: [] })
  const { commands } = await setup({ controller, seedSessions: seed, config: { allowSessionCreation: false } })
  const result = await commands.get('one').handler({ agent: makeAgent('caller', 'C:\\work'), rawInput: 'sessions' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /missing/)
})

test('one_send is idempotent by requestId', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools } = await setup({ controller, config: { mode: 'active', allowAllSessions: true } })
  const tool = tools.get('one_send')
  const agent = makeAgent('caller', 'C:\\work')
  const args = { sessionId: 'target', text: 'hello', requestId: 'req-1' }
  const first = await tool.execute(args, { agent, signal: AbortSignal.timeout(5000) })
  const second = await tool.execute(args, { agent, signal: AbortSignal.timeout(5000) })
  assert.equal(first.status, 'sent')
  assert.deepEqual(first, second)
  assert.equal(controller.calls.prompt.length, 1)
})

test('observe mode records a tool send but a command send delivers', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools, commands } = await setup({ controller, config: { mode: 'observe', allowAllSessions: true } })
  const tool = tools.get('one_send')
  const agent = makeAgent('caller', 'C:\\work')
  const observed = await tool.execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-observe' },
    { agent, signal: AbortSignal.timeout(5000) },
  )
  assert.equal(observed.status, 'observed')
  assert.equal(observed.observed, true)
  assert.equal(controller.calls.prompt.length, 0)
  const command = await commands.get('one').handler({ agent, rawInput: 'send target hello-from-command' })
  assert.equal(command.kind, 'success')
  assert.equal(controller.calls.prompt.length, 1)
})

test('send retries writer-held and succeeds within the limit', async () => {
  let attempts = 0
  const controller = makeController({
    sessions: baseSessions,
    promptImpl() {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('writer held')
        error.code = 'session/writer-held'
        throw error
      }
      return {}
    },
  })
  const { tools } = await setup({
    controller,
    config: { mode: 'active', allowAllSessions: true, maxSendAttempts: 3, retryDelayMs: 0 },
  })
  const result = await tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-retry' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.status, 'sent')
  assert.equal(result.attempts, 3)
  assert.equal(controller.calls.prompt.length, 3)
})

test('send records failure after exhausting retries', async () => {
  const controller = makeController({
    sessions: baseSessions,
    promptImpl() {
      const error = new Error('writer held')
      error.code = 'session/writer-held'
      throw error
    },
  })
  const { tools, commands } = await setup({
    controller,
    config: { mode: 'active', allowAllSessions: true, maxSendAttempts: 3, retryDelayMs: 0 },
  })
  const result = await tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-fail' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.attempts, 3)
  const status = await commands.get('one').handler({ agent: makeAgent('caller', 'C:\\work'), rawInput: 'status req-fail' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /failed/)
})

test('model selection falls back when the requested route is unavailable', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools } = await setup({ controller, config: { mode: 'active', allowAllSessions: true } })
  const result = await tools.get('one_model').execute(
    { sessionId: 'target', provider: 'p', model: 'm2' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.selected, true)
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.model, 'm1')
  assert.deepEqual(controller.calls.selectModel[0], { sessionId: 'target', provider: 'p', model: 'm1' })
})

test('subagent targets are rejected', async () => {
  const controller = makeController({
    sessions: [
      ...baseSessions,
      { sessionId: 'child', updatedAt: 3, running: false, blank: false, agentAvailable: false, origin: 'subagent', parentSessionId: 'caller' },
    ],
  })
  const { tools } = await setup({ controller, config: { mode: 'active', allowAllSessions: true } })
  await assert.rejects(
    tools.get('one_send').execute(
      { sessionId: 'child', text: 'hello' },
      { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
    ),
    error => error.code === 'one/subagent-target',
  )
})

test('commands do not open a model turn', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { commands } = await setup({ controller, config: { mode: 'active', allowAllSessions: true } })
  const agent = makeAgent('caller', 'C:\\work')
  const result = await commands.get('one').handler({ agent, rawInput: 'send target hello' })
  assert.equal(result.kind, 'success')
  assert.equal(agent.followupSpy.count, 0)
  assert.equal(controller.calls.prompt.length, 1)
})

test('unregistered targets are forbidden until explicitly added', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools, commands } = await setup({ controller, config: { mode: 'active', allowAllSessions: false } })
  const agent = makeAgent('caller', 'C:\\work')
  await assert.rejects(
    tools.get('one_send').execute(
      { sessionId: 'target', text: 'hello', requestId: 'req-forbidden' },
      { agent, signal: AbortSignal.timeout(5000) },
    ),
    error => error.code === 'one/session-forbidden',
  )
  const added = await commands.get('one').handler({ agent, rawInput: 'sessions add target' })
  assert.equal(added.kind, 'success')
  const sent = await tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-allowed' },
    { agent, signal: AbortSignal.timeout(5000) },
  )
  assert.equal(sent.status, 'sent')
})

test('model selection applies the requested route and persists it', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools, domain } = await setup({ controller, config: { mode: 'active', allowAllSessions: true } })
  const result = await tools.get('one_model').execute(
    { sessionId: 'target', provider: 'p', model: 'm1' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.selected, true)
  assert.equal(result.fallbackUsed, false)
  assert.deepEqual(controller.calls.selectModel[0], { sessionId: 'target', provider: 'p', model: 'm1' })
  assert.deepEqual(domain.tables.get('sessions').get('target').model, { provider: 'p', model: 'm1' })
})

test('observe mode records a model change but a command applies it', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools, commands } = await setup({ controller, config: { mode: 'observe', allowAllSessions: true } })
  const agent = makeAgent('caller', 'C:\\work')
  const observed = await tools.get('one_model').execute(
    { sessionId: 'target', provider: 'p', model: 'm1' },
    { agent, signal: AbortSignal.timeout(5000) },
  )
  assert.equal(observed.observed, true)
  assert.equal(observed.selected, false)
  assert.equal(controller.calls.selectModel.length, 0)
  const applied = await commands.get('one').handler({ agent, rawInput: 'model target p/m1' })
  assert.equal(applied.kind, 'success')
  assert.equal(controller.calls.selectModel.length, 1)
})

test('non-retryable send failure records the actual attempt count', async () => {
  const controller = makeController({
    sessions: baseSessions,
    promptImpl() {
      const error = new Error('not found')
      error.code = 'session/not-found'
      throw error
    },
  })
  const { tools } = await setup({
    controller,
    config: { mode: 'active', allowAllSessions: true, maxSendAttempts: 3, retryDelayMs: 0 },
  })
  const result = await tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-no-retry' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.attempts, 1)
  assert.equal(controller.calls.prompt.length, 1)
})

test('one_sessions lists host sessions and reports storage state', async () => {
  const controller = makeController({ sessions: baseSessions })
  const { tools } = await setup({ controller, config: { allowAllSessions: true } })
  const result = await tools.get('one_sessions').execute({ all: true }, { signal: AbortSignal.timeout(5000) })
  assert.equal(result.items.length, 2)
  assert.equal(result.degraded, false)
})

test('a profile without sessionController and storageDomain still loads', async () => {
  const { ctx, tools } = makeCtx(undefined, undefined)
  await apply(ctx, {})
  const result = await tools.get('one_sessions').execute({ all: true }, { signal: AbortSignal.timeout(5000) })
  assert.equal(result.degraded, true)
  assert.match(result.error, /sessionController is unavailable/)
})
