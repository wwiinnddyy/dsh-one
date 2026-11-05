import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeAgent, makeController } from './harness.mjs'

const LABEL = '[来自助手「鲸宝」]'

const sessions = [
  { sessionId: 'assistant', updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
  { sessionId: 'caller', updatedAt: 2, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
]

async function makeEnv(options = {}) {
  const controller = options.controller ?? makeController({ sessions })
  const env = await createEnv({
    controller,
    delegate: false,
    coreConfig: { mode: 'observe', allowAllSessions: true, ...(options.coreConfig ?? {}) },
  })
  if (options.assistant !== false) await env.settings.setAssistantSessionId('assistant')
  return { env, controller }
}

function assistantCall(env, args) {
  return env.tools.get('one_session_create').execute(args, {
    agent: makeAgent('assistant', 'C:\\work'),
    signal: AbortSignal.timeout(5000),
  })
}

test('the assistant creates a session, trusts it, and tags the first message', async () => {
  const { env, controller } = await makeEnv()
  const result = await assistantCall(env, {
    cwd: 'C:\\work',
    message: '今天要做什么？',
    title: '晨间问候',
    idempotencyKey: 'morning-1',
  })

  assert.equal(result.created, true)
  assert.equal(result.messageStatus, 'sent')
  assert.equal(result.observed, false)
  assert.equal(result.cwd, 'C:\\work')
  assert.equal(result.title, '晨间问候')
  assert.ok(result.sessionId.startsWith('session-'))

  // create -> trust -> send, in that order.
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.create[0].cwd, 'C:\\work')
  assert.equal(controller.calls.create[0].sessionId, result.sessionId)

  const row = env.storageDomain.tables.get('sessions').get(result.sessionId)
  assert.equal(row.trusted, true)
  assert.equal(row.cwd, 'C:\\work')
  assert.equal(row.title, '晨间问候')

  assert.equal(controller.calls.prompt.length, 1)
  assert.equal(controller.calls.prompt[0].content[0].text, `${LABEL}\n\n今天要做什么？`)

  const audit = env.storageDomain.tables.get('audit').records
  assert.ok([...audit.values()].some(entry => entry.action === 'session_created'))
  await env.dispose()
})

test('reusing the idempotency key creates and sends exactly once', async () => {
  const { env, controller } = await makeEnv()
  const args = { cwd: 'C:\\work', message: 'hi', idempotencyKey: 'same-key' }
  const first = await assistantCall(env, args)
  const second = await assistantCall(env, args)

  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.created, false)
  assert.equal(second.messageStatus, 'sent')
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.prompt.length, 1)
  await env.dispose()
})

test('a host that picks a different session id stays idempotent', async () => {
  const controller = makeController({ sessions })
  // A host is free to ignore the requested id; the outbox stays the authority.
  controller.create = async request => {
    controller.calls.create.push(request)
    const sessionId = 'host-chosen'
    controller.state.sessions.push({
      sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      agentAvailable: true,
      cwd: request.cwd,
    })
    return { sessionId }
  }
  const { env } = await makeEnv({ controller })
  const args = { cwd: 'C:\\work', message: 'hi', idempotencyKey: 'host-key' }
  const first = await assistantCall(env, args)
  const second = await assistantCall(env, args)

  assert.equal(first.sessionId, 'host-chosen')
  assert.equal(second.sessionId, 'host-chosen')
  assert.equal(second.created, false)
  assert.equal(controller.calls.create.length, 1)
  await env.dispose()
})

test('only the assistant session may create sessions', async () => {
  const { env } = await makeEnv()
  await assert.rejects(
    env.tools.get('one_session_create').execute(
      { cwd: 'C:\\work', message: 'hi' },
      { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) },
    ),
    error => error.code === 'one/assistant-only',
  )
  await env.dispose()
})

test('a profile without an assistant session refuses instead of guessing', async () => {
  const { env } = await makeEnv({ assistant: false })
  await assert.rejects(
    assistantCall(env, { cwd: 'C:\\work', message: 'hi' }),
    error => error.code === 'one/assistant-unavailable',
  )
  await env.dispose()
})

test('allowSessionCreation false blocks the tool', async () => {
  const { env, controller } = await makeEnv({ coreConfig: { allowSessionCreation: false } })
  await assert.rejects(
    assistantCall(env, { cwd: 'C:\\work', message: 'hi' }),
    error => error.code === 'one/session-creation-disabled',
  )
  assert.equal(controller.calls.create.length, 0)
  await env.dispose()
})

test('a workspace outside the allowed roots is refused before creating anything', async () => {
  const { env, controller } = await makeEnv({
    coreConfig: { allowedWorkspaceRoots: ['C:\\allowed'] },
  })
  await assert.rejects(
    assistantCall(env, { cwd: 'C:\\elsewhere', message: 'hi' }),
    error => error.code === 'one/workspace-forbidden',
  )
  assert.equal(controller.calls.create.length, 0)
  assert.equal(controller.calls.prompt.length, 0)
  await env.dispose()
})

test('a failed first message still returns the session it created', async () => {
  const controller = makeController({
    sessions,
    promptImpl() {
      const error = new Error('session is gone')
      error.code = 'session/not-found'
      throw error
    },
  })
  const { env } = await makeEnv({ controller })
  const result = await assistantCall(env, { cwd: 'C:\\work', message: 'hi', idempotencyKey: 'failed-send' })

  assert.equal(result.created, true)
  assert.equal(result.messageStatus, 'failed')
  assert.equal(typeof result.error, 'string')
  assert.equal(env.storageDomain.tables.get('sessions').get(result.sessionId).trusted, true)
  await env.dispose()
})

test('the assistant tag is applied to the delivered text, not the stored text', async () => {
  const { env } = await makeEnv()
  const result = await assistantCall(env, { cwd: 'C:\\work', message: 'raw body', idempotencyKey: 'raw-key' })
  const outbox = env.storageDomain.tables.get('outbox').get(result.requestId)
  assert.equal(outbox.text, 'raw body')
  assert.equal(outbox.source, 'assistant')
  assert.equal(outbox.deliveredText, `${LABEL}\n\nraw body`)
  await env.dispose()
})
