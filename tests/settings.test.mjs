import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeAgent, makeReq } from './harness.mjs'

const sessions = [
  { sessionId: 'caller', updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' },
]

function commandInvocation(rawInput, agent = makeAgent('caller', 'C:\\work')) {
  return { agent, rawInput }
}

test('the name defaults to the row default and is read by /one name', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const line = await env.commands.get('one').handler(commandInvocation('name'))
    assert.equal(line.kind, 'success')
    assert.match(line.text, /^鲸宝/u)
    assert.match(line.text, /default/u)
    assert.equal(env.services.get('oneSettings').displayName(), '鲸宝')
    assert.equal(env.services.get('oneSettings').hasOverride(), false)
  } finally {
    await env.dispose()
  }
})

test('the row config declares the default name', async () => {
  const env = await createEnv({ delegate: false, sessions, coreConfig: { displayName: '小助手' } })
  try {
    assert.equal(env.services.get('oneSettings').displayName(), '小助手')
    const overview = await env.webServer.request('/one/api/overview', makeReq())
    assert.equal(overview.json().displayName, '小助手')
    assert.equal(overview.json().defaultDisplayName, '小助手')
  } finally {
    await env.dispose()
  }
})

test('/one name sets, persists, reports, and resets the name', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const command = env.commands.get('one')
    const set = await command.handler(commandInvocation('name 鲸宝二号'))
    assert.equal(set.kind, 'success')
    assert.match(set.text, /鲸宝二号/u)
    assert.equal(env.services.get('oneSettings').displayName(), '鲸宝二号')
    assert.equal(env.services.get('oneSettings').hasOverride(), true)

    const shown = await command.handler(commandInvocation('name'))
    assert.match(shown.text, /鲸宝二号.*custom/u)
    assert.match(shown.text, /reset target: 鲸宝/u)

    const stored = env.services.get('oneSettings').list()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].namespace, 'one')
    assert.equal(stored[0].key, 'displayName')
    assert.equal(stored[0].value, '鲸宝二号')
    assert.equal(stored[0].updatedBy, 'human')

    const reset = await command.handler(commandInvocation('name reset'))
    assert.equal(reset.kind, 'success')
    assert.match(reset.text, /鲸宝/u)
    assert.equal(env.services.get('oneSettings').hasOverride(), false)
    assert.equal(env.services.get('oneSettings').list().length, 0)
  } finally {
    await env.dispose()
  }
})

test('an invalid name is rejected without changing the stored value', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const command = env.commands.get('one')
    await command.handler(commandInvocation('name good'))
    const tooLong = await command.handler(commandInvocation(`name ${'a'.repeat(25)}`))
    assert.equal(tooLong.kind, 'error')
    assert.match(tooLong.text, /one\/name-too-long/u)
    assert.equal(env.services.get('oneSettings').displayName(), 'good')
  } finally {
    await env.dispose()
  }
})

test('the settings route reads, writes, and resets the name', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const initial = await env.webServer.request('/one/api/settings', makeReq())
    assert.equal(initial.status, 200)
    assert.equal(initial.json().displayName, '鲸宝')
    assert.equal(initial.json().overridden, false)

    const written = await env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '  鲸宝·三号  ' }),
    }))
    assert.equal(written.status, 200)
    assert.equal(written.json().displayName, '鲸宝·三号')
    assert.equal(written.json().overridden, true)

    const overview = await env.webServer.request('/one/api/overview', makeReq())
    assert.equal(overview.json().displayName, '鲸宝·三号')

    const cleared = await env.webServer.request('/one/api/settings', makeReq({ method: 'DELETE' }))
    assert.equal(cleared.status, 200)
    assert.equal(cleared.json().displayName, '鲸宝')
    assert.equal(cleared.json().overridden, false)
  } finally {
    await env.dispose()
  }
})

test('the settings route rejects a bad body and an unsupported method', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const missing = await env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT',
      body: JSON.stringify({ nope: 1 }),
    }))
    assert.equal(missing.status, 400)
    assert.match(missing.json().error, /displayName/u)

    const broken = await env.webServer.request('/one/api/settings', makeReq({ method: 'PUT', body: '{' }))
    assert.equal(broken.status, 400)

    const empty = await env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT',
      body: JSON.stringify({ displayName: '   ' }),
    }))
    assert.equal(empty.status, 400)
    assert.equal(empty.json().code, 'one/name-empty')

    const method = await env.webServer.request('/one/api/settings', makeReq({ method: 'PATCH' }))
    assert.equal(method.status, 405)
    assert.equal(env.services.get('oneSettings').hasOverride(), false)
  } finally {
    await env.dispose()
  }
})

