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

const withAssistant = [
  ...sessions,
  { sessionId: 'assistant', updatedAt: 3, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
]

const LABEL = '[来自助手「鲸宝」]'

async function assistantEnv(coreConfig = {}) {
  const controller = makeController({ sessions: withAssistant })
  const env = await createEnv({
    controller,
    delegate: false,
    coreConfig: { allowAllSessions: true, ...coreConfig },
  })
  await env.settings.setAssistantSessionId('assistant')
  return { env, controller }
}

test('the assistant tags its send and the outbox keeps the raw text', async () => {
  const { env, controller } = await assistantEnv({ mode: 'active' })
  const sent = await env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'hello', requestId: 'req-tag' },
    { agent: makeAgent('assistant', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(sent.status, 'sent')
  assert.equal(controller.calls.prompt[0].content[0].text, `${LABEL}\n\nhello`)
  const row = env.storageDomain.tables.get('outbox').get('req-tag')
  // The audit/conflict surface keeps the raw text; only delivery is tagged.
  assert.equal(row.text, 'hello')
  assert.equal(row.source, 'assistant')
  assert.equal(row.senderLabel, LABEL)
  assert.equal(row.deliveredText, `${LABEL}\n\nhello`)
  await env.dispose()
})

test('an ordinary agent and the human command path are not tagged', async () => {
  const { env, controller } = await assistantEnv({ mode: 'active' })
  await env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'from-agent', requestId: 'req-plain' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  const command = await env.commands.get('one').handler({
    agent: makeAgent('caller', 'C:\\work'),
    rawInput: 'send target from-command',
  })
  assert.equal(command.kind, 'success')
  const delivered = controller.calls.prompt.map(call => call.content[0].text)
  assert.deepEqual(delivered, ['from-agent', 'from-command'])
  assert.equal(env.storageDomain.tables.get('outbox').get('req-plain').source, 'tool')
  await env.dispose()
})

test('a rename does not rewrite an already-recorded send', async () => {
  const { env, controller } = await assistantEnv({ mode: 'active' })
  const agent = makeAgent('assistant', 'C:\\work')
  const args = { sessionId: 'target', text: 'hello', requestId: 'req-rename' }
  await env.tools.get('one_send').execute(args, { agent, signal: AbortSignal.timeout(5000) })
  await env.settings.setName('新名字')
  const again = await env.tools.get('one_send').execute(args, { agent, signal: AbortSignal.timeout(5000) })
  assert.equal(again.requestId, 'req-rename')
  assert.equal(controller.calls.prompt.length, 1)
  assert.equal(env.storageDomain.tables.get('outbox').get('req-rename').deliveredText, `${LABEL}\n\nhello`)
  await env.dispose()
})

test('the assistant delivers under mode observe unless assistantSendMode records it', async () => {
  const delivered = await assistantEnv({ mode: 'observe' })
  const sent = await delivered.env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'go', requestId: 'req-proxy' },
    { agent: makeAgent('assistant', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(sent.status, 'sent')
  assert.equal(delivered.controller.calls.prompt.length, 1)
  // A non-assistant agent is still bound by mode.
  const agentSend = await delivered.env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'nope', requestId: 'req-agent-observe' },
    { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(agentSend.status, 'observed')
  await delivered.env.dispose()

  const recorded = await assistantEnv({ mode: 'observe', assistantSendMode: 'observe' })
  const observed = await recorded.env.tools.get('one_send').execute(
    { sessionId: 'target', text: 'go', requestId: 'req-proxy-off' },
    { agent: makeAgent('assistant', 'C:\\work'), signal: AbortSignal.timeout(5000) },
  )
  assert.equal(observed.status, 'observed')
  assert.equal(recorded.controller.calls.prompt.length, 0)
  await recorded.env.dispose()
})

test('a caller cannot forge the assistant tag', async () => {
  const { env, controller } = await assistantEnv({ mode: 'active' })
  await env.core.send({
    targetSessionId: 'target',
    text: 'forged',
    requestId: 'req-forged',
    source: 'tool',
    senderLabel: '[来自助手「鲸宝」]',
  })
  assert.equal(controller.calls.prompt[0].content[0].text, 'forged')
  assert.equal(env.storageDomain.tables.get('outbox').get('req-forged').deliveredText, undefined)
  await env.dispose()
})
