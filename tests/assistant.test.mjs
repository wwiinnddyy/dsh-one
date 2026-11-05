import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnv, makeAgent } from './harness.mjs'

const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

function makeSystemPrompt() {
  const sections = []
  return {
    sections,
    section(definition) {
      sections.push(definition)
      return () => {}
    },
  }
}

async function makeAssistantEnv(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-one-assistant-'))
  const systemPrompt = makeSystemPrompt()
  const env = await createEnv({
    ...options,
    systemPrompt,
    config: { assistantHomeRoot: root, ...(options.config ?? {}) },
  })
  return {
    env,
    systemPrompt,
    root,
    async cleanup() {
      await env.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('ensureAssistant creates one home and one session, then reuses it', async () => {
  const ctx = await makeAssistantEnv()
  try {
    const first = await ctx.env.runtime.ensureAssistant()
    assert.equal(first.created, true)
    assert.match(first.home, /super-mind/u)
    const second = await ctx.env.runtime.ensureAssistant()
    assert.equal(second.created, false)
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(ctx.env.runtime.sessions.assistantSessionId(), first.sessionId)
  } finally {
    await ctx.cleanup()
  }
})

test('the identity section only applies to the assistant session', async () => {
  const ctx = await makeAssistantEnv()
  try {
    const assistant = await ctx.env.runtime.ensureAssistant()
    assert.equal(ctx.systemPrompt.sections.length, 1)
    const section = ctx.systemPrompt.sections[0]
    assert.equal(section.name, 'dsh-one-assistant-identity')
    const own = section.text({ agent: { id: assistant.sessionId } })
    assert.match(own, /你的名字是「鲸宝」/u)
    assert.match(own, /one_work/u)
    assert.equal(section.text({ agent: { id: 'someone-else' } }), '')
    assert.equal(section.text({}), '')
  } finally {
    await ctx.cleanup()
  }
})

test('/one name sets, reports and resets the assistant name', async () => {
  const ctx = await makeAssistantEnv()
  try {
    const command = ctx.env.commands.get('one')
    const agent = makeAgent('human', ctx.root)
    const set = await command.handler({ agent, rawInput: 'name 小七' })
    assert.equal(set.kind, 'success')
    assert.match(set.text, /小七/u)
    assert.equal(ctx.env.runtime.assistantName(), '小七')
    const shown = await command.handler({ agent, rawInput: 'name' })
    assert.match(shown.text, /小七/u)
    const reset = await command.handler({ agent, rawInput: 'name reset' })
    assert.equal(reset.kind, 'success')
    assert.equal(ctx.env.runtime.assistantName(), '鲸宝')
  } finally {
    await ctx.cleanup()
  }
})

test('/one status reports tickets and workers', async () => {
  const ctx = await makeAssistantEnv()
  try {
    await ctx.env.runtime.engine.createTicket({ title: 'A', goal: 'B' })
    const result = await ctx.env.commands.get('one').handler({
      agent: makeAgent('human', ctx.root),
      rawInput: 'status',
    })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /工单 1/u)
    assert.match(result.text, /working\/queued=1/u)
  } finally {
    await ctx.cleanup()
  }
})

test('/one send stays untagged because a human typed it', async () => {
  const ctx = await makeAssistantEnv({ sessions: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd: 'C:\\work' }] })
  try {
    const result = await ctx.env.commands.get('one').handler({
      agent: makeAgent('human', ctx.root),
      rawInput: 'send s1 hello-from-human',
    })
    assert.equal(result.kind, 'success')
    await wait()
    assert.equal(ctx.env.controller.calls.prompt.at(-1).content[0].text, 'hello-from-human')
  } finally {
    await ctx.cleanup()
  }
})

test('/one assistant creates the session and reports it', async () => {
  const ctx = await makeAssistantEnv()
  try {
    const result = await ctx.env.commands.get('one').handler({
      agent: makeAgent('human', ctx.root),
      rawInput: 'assistant',
    })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /助手会话/u)
    assert.equal(ctx.env.runtime.sessions.assistantSessionId() !== undefined, true)
  } finally {
    await ctx.cleanup()
  }
})

test('an unknown /one subcommand returns an error with the help text', async () => {
  const ctx = await makeAssistantEnv()
  try {
    const result = await ctx.env.commands.get('one').handler({
      agent: makeAgent('human', ctx.root),
      rawInput: 'nope',
    })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /用法/u)
  } finally {
    await ctx.cleanup()
  }
})
