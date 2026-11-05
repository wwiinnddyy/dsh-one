import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnv, makeReq } from './harness.mjs'

async function makeApiEnv(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-one-run-api-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const env = await createEnv({
    ...options,
    coreConfig: {
      assistantHomeRoot: work,
      allowedWorkspaceRoots: [work],
      ...(options.coreConfig ?? {}),
    },
    delegateConfig: {
      taskMode: 'active',
      maxWorkers: 2,
      tokenBudget: 0,
      defaultWorkspaceRoot: work,
      ...(options.delegateConfig ?? {}),
    },
  })
  if (options.delegate !== false) {
    await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
  }
  return {
    env,
    work,
    async cleanup() {
      await env.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('every run route stays behind the authentication fence', async () => {
  const ctx = await makeApiEnv({ rejection: 401 })
  try {
    const calls = [
      ['/one/api/runs', makeReq({ method: 'GET' })],
      ['/one/api/runs', makeReq({ method: 'POST', body: '{}' })],
      ['/one/api/run', makeReq({ method: 'GET' })],
      ['/one/api/run/control', makeReq({ method: 'POST', body: '{}' })],
      ['/one/api/activity', makeReq({ method: 'GET' })],
    ]
    for (const [path, request] of calls) {
      const response = await ctx.env.webServer.request(path, request)
      assert.equal(response.status, 401, path)
    }
  } finally {
    await ctx.cleanup()
  }
})

test('the runs API creates, groups, reads, and controls a human run', async () => {
  const ctx = await makeApiEnv()
  try {
    const created = await ctx.env.webServer.request('/one/api/runs', makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Fix the failing test', cwd: ctx.work }),
    }))
    assert.equal(created.status, 200)
    const payload = created.json()
    assert.equal(payload.observed, false)
    assert.equal(payload.run.status, 'active')

    const summary = (await ctx.env.webServer.request('/one/api/runs', makeReq())).json()
    assert.equal(summary.groups.length, 1)
    assert.equal(summary.groups[0].runs[0].runId, payload.run.runId)
    assert.equal(summary.groups[0].runs[0].cwd, ctx.work)
    assert.equal(summary.totals.active, 1)

    const one = (await ctx.env.webServer.request('/one/api/run', makeReq({
      method: 'GET',
      url: `/one/api/run?id=${encodeURIComponent(payload.run.runId)}`,
    }))).json()
    assert.equal(one.run.runId, payload.run.runId)
    assert.ok(one.activities.some(item => item.kind === 'run-started'))

    const paused = (await ctx.env.webServer.request('/one/api/run/control', makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: payload.run.runId, action: 'pause' }),
    }))).json()
    assert.equal(paused.run.paused, true)

    const activity = (await ctx.env.webServer.request('/one/api/activity', makeReq())).json()
    assert.ok(activity.items.some(item => item.kind === 'run-paused'))
  } finally {
    await ctx.cleanup()
  }
})

test('run creation and control reject malformed bodies', async () => {
  const ctx = await makeApiEnv()
  try {
    const noGoal = await ctx.env.webServer.request('/one/api/runs', makeReq({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
    assert.equal(noGoal.status, 400)

    const badControl = await ctx.env.webServer.request('/one/api/run/control', makeReq({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'run-x', action: 'explode' }),
    }))
    assert.equal(badControl.status, 400)

    const missingRun = await ctx.env.webServer.request('/one/api/run', makeReq({
      method: 'GET', url: '/one/api/run?id=run-missing',
    }))
    assert.equal(missingRun.status, 404)
  } finally {
    await ctx.cleanup()
  }
})

test('the settings route writes mute, global pause, and quiet hours', async () => {
  const ctx = await makeApiEnv()
  try {
    const put = async body => (await ctx.env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))).json()

    assert.equal((await put({ notifyMuted: true })).notifyMuted, true)
    assert.equal((await put({ runsPaused: true })).runsPaused, true)
    const quiet = await put({ quietFrom: 22 * 60, quietTo: 7 * 60 })
    assert.equal(quiet.quietFrom, 22 * 60)
    assert.equal(quiet.quietTo, 7 * 60)
    assert.equal(quiet.assistantRunMode, 'execute')

    const half = await ctx.env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quietFrom: 10 }),
    }))
    assert.equal(half.status, 400)

    const outOfRange = await ctx.env.webServer.request('/one/api/settings', makeReq({
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quietFrom: 1440, quietTo: 0 }),
    }))
    assert.equal(outOfRange.status, 400)
  } finally {
    await ctx.cleanup()
  }
})

test('the runs API degrades when the delegate row is absent', async () => {
  const ctx = await makeApiEnv({ delegate: false })
  try {
    const summary = (await ctx.env.webServer.request('/one/api/runs', makeReq())).json()
    assert.deepEqual(summary.groups, [])
    assert.equal(summary.totals.active, 0)
    const settings = (await ctx.env.webServer.request('/one/api/settings', makeReq())).json()
    assert.equal(settings.assistantRunMode, 'unavailable')
    const activity = (await ctx.env.webServer.request('/one/api/activity', makeReq())).json()
    assert.deepEqual(activity.items, [])
  } finally {
    await ctx.cleanup()
  }
})
