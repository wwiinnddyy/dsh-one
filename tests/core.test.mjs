import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { createEnv, makeAgent, makeController, makeCtx } from './harness.mjs'

const sessions = [
  { sessionId: 'caller', updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
  { sessionId: 'target', updatedAt: 2, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
]

test('one_send is idempotent by requestId', async () => {
  const controller = makeController({ sessions })
  const env = await createEnv({ controller, delegate: false, coreConfig: { mode: 'active', allowAllSessions: true } })
  const agent = makeAgent('caller', 'C:\\work')
  const args = { sessionId: 'target', text: 'hello', requestId: 'req-1' }
  const first = await env.tools.get('one_send').execute(args, { agent, signal: AbortSignal.timeout(5000) })
  const second = await env.tools.get('one_send').execute(args, { agent, signal: AbortSignal.timeout(5000) })
  assert.deepEqual(first, second)
  assert.equal(controller.calls.prompt.length, 1)
  await env.dispose()
})

test('observe records a tool send while a command still delivers', async () => {
  const controller = makeController({ sessions })
  const env = await createEnv({ controller, delegate: false, coreConfig: { mode: 'observe', allowAllSessions: true } })
  const agent = makeAgent('caller', 'C:\\work')
  const observed = await env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-observe' },
    { agent, signal: AbortSignal.timeout(5000) },
  )
  assert.equal(observed.status, 'observed')
  assert.equal(controller.calls.prompt.length, 0)
  const command = await env.commands.get('one').handler({ agent, rawInput: 'send target hello-from-command' })
  assert.equal(command.kind, 'success')
  assert.equal(controller.calls.prompt.length, 1)
  await env.dispose()
})

test('retryable sends retry and non-retryable sends stop after one attempt', async () => {
  let attempts = 0
  const controller = makeController({
    sessions,
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
  const env = await createEnv({
    controller,
    delegate: false,
    coreConfig: { mode: 'active', allowAllSessions: true, maxSendAttempts: 3, retryDelayMs: 0 },
  })
  const sent = await env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-retry' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(sent.status, 'sent')
  assert.equal(sent.attempts, 3)
  await env.dispose()
})

test('subagent targets are rejected', async () => {
  const controller = makeController({
    sessions: [...sessions, { sessionId: 'child', updatedAt: 3, running: false, blank: false, agentAvailable: false, origin: 'subagent', parentSessionId: 'caller' }],
  })
  const env = await createEnv({ controller, delegate: false, coreConfig: { mode: 'active', allowAllSessions: true } })
  await assert.rejects(
    env.tools.get('one_send').execute(
      { sessionId: 'child', text: 'hello' },
      { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
    ),
    error => error.code === 'one/subagent-target',
  )
  await env.dispose()
})

test('model selection falls back and persists the applied route', async () => {
  const env = await createEnv({ controller: makeController({ sessions }), delegate: false, coreConfig: { mode: 'active', allowAllSessions: true } })
  const result = await env.tools.get('one_model').execute(
    { sessionId: 'target', provider: 'p', model: 'm2' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.model, 'm1')
  assert.deepEqual(env.storageDomain.tables.get('sessions').get('target').model, { provider: 'p', model: 'm1' })
  await env.dispose()
})

test('task commands report a missing delegate row instead of failing silently', async () => {
  const env = await createEnv({ delegate: false })
  const result = await env.commands.get('one').handler({ agent: makeAgent('caller', 'C:\\work'), rawInput: 'tasks' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /delegation is not mounted/u)
  await env.dispose()
})

test('a profile without sessionController and storageDomain still loads and degrades', async () => {
  const host = makeCtx({})
  await apply(host.ctx, {})
  const result = await host.tools.get('one_sessions').execute({ all: true }, { signal: AbortSignal.timeout(5000) })
  assert.equal(result.degraded, true)
  assert.match(result.error, /sessionController is unavailable/u)
  await host.dispose()
})
