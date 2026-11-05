import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnv, makeAgent, makeController, makeReq, makeStorageDomain } from './harness.mjs'

const pause = () => new Promise(resolve => setTimeout(resolve, 15))

async function waitFor(read, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (value) return value
    await pause()
  }
  throw new Error('timed out waiting for a fake-host transition')
}

async function makeRunEnv(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-one-run-'))
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
  const created = await env.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
  const assistantId = created.json().sessionId
  return {
    env,
    assistantId,
    work,
    async cleanup() {
      await env.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function workerOf(env, taskId) {
  const task = env.taskService.getTask(taskId)
  return task?.assignments.find(item => item.status === 'running' || item.status === 'assigned' || item.status === 'waiting')
}

function wakeRows(env) {
  return [...env.storageDomain.tables.get('outbox').records.values()].filter(row => row.source === 'wake')
}

function wakePrompts(env) {
  return env.controller.calls.prompt.filter(call => call.requestId.startsWith('wake-'))
}

test('one_run_start returns before a worker prompt settles', async () => {
  const never = new Promise(() => {})
  const controller = makeController({
    sessions: [],
    // The assistant greeting must settle; only worker dispatch is made to hang.
    promptImpl: request => request.requestId.startsWith('one:assistant-greeting:') || request.requestId.startsWith('wake-')
      ? Promise.resolve({})
      : never,
  })
  const ctx = await makeRunEnv({ controller })
  try {
    const started = await Promise.race([
      ctx.env.runService.start({
        goal: 'Ship the migration',
        origin: 'assistant',
        callerSessionId: ctx.assistantId,
        callerCwd: ctx.work,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('start blocked on dispatch')), 150)),
    ])
    assert.equal(started.run.status, 'active')
    assert.equal(started.observed, false)
    await waitFor(() => ctx.env.taskService.listTasks().length === 1)
    assert.equal(ctx.env.taskService.listTasks()[0].status, 'queued')
  } finally {
    await ctx.cleanup()
  }
})

test('progress stays quiet and a ready step wakes needs-you once', async () => {
  const ctx = await makeRunEnv()
  try {
    const started = await ctx.env.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    const taskId = started.run.steps[0].taskId
    const worker = await waitFor(() => workerOf(ctx.env, taskId))

    await ctx.env.taskService.report({
      taskId, reportId: 'progress-1', kind: 'progress', summary: 'Still running', callerSessionId: worker.sessionId,
    })
    await ctx.env.runService.tick()
    assert.equal(ctx.env.runService.get(started.run.runId).status, 'active')
    assert.equal(wakeRows(ctx.env).length, 0)

    await ctx.env.taskService.report({
      taskId, reportId: 'ready-1', kind: 'ready', summary: 'Tests pass', callerSessionId: worker.sessionId,
    })
    await ctx.env.runService.tick()
    assert.equal(ctx.env.runService.get(started.run.runId).status, 'needs-you')
    const wake = await waitFor(() => wakeRows(ctx.env).find(row => row.status === 'sent'))
    assert.match(wake.requestId, /^wake-/u)
    assert.equal(wakePrompts(ctx.env).length, 1)
    assert.match(wakePrompts(ctx.env)[0].content[0].text, /DSH One 运行/u)

    await ctx.env.runService.tick()
    assert.equal(wakeRows(ctx.env).length, 1, 'a repeated tick does not raise a second wake')
  } finally {
    await ctx.cleanup()
  }
})

test('completing a ready step wakes done exactly once', async () => {
  const ctx = await makeRunEnv()
  try {
    const started = await ctx.env.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    const taskId = started.run.steps[0].taskId
    const worker = await waitFor(() => workerOf(ctx.env, taskId))
    await ctx.env.taskService.report({
      taskId, reportId: 'ready-1', kind: 'ready', summary: 'Tests pass', callerSessionId: worker.sessionId,
    })
    await ctx.env.runService.tick()
    await ctx.env.taskService.control({ taskId, action: 'complete' })
    await ctx.env.runService.tick()
    assert.equal(ctx.env.runService.get(started.run.runId).status, 'done')

    const wakes = await waitFor(() => {
      const rows = wakeRows(ctx.env)
      return rows.length >= 2 && rows.every(row => row.status === 'sent') ? rows : undefined
    })
    assert.equal(wakes.length, 2, 'needs-you then done')
    await ctx.env.runService.tick()
    assert.equal(wakeRows(ctx.env).length, 2, 'done is not repeated')
  } finally {
    await ctx.cleanup()
  }
})

test('pause suppresses the wake and resume releases it', async () => {
  const ctx = await makeRunEnv()
  try {
    const started = await ctx.env.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    const taskId = started.run.steps[0].taskId
    const worker = await waitFor(() => workerOf(ctx.env, taskId))
    await ctx.env.runService.control({ runId: started.run.runId, action: 'pause' })
    await ctx.env.taskService.report({
      taskId, reportId: 'ready-1', kind: 'ready', summary: 'Tests pass', callerSessionId: worker.sessionId,
    })
    await ctx.env.runService.tick()
    const suppressed = [...ctx.env.storageDomain.tables.get('run_wakes').records.values()]
    assert.equal(suppressed.length, 1)
    assert.equal(suppressed[0].status, 'suppressed')
    assert.equal(suppressed[0].suppressedBy, 'paused')
    assert.equal(wakePrompts(ctx.env).length, 0)

    await ctx.env.runService.control({ runId: started.run.runId, action: 'resume' })
    await ctx.env.runService.tick()
    await waitFor(() => wakeRows(ctx.env).find(row => row.status === 'sent'))
    assert.equal(wakePrompts(ctx.env).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('mute keeps needs-you and suppresses done', async () => {
  const ctx = await makeRunEnv()
  try {
    await ctx.env.settings.setNotifyMuted(true)
    const started = await ctx.env.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    const taskId = started.run.steps[0].taskId
    const worker = await waitFor(() => workerOf(ctx.env, taskId))
    await ctx.env.taskService.report({
      taskId, reportId: 'ready-1', kind: 'ready', summary: 'Tests pass', callerSessionId: worker.sessionId,
    })
    await ctx.env.runService.tick()
    await waitFor(() => wakeRows(ctx.env).find(row => row.status === 'sent'))

    await ctx.env.taskService.control({ taskId, action: 'complete' })
    await ctx.env.runService.tick()
    const doneWake = [...ctx.env.storageDomain.tables.get('run_wakes').records.values()]
      .find(row => row.reason === 'done')
    assert.ok(doneWake, 'the done decision is recorded')
    assert.equal(doneWake.status, 'suppressed')
    assert.equal(doneWake.suppressedBy, 'muted')
  } finally {
    await ctx.cleanup()
  }
})

test('observe mode records the plan without creating tasks', async () => {
  const ctx = await makeRunEnv({ delegateConfig: { assistantRunMode: 'observe' } })
  try {
    const started = await ctx.env.runService.start({
      goal: 'Plan the migration',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    assert.equal(started.observed, true)
    assert.equal(started.run.mode, 'observed')
    assert.equal(started.run.status, 'done')
    assert.equal(ctx.env.taskService.listTasks().length, 0)
    assert.equal(wakeRows(ctx.env).length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('the run tool treats the assistant session as the user proxy', async () => {
  const ctx = await makeRunEnv()
  try {
    const tool = ctx.env.tools.get('one_run_start')
    const assistant = ctx.env.agents.get(ctx.assistantId)
    const result = await tool.execute({ goal: 'Fix the failing test', cwd: ctx.work }, {
      agent: assistant,
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(result.status, 'started')
    assert.equal(result.observed, false)
    const run = ctx.env.runService.get(result.runId)
    assert.equal(run.origin, 'assistant')
    assert.equal(run.mode, 'execute')
    await waitFor(() => ctx.env.taskService.listTasks().length === 1)
  } finally {
    await ctx.cleanup()
  }
})

test('a non-assistant agent stays observe-only when taskMode is observe', async () => {
  const ctx = await makeRunEnv({ delegateConfig: { taskMode: 'observe' } })
  try {
    const tool = ctx.env.tools.get('one_run_start')
    const result = await tool.execute({ goal: 'Fix the failing test', cwd: ctx.work }, {
      agent: makeAgent('someone-else', ctx.work),
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(result.status, 'observed')
    assert.equal(ctx.env.taskService.listTasks().length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('a deadline cancels unfinished steps and ends exhausted', async () => {
  const ctx = await makeRunEnv()
  try {
    const started = await ctx.env.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    const taskId = started.run.steps[0].taskId
    await waitFor(() => workerOf(ctx.env, taskId))
    const table = ctx.env.storageDomain.tables.get('runs')
    await table.update(started.run.runId, current => ({ ...current, deadlineAt: Date.now() - 1 }))
    await ctx.env.runService.tick()
    assert.equal(ctx.env.runService.get(started.run.runId).status, 'exhausted')
    assert.equal(ctx.env.taskService.getTask(taskId).status, 'cancelled')
  } finally {
    await ctx.cleanup()
  }
})

test('a rebuilt assistant session is re-bound to live runs', async () => {
  const ctx = await makeRunEnv()
  try {
    const started = await ctx.env.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    await ctx.env.settings.setAssistantSessionId('rebuilt-assistant')
    await ctx.env.runService.tick()
    assert.equal(ctx.env.runService.get(started.run.runId).assistantSessionId, 'rebuilt-assistant')
  } finally {
    await ctx.cleanup()
  }
})

test('a restart reattaches a run and never resends a settled wake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-one-run-restart-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const storageDomain = makeStorageDomain()
  const options = {
    storageDomain,
    coreConfig: { assistantHomeRoot: work, allowedWorkspaceRoots: [work] },
    delegateConfig: { taskMode: 'active', maxWorkers: 2, tokenBudget: 0, defaultWorkspaceRoot: work },
  }
  let runId
  const first = await createEnv(options)
  try {
    const created = await first.webServer.request('/one/api/assistant', makeReq({ method: 'POST' }))
    const assistantId = created.json().sessionId
    const started = await first.runService.start({
      goal: 'Fix the failing test',
      origin: 'assistant',
      callerSessionId: assistantId,
      callerCwd: work,
    })
    runId = started.run.runId
    const taskId = started.run.steps[0].taskId
    const worker = await waitFor(() => workerOf(first, taskId))
    await first.taskService.report({
      taskId, reportId: 'ready-1', kind: 'ready', summary: 'Tests pass', callerSessionId: worker.sessionId,
    })
    await first.runService.tick()
    await waitFor(() => wakeRows(first).find(row => row.status === 'sent'))
  } finally {
    await first.dispose()
  }

  // A wake that was in flight when the host stopped must become unknown, not resend.
  const wakes = storageDomain.tables.get('run_wakes')
  await wakes.put('wake-manual', {
    wakeId: 'wake-manual', runId, reason: 'done', requestId: 'wake-manual',
    status: 'sending', attempts: 1, createdAt: 1, updatedAt: 1,
  })

  const second = await createEnv(options)
  try {
    const run = second.runService.get(runId)
    assert.ok(run, 'the run survives the restart')
    assert.equal(run.status, 'needs-you')
    assert.ok(second.runService.activities(runId, 50).some(item => item.kind === 'recovered'))
    assert.equal(second.controller.calls.prompt.filter(call => call.requestId.startsWith('wake-')).length, 0)
    assert.equal(wakes.get('wake-manual').status, 'unknown')
  } finally {
    await second.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a run started by the assistant tags every step prompt', async () => {
  const ctx = await makeRunEnv()
  try {
    await ctx.env.runService.start({
      goal: 'Tidy the workspace',
      origin: 'assistant',
      callerSessionId: ctx.assistantId,
      callerCwd: ctx.work,
    })
    const task = await waitFor(() => ctx.env.taskService.listTasks()[0])
    assert.equal(task.assistantLabel, '[来自助手「鲸宝」]')
    assert.match(task.inputs[0].text, /^\[来自助手「鲸宝」\]\n\n\[DSH One task /u)
  } finally {
    await ctx.cleanup()
  }
})

test('a run started by an agent keeps the plain step prompt', async () => {
  const ctx = await makeRunEnv()
  try {
    await ctx.env.runService.start({ goal: 'Plain goal', origin: 'agent', callerCwd: ctx.work })
    const task = await waitFor(() => ctx.env.taskService.listTasks()[0])
    assert.equal(task.assistantLabel, undefined)
    assert.match(task.inputs[0].text, /^\[DSH One task /u)
  } finally {
    await ctx.cleanup()
  }
})
