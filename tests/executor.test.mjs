import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeAgent, makeStorageDomain } from './harness.mjs'

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const call = (tool, args, agent = makeAgent('caller', 'C:\\work')) =>
  tool.execute(args, { agent, signal: AbortSignal.timeout(5_000) })

const session = (sessionId, cwd = 'C:\\work') => ({
  sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd,
})

test('assign with a cwd creates a worker session and dispatches the ticket text', async () => {
  const env = await createEnv({ config: { maxWorkers: 2 } })
  try {
    const work = env.tools.get('one_work')
    const created = await call(work, { action: 'create', title: 'Do the thing', goal: 'It is done' })
    await call(work, { action: 'assign', ticketId: created.ticketId, cwd: 'C:\\work' })
    await wait()
    assert.equal(env.controller.calls.create.length, 1)
    assert.equal(env.controller.calls.prompt.length, 1)
    const text = env.controller.calls.prompt[0].content[0].text
    assert.match(text, /\[DSH One ticket /u)
    assert.match(text, /Do the thing/u)
    assert.match(text, /one_work/u)
  } finally {
    await env.dispose()
  }
})

test('an assistant-created ticket carries the origin header in the worker prompt', async () => {
  const env = await createEnv({ sessions: [session('worker-1')], config: { maxWorkers: 2 } })
  try {
    await env.runtime.sessions.setAssistantSessionId('router')
    const work = env.tools.get('one_work')
    const assistant = makeAgent('router', 'C:\\work')
    const created = await call(work, { action: 'create', title: 'A', goal: 'B' }, assistant)
    await call(work, { action: 'assign', ticketId: created.ticketId, sessionId: 'worker-1' }, assistant)
    await wait()
    assert.match(env.controller.calls.prompt[0].content[0].text, /^\[来自助手「鲸宝」\]\n\n/u)
  } finally {
    await env.dispose()
  }
})

test('a turn ending without a report blocks the ticket', async () => {
  const env = await createEnv({ sessions: [session('worker-1')], config: { maxWorkers: 2 } })
  try {
    const work = env.tools.get('one_work')
    const created = await call(work, { action: 'create', title: 'A', goal: 'B' })
    await call(work, { action: 'assign', ticketId: created.ticketId, sessionId: 'worker-1' })
    await wait()
    env.emitSession('worker-1', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
    await wait()
    const view = env.runtime.engine.view(created.ticketId)
    assert.equal(view.stage, 'person/blocked')
    assert.equal(view.latestReport.summary, 'turn-ended-without-report')
  } finally {
    await env.dispose()
  }
})

test('a report before the turn end keeps the ticket out of the block path', async () => {
  const env = await createEnv({ sessions: [session('worker-1')], config: { maxWorkers: 2 } })
  try {
    const work = env.tools.get('one_work')
    const created = await call(work, { action: 'create', title: 'A', goal: 'B' })
    const assigned = await call(work, { action: 'assign', ticketId: created.ticketId, sessionId: 'worker-1' })
    await wait()
    const assignmentId = env.runtime.engine.get(created.ticketId).assignments[0].assignmentId
    await call(work, {
      action: 'report', ticketId: created.ticketId, assignmentId, sessionId: 'worker-1',
      reportKind: 'waiting', summary: 'waiting for input',
    }, makeAgent('worker-1', 'C:\\\\work'))
    env.emitSession('worker-1', { type: 'turn/end' })
    await wait()
    assert.equal(env.runtime.engine.view(created.ticketId).stage, 'idle')
  } finally {
    await env.dispose()
  }
})

test('worker slots cap concurrent launches and defer the rest', async () => {
  const env = await createEnv({
    sessions: [session('s1'), session('s2')],
    config: { maxWorkers: 1 },
  })
  try {
    const work = env.tools.get('one_work')
    const first = await call(work, { action: 'create', title: 'A', goal: 'A' })
    const second = await call(work, { action: 'create', title: 'B', goal: 'B' })
    await call(work, { action: 'assign', ticketId: first.ticketId, sessionId: 's1' })
    await call(work, { action: 'assign', ticketId: second.ticketId, sessionId: 's2' })
    await wait(60)
    assert.equal(env.controller.calls.prompt.length, 1)
    assert.ok(env.runtime.effects.pending().length >= 1)
  } finally {
    await env.dispose()
  }
})

test('a running assignment left by a restart is marked blocked', async () => {
  const seed = {
    tickets: [[
      'ticket-restart',
      {
        ticketId: 'ticket-restart', title: 'Old', goal: 'Old', status: 'open',
        assignments: [{ assignmentId: 'a1', sessionId: 's1', status: 'running', startedAt: 1 }],
        createdAt: 1, updatedAt: 1,
      },
    ]],
  }
  const env = await createEnv({ storageDomain: makeStorageDomain(seed) })
  try {
    const view = env.runtime.engine.view('ticket-restart')
    assert.equal(view.stage, 'person/blocked')
    assert.equal(view.latestReport.summary, 'host-restarted')
  } finally {
    await env.dispose()
  }
})

test('a message from the assistant is tagged, an ordinary one is not', async () => {
  const env = await createEnv({ sessions: [session('s1')], config: { maxWorkers: 2 } })
  try {
    await env.runtime.sessions.setAssistantSessionId('router')
    const work = env.tools.get('one_work')
    await call(work, { action: 'message', sessionId: 's1', text: 'hello' }, makeAgent('router', 'C:\\work'))
    await env.commands.get('one').handler({ agent: makeAgent('human', 'C:\\\\work'), rawInput: 'send s1 plain' })
    await wait(60)
    const texts = env.controller.calls.prompt.map(item => item.content[0].text)
    assert.ok(texts.includes('[来自助手「鲸宝」]\n\nhello'))
    assert.ok(texts.includes('plain'))
  } finally {
    await env.dispose()
  }
})