test('the settings route stays behind the authentication fence', async () => {
  const { makeConnection } = await import('./harness.mjs')
  const env = await createEnv({ delegate: false, sessions, connection: makeConnection(401) })
  try {
    const denied = await env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT',
      body: JSON.stringify({ displayName: 'hijack' }),
    }))
    assert.equal(denied.status, 401)
    assert.equal(env.services.get('oneSettings').hasOverride(), false)
  } finally {
    await env.dispose()
  }
})

test('a subscriber observes a name change once per accepted write', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const settings = env.services.get('oneSettings')
    let calls = 0
    const off = settings.subscribe(() => { calls += 1 })
    await settings.setName('one')
    await settings.setName('two')
    await settings.resetName()
    off()
    await settings.setName('three')
    assert.equal(calls, 3)
  } finally {
    await env.dispose()
  }
})

test('the settings row key is path-safe for a per-record backend', async () => {
  const { oneDomainSpec } = await import('../lib/store/spec.js')
  assert.ok(oneDomainSpec.tables.settings, 'the domain declares a settings table')

  const env = await createEnv({ delegate: false, sessions })
  try {
    await env.services.get('oneSettings').setName('鲸宝二号')
    const keys = [...env.storageDomain.tables.get('settings').records.keys()]
    assert.equal(keys.length, 1)
    // A per-record backend writes each key as a path segment.
    assert.match(keys[0], /^[a-zA-Z0-9_-]+$/u)
  } finally {
    await env.dispose()
  }
})

test('adding the settings table does not require a domain version bump', async () => {
  const { oneDomainSpec } = await import('../lib/store/spec.js')
  // The single-document backend rejects a stamp it does not expect, so an
  // existing store must keep opening after a table is added.
  assert.equal(oneDomainSpec.version, 2)
  assert.deepEqual([...oneDomainSpec.compatibleVersions], [1])
  for (const compatible of oneDomainSpec.compatibleVersions) {
    assert.ok(compatible < oneDomainSpec.version)
  }
})

test('the assistant route reports no session before one is created', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const read = await env.webServer.request('/one/api/assistant', makeReq())
    assert.equal(read.status, 200)
    assert.equal(read.json().sessionId, null)
    assert.equal(read.json().displayName, '鲸宝')
  } finally {
    await env.dispose()
  }
})

test('the assistant route creates one real session and reuses it', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const first = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(first.status, 200)
    const sessionId = first.json().sessionId
    assert.equal(typeof sessionId, 'string')
    assert.ok(sessionId.length > 0)
    assert.equal(first.json().created, true)

    // The id is durable, so the entry reopens the same conversation.
    assert.equal(env.services.get('oneSettings').assistantSessionId(), sessionId)

    // A second press must not spawn a parallel assistant conversation.
    const second = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(second.status, 200)
    assert.equal(second.json().sessionId, sessionId)
    assert.equal(second.json().created, false)

    const read = await env.webServer.request('/one/api/assistant', makeReq())
    assert.equal(read.json().sessionId, sessionId)
  } finally {
    await env.dispose()
  }
})

test('a stored assistant session the host dropped is replaced, not returned', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    // Seed an id that no listing contains, as an archive or workspace reset would.
    await env.services.get('oneSettings').setAssistantSessionId('gone-forever', 'system')
    const response = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(response.status, 200)
    assert.notEqual(response.json().sessionId, 'gone-forever')
    assert.equal(response.json().created, true)
  } finally {
    await env.dispose()
  }
})

test('the assistant session can be cleared for a fresh conversation', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const created = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.ok(created.json().sessionId)

    const cleared = await env.webServer.request('/one/api/assistant', makeReq({ method: 'DELETE' }))
    assert.equal(cleared.status, 200)
    assert.equal(cleared.json().sessionId, null)
    assert.equal(env.services.get('oneSettings').assistantSessionId(), undefined)

    const method = await env.webServer.request('/one/api/assistant', makeReq({ method: 'PATCH' }))
    assert.equal(method.status, 405)
  } finally {
    await env.dispose()
  }
})

test('the assistant route stays behind the authentication fence', async () => {
  const { makeConnection } = await import('./harness.mjs')
  const env = await createEnv({ delegate: false, sessions, connection: makeConnection(401) })
  try {
    const denied = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    assert.equal(denied.status, 401)
    // A rejected caller must not have created a session as a side effect.
    assert.equal(env.services.get('oneSettings').assistantSessionId(), undefined)
  } finally {
    await env.dispose()
  }
})

test('the settings payload reports the assistant session for the settings tab', async () => {
  const env = await createEnv({ delegate: false, sessions })
  try {
    const before = await env.webServer.request('/one/api/settings', makeReq())
    assert.equal(before.json().sessionId, null)

    await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    const after = await env.webServer.request('/one/api/settings', makeReq())
    assert.equal(typeof after.json().sessionId, 'string')
  } finally {
    await env.dispose()
  }
})

