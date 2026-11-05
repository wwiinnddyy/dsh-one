import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnv, makeConnection, makeReq, makeResponse } from './harness.mjs'

async function request(env, path, options = {}) {
  const handler = env.webServer.routes.get(path)
  assert.ok(handler, `route ${path} is registered`)
  const res = makeResponse()
  await handler(makeReq({ url: path, ...options }), res)
  return res
}

test('overview reports the assistant and ticket counts', async () => {
  const env = await createEnv()
  try {
    await env.runtime.engine.createTicket({ title: 'A', goal: 'B' })
    const res = await request(env, '/one/api/overview')
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.displayName, '鲸宝')
    assert.equal(body.tickets.total, 1)
    assert.equal(body.tickets.byStage['working/queued'], 1)
    assert.equal(body.backend, 'domain')
  } finally {
    await env.dispose()
  }
})

test('settings can be read and updated through the panel route', async () => {
  const env = await createEnv()
  try {
    const before = (await request(env, '/one/api/settings')).json()
    assert.equal(before.displayName, '鲸宝')
    const updated = await request(env, '/one/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ displayName: '小七' }),
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.json().displayName, '小七')
    assert.equal(env.runtime.assistantName(), '小七')
  } finally {
    await env.dispose()
  }
})

test('the assistant route creates a real session and reuses it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-one-http-'))
  const env = await createEnv({ config: { assistantHomeRoot: root } })
  try {
    const created = (await request(env, '/one/api/assistant', { method: 'POST' })).json()
    assert.equal(typeof created.sessionId, 'string')
    assert.equal(created.created, true)
    const again = (await request(env, '/one/api/assistant', { method: 'POST' })).json()
    assert.equal(again.created, false)
    assert.equal(again.sessionId, created.sessionId)
    const read = (await request(env, '/one/api/assistant')).json()
    assert.equal(read.sessionId, created.sessionId)
  } finally {
    await env.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the panel routes stay behind the connection fence', async () => {
  const env = await createEnv({ connection: makeConnection(401) })
  try {
    const res = await request(env, '/one/api/overview')
    assert.equal(res.status, 401)
    assert.equal(res.json().error, 'unauthorized')
  } finally {
    await env.dispose()
  }
})

test('tickets can be stopped through the panel route', async () => {
  const env = await createEnv()
  try {
    const ticket = await env.runtime.engine.createTicket({ title: 'A', goal: 'B' })
    const res = await request(env, '/one/api/tickets/stop', {
      method: 'POST',
      body: JSON.stringify({ ticketId: ticket.ticketId }),
    })
    assert.equal(res.status, 200)
    assert.equal(env.runtime.engine.view(ticket.ticketId).status, 'ended')
  } finally {
    await env.dispose()
  }
})
