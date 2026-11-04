import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeReq } from './harness.mjs'

/**
 * A session that exists but lives in an unrelated directory.
 *
 * This is the shape of every assistant Session created before the home
 * directory existed: it has a `cwd` (often the profile directory), so a naive
 * "recorded cwd equals host cwd" check accepts it and reopens a stale blank
 * conversation — which is indistinguishable from the plugin not working.
 */
const staleSessions = [
  { sessionId: 'stale', updatedAt: 1, running: false, blank: true, agentAvailable: true, cwd: 'C:\\work' },
]

test('a session outside the assistant home is rebuilt instead of reopened', async () => {
  const env = await createEnv({ delegate: false, sessions: staleSessions })
  try {
    // Point the setting at the stale Session and record the same cwd, which is
    // exactly what an install from before the home directory looks like.
    const settings = env.services.get('oneSettings')
    await settings.setAssistantSessionId('stale', 'system')
    await env.services.get('oneCore').resolveAssistantHome().then(async (home) => {
      // Seed the pre-home record with the wrong cwd on purpose.
      await settings.setAssistantHome(home, 'system')
    })

    const response = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(response.status, 200)
    // The stale Session must not be handed back.
    assert.notEqual(response.json().sessionId, 'stale')
    assert.equal(response.json().created, true)
  } finally {
    await env.dispose()
  }
})

test('a healthy assistant session is reused across repeated opens', async () => {
  const env = await createEnv({ delegate: false, sessions: [] })
  try {
    const first = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(first.status, 200)
    const sessionId = first.json().sessionId

    const second = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(second.json().sessionId, sessionId)
    assert.equal(second.json().created, false)
  } finally {
    await env.dispose()
  }
})

test('the assistant route reports the resolved home on both paths', async () => {
  const env = await createEnv({ delegate: false, sessions: [] })
  try {
    const first = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(typeof first.json().home, 'string')
    assert.match(first.json().home, /super-mind/u)

    const second = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(second.json().home, first.json().home)
  } finally {
    await env.dispose()
  }
})
