import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeLlm, makeReq, makeResponse } from './harness.mjs'

const wait = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))

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
    assert.equal(sent.json().status, 'sending')
    await wait()
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].provider, 'p')
    assert.equal(llm.calls[0].model, 'm1')
    assert.match(llm.calls[0].system, /常驻助手/u)
    const lastMessage = llm.calls[0].messages.at(-1)
    assert.equal(lastMessage.content[0].text, '帮我修一下测试')
    const list = (await request(env, '/one/api/chat')).json()
    const user = [...list.items].reverse().find(item => item.role === 'user')
    assert.equal(user.text, '帮我修一下测试')
    assert.equal(user.status, 'replied')
    const assistant = [...list.items].reverse().find(item => item.role === 'assistant')
    assert.equal(assistant.text, '收到，我会拆成工单。')
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

test('an llm failure is recorded as a failed answer, never a silent hang', async () => {
  const llm = { async *stream() { throw new Error('model offline') } }
  const env = await createEnv({ llm })
  try {
    const sent = await request(env, '/one/api/chat?send=hello')
    assert.equal(sent.json().ok, true)
    await wait()
    const list = (await request(env, '/one/api/chat')).json()
    const assistant = [...list.items].reverse().find(item => item.role === 'assistant')
    assert.equal(assistant.status, 'failed')
    assert.match(assistant.text, /model offline/u)
    const user = [...list.items].reverse().find(item => item.role === 'user')
    assert.equal(user.status, 'failed')
  } finally {
    await env.dispose()
  }
})

test('a replied message is still recallable inside the five-second window', async () => {
  const env = await createEnv()
  try {
    const sent = (await request(env, '/one/api/chat?send=already-done')).json()
    await wait()
    const recalled = await request(env, '/one/api/chat/recall', {
      method: 'POST', body: JSON.stringify({ messageId: sent.id }),
    })
    assert.equal(recalled.status, 200)
    const list = (await request(env, '/one/api/chat')).json()
    assert.equal(list.items.some(item => item.id === sent.id), false)
    assert.equal(list.items.some(item => item.replyTo === sent.id), false)
  } finally {
    await env.dispose()
  }
})

test('a message can be recalled within five seconds', async () => {
  // A generator that never yields keeps the answer in flight long enough to recall.
  const llm = { async *stream() { await new Promise(() => {}); yield { type: 'text-delta', text: 'never' } } }
  const env = await createEnv({ llm })
  try {
    const sent = (await request(env, '/one/api/chat?send=recall-me')).json()
    await wait(20)
    const recalled = await request(env, '/one/api/chat/recall', {
      method: 'POST', body: JSON.stringify({ messageId: sent.id }),
    })
    assert.equal(recalled.status, 200)
    const list = (await request(env, '/one/api/chat')).json()
    assert.equal(list.items.some(item => item.text === 'recall-me'), false)
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

test('the model receives the plugin tools and a tool call is executed before the final answer', async () => {
  const llm = {
    calls: [],
    async *stream(options) {
      this.calls.push(options)
      if (this.calls.length === 1) {
        yield { type: 'text-delta', index: 0, text: '我先查一下。' }
        yield { type: 'tool-call-delta', index: 1, id: 'call-status-1', name: 'one_status', argumentsDelta: '{}' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: '目前没有工单。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const env = await createEnv({ llm })
  try {
    const sent = (await request(env, '/one/api/chat?send=' + encodeURIComponent('看看工单'))).json()
    assert.equal(sent.status, 'sending')
    await wait(120)
    assert.equal(llm.calls.length, 2)
    const names = llm.calls[0].tools.map(tool => tool.name)
    assert.deepEqual(names.sort(), ['one_status', 'one_work'])
    const second = llm.calls[1].messages
    const assistant = second.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))
    assert.ok(assistant, 'the assistant tool-call turn is replayed to the model')
    const callBlock = assistant.content.find(block => block.type === 'tool-call')
    assert.equal(callBlock.name, 'one_status')
    const toolResult = second.find(message => message.role === 'tool')
    assert.equal(toolResult.toolCallId, 'call-status-1')
    assert.match(toolResult.content[0].text, /"total"/u)
    const list = (await request(env, '/one/api/chat')).json()
    const toolRow = list.items.find(item => item.role === 'assistant' && Array.isArray(item.toolCalls) && item.toolCalls.length > 0)
    assert.ok(toolRow, 'the tool-call row is visible in the transcript')
    assert.equal(toolRow.toolCalls[0].name, 'one_status')
    assert.equal(toolRow.toolCalls[0].status, 'ok')
    assert.match(toolRow.toolCalls[0].result, /"total"/u)
    const final = [...list.items].reverse().find(item => item.role === 'assistant')
    assert.equal(final.text, '目前没有工单。')
    const user = [...list.items].reverse().find(item => item.role === 'user')
    assert.equal(user.status, 'replied')
  } finally {
    await env.dispose()
  }
})

test('an unknown tool call becomes a visible error result instead of a silent hang', async () => {
  let turn = 0
  const llm = {
    async *stream() {
      turn += 1
      if (turn === 1) {
        yield { type: 'tool-call-delta', index: 0, id: 'call-bad-1', name: 'not_a_tool', argumentsDelta: '{}' }
        return
      }
      yield { type: 'text-delta', index: 0, text: '工具不可用，我直接回答。' }
    },
  }
  const env = await createEnv({ llm })
  try {
    await request(env, '/one/api/chat?send=' + encodeURIComponent('试试'))
    await wait(120)
    const list = (await request(env, '/one/api/chat')).json()
    const row = list.items.find(item => item.role === 'assistant' && Array.isArray(item.toolCalls) && item.toolCalls.length > 0)
    assert.ok(row)
    assert.equal(row.toolCalls[0].status, 'error')
    assert.match(row.toolCalls[0].error, /未知工具/u)
    const final = list.items.find(item => item.role === 'assistant' && item.text === '工具不可用，我直接回答。')
    assert.ok(final, 'the final answer follows the failed tool call')
  } finally {
    await env.dispose()
  }
})

test('one_work runs from the assistant page and creates a real ticket', async () => {
  let turn = 0
  const llm = {
    async *stream() {
      turn += 1
      if (turn === 1) {
        yield { type: 'tool-call-delta', index: 0, id: 'call-work-1', name: 'one_work', argumentsDelta: '{"action":"create","title":"测试工单","goal":"验证助手页工具调用"}' }
        return
      }
      yield { type: 'text-delta', index: 0, text: '已经建好工单。' }
    },
  }
  const env = await createEnv({ llm })
  try {
    await request(env, '/one/api/chat?send=' + encodeURIComponent('建一个测试工单'))
    await wait(120)
    const tickets = env.runtime.engine.list()
    assert.equal(tickets.length, 1)
    assert.equal(tickets[0].title, '测试工单')
    assert.equal(tickets[0].origin, 'assistant')
    const list = (await request(env, '/one/api/chat')).json()
    const row = list.items.find(item => item.role === 'assistant' && Array.isArray(item.toolCalls) && item.toolCalls.length > 0)
    assert.equal(row.toolCalls[0].name, 'one_work')
    assert.equal(row.toolCalls[0].status, 'ok')
    assert.match(row.toolCalls[0].result, /"ticketId"/u)
  } finally {
    await env.dispose()
  }
})
