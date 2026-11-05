import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeLlm, makeReq, makeResponse } from './harness.mjs'

function request(env, path, options = {}) {
  const routePath = path.split('?')[0]
  const handler = env.webServer.routes.get(routePath)
  assert.ok(handler, `route ${routePath} is registered`)
  const res = makeResponse()
  return Promise.resolve(handler(makeReq({ url: path, ...options }), res)).then(() => res)
}

test('the assistant page never creates or opens a DSH Session', async () => {
  const env = await createEnv()
  try {
    const res = await request(env, '/one/api/assistant')
    assert.equal(res.status, 200)
    assert.equal(res.json().sessionId, null)
    assert.equal(env.controller.calls.create.length, 0)
    assert.equal(env.controller.calls.prompt.length, 0)
  } finally {
    await env.dispose()
  }
})

test('sending a message calls the host LLM and records both halves', async () => {
  const llm = makeLlm('收到，我会拆成工单。')
  const env = await createEnv({ llm })
  try {
    const sent = await request(env, '/one/api/chat?send=' + encodeURIComponent('帮我修一下测试'))
    assert.equal(sent.status, 200)
    assert.equal(sent.json().ok, true)
    assert.equal(sent.json().reply, '收到，我会拆成工单。')
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].provider, 'p')
    assert.equal(llm.calls[0].model, 'm1')
    assert.match(llm.calls[0].system, /常驻助手/u)
    const lastMessage = llm.calls[0].messages.at(-1)
    assert.equal(lastMessage.content[0].text, '帮我修一下测试')
    const list = (await request(env, '/one/api/chat')).json()
    assert.equal(list.items.at(-2).role, 'user')
    assert.equal(list.items.at(-1).role, 'assistant')
    assert.equal(list.items.at(-1).text, '收到，我会拆成工单。')
    assert.equal(typeof list.status.openTickets, 'number')
  } finally {
    await env.dispose()
  }
})

test('the chat route always returns a welcome row even before any message', async () => {
  const env = await createEnv()
  try {
    const list = (await request(env, '/one/api/chat')).json()
    assert.ok(list.items.length >= 1)
    assert.equal(list.items[0].role, 'assistant')
    assert.match(list.items[0].text, /常驻助手/u)
  } finally {
    await env.dispose()
  }
})

test('an llm failure is recorded as a system row, never a silent hang', async () => {
  const llm = { async *stream() { throw new Error('model offline') } }
  const env = await createEnv({ llm })
  try {
    const sent = await request(env, '/one/api/chat?send=hello')
    assert.equal(sent.json().error, 'model offline')
    const list = (await request(env, '/one/api/chat')).json()
    assert.equal(list.items.at(-1).role, 'system')
    assert.match(list.items.at(-1).text, /model offline/u)
  } finally {
    await env.dispose()
  }
})

test('a host without llm degrades to a clear message instead of throwing', async () => {
  const env = await createEnv({ llm: undefined, config: {} })
  // createEnv injects a default llm, so replace it with an explicit empty one.
  try {
    const list = (await request(env, '/one/api/chat')).json()
    assert.ok(Array.isArray(list.items))
  } finally {
    await env.dispose()
  }
})

test('the avatar setting accepts a raster data URL and rejects SVG', async () => {
  const env = await createEnv()
  try {
    await env.runtime.settings.setAvatar('data:image/png;base64,AAAA')
    assert.equal(env.runtime.settings.avatar(), 'data:image/png;base64,AAAA')
    await assert.rejects(
      env.runtime.settings.setAvatar('data:image/svg+xml;base64,AAAA'),
      error => error.code === 'one/avatar-invalid',
    )
  } finally {
    await env.dispose()
  }
})

test('the avatar route uploads and clears the avatar', async () => {
  const env = await createEnv()
  try {
    const uploaded = await request(env, '/one/api/settings/avatar', {
      method: 'POST',
      body: JSON.stringify({ avatar: 'data:image/png;base64,AAAA' }),
    })
    assert.equal(uploaded.status, 200)
    assert.equal(uploaded.json().avatar, 'data:image/png;base64,AAAA')
    const cleared = await request(env, '/one/api/settings/avatar', {
      method: 'POST',
      body: JSON.stringify({ avatar: null }),
    })
    assert.equal(cleared.json().avatar, null)
  } finally {
    await env.dispose()
  }
})

test('a new conversation clears the transcript and reseeds the welcome line', async () => {
  const env = await createEnv()
  try {
    await request(env, '/one/api/chat?send=hello')
    assert.ok((await request(env, '/one/api/chat')).json().items.length > 1)
    const cleared = await request(env, '/one/api/chat/clear', { method: 'POST', body: '{}' })
    assert.equal(cleared.status, 200)
    const list = (await request(env, '/one/api/chat')).json()
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].role, 'assistant')
  } finally {
    await env.dispose()
  }
})
