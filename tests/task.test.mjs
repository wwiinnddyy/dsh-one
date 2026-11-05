import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv, makeAgent, makeStorageDomain, makeTable } from './harness.mjs'

const tick = () => new Promise(resolve => setTimeout(resolve, 15))

function startTask(env, overrides = {}, options = {}) {
  return env.taskService.createTask({
    title: 'Fix the failing test',
    goal: 'Make the test suite green and report the evidence.',
    cwd: 'C:\\work',
    ...overrides,
    origin: overrides.origin ?? 'agent',
  }, {
    source: 'command',
    callerCwd: 'C:\\work',
    ...options,
  })
}

function assignmentOf(env, taskId) {
  const task = env.taskService.getTask(taskId)
  return task.assignments.find(item => item.status === 'running' || item.status === 'assigned' || item.status === 'waiting')
    ?? task.assignments[task.assignments.length - 1]
}

test('delegation closes the loop: dispatch, report ready, complete', async () => {
  const env = await createEnv({
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const created = await startTask(env)
  assert.equal(created.created, true)
  assert.equal(created.task.status, 'queued')
  const assigned = await env.taskService.assign(created.task.taskId)
  assert.equal(assigned.started, true)
  assert.equal(env.controller.calls.prompt.length, 1)
  const worker = assignmentOf(env, created.task.taskId)
  assert.match(env.controller.calls.prompt[0].requestId, new RegExp(`one:${created.task.taskId}:input-initial`))
  assert.match(env.controller.calls.prompt[0].content[0].text, /one_task_report/u)
  assert.equal(env.taskService.getTask(created.task.taskId).status, 'running')
  assert.equal(env.agents.get(worker.sessionId).ctx.tools.restrictions.length, 1)

  const reported = await env.tools.get('one_task_report').execute({
    taskId: created.task.taskId,
    reportId: 'ready-1',
    kind: 'ready',
    summary: 'Tests pass and a PR is open.',
    evidence: 'npm test; https://github.com/acme/repo/pull/1',
  }, { agent: env.agents.get(worker.sessionId), signal: AbortSignal.timeout(5000) })
  assert.equal(reported.status, 'ready')
  assert.equal(env.taskService.getTask(created.task.taskId).attention.kind, 'report')

  const completed = await env.commands.get('one').handler({
    agent: makeAgent('caller', 'C:\\work'),
    rawInput: `task complete ${created.task.taskId}`,
  })
  assert.equal(completed.kind, 'success')
  assert.equal(env.taskService.getTask(created.task.taskId).status, 'done')
  await env.dispose()
})

test('one_task_report is idempotent by reportId', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 2, tokenBudget: 0 } })
  const created = await startTask(env)
  await env.taskService.assign(created.task.taskId)
  const worker = assignmentOf(env, created.task.taskId)
  const args = { taskId: created.task.taskId, reportId: 'same-report', kind: 'ready', summary: 'done' }
  const first = await env.tools.get('one_task_report').execute(args, {
    agent: env.agents.get(worker.sessionId),
    signal: AbortSignal.timeout(5000),
  })
  const second = await env.tools.get('one_task_report').execute(args, {
    agent: env.agents.get(worker.sessionId),
    signal: AbortSignal.timeout(5000),
  })
  assert.deepEqual(first, second)
  assert.equal(env.storageDomain.tables.get('reports').size, 1)
  assert.equal(env.taskService.getTask(created.task.taskId).status, 'ready')
  await env.dispose()
})

test('workspace leases serialize two tasks on the same canonical cwd', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 2, tokenBudget: 0 } })
  const first = await startTask(env)
  const second = await startTask(env, { title: 'Second task' })
  await env.taskService.assign(first.task.taskId)
  const blocked = await env.taskService.assign(second.task.taskId)
  assert.equal(blocked.started, false)
  assert.equal(blocked.waitingForLease, true)
  assert.equal(env.taskService.getTask(second.task.taskId).status, 'queued')
  assert.equal(env.controller.calls.prompt.length, 1)

  const worker = assignmentOf(env, first.task.taskId)
  await env.taskService.report({
    taskId: first.task.taskId,
    reportId: 'lease-release',
    kind: 'ready',
    summary: 'first task finished',
    callerSessionId: worker.sessionId,
  })
  const resumed = await env.taskService.assign(second.task.taskId)
  assert.equal(resumed.started, true)
  assert.equal(env.controller.calls.create.length, 2)
  await env.dispose()
})

test('worker slots queue tasks and release on a terminal report', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 0 } })
  const first = await startTask(env)
  const second = await startTask(env, { title: 'Second task', cwd: 'C:\\other' })
  await env.taskService.assign(first.task.taskId)
  const waiting = await env.taskService.assign(second.task.taskId)
  assert.equal(waiting.started, false)
  assert.equal(waiting.waitingForSlot, true)
  const worker = assignmentOf(env, first.task.taskId)
  await env.taskService.report({
    taskId: first.task.taskId,
    reportId: 'slot-release',
    kind: 'ready',
    summary: 'first finished',
    callerSessionId: worker.sessionId,
  })
  const started = await env.taskService.assign(second.task.taskId)
  assert.equal(started.started, true)
  assert.equal(env.controller.calls.create.length, 2)
  await env.dispose()
})

test('a human task takes the additional priority slot over machine work', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 0 } })
  const machine = await startTask(env)
  await env.taskService.assign(machine.task.taskId)
  const human = await startTask(env, { title: 'Human request', cwd: 'C:\\other', origin: 'human' }, { source: 'command' })
  const humanAssigned = await env.taskService.assign(human.task.taskId)
  assert.equal(humanAssigned.started, true)
  assert.equal(env.controller.calls.create.length, 2)
  await env.dispose()
})

test('token budget blocks and cancels the worker without retrying', async () => {
  const env = await createEnv({
    delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 10 },
  })
  const created = await startTask(env)
  await env.taskService.assign(created.task.taskId)
  const worker = assignmentOf(env, created.task.taskId)
  env.emitSession(worker.sessionId, {
    type: 'assistant/message',
    seq: 7,
    data: { usage: { inputTokens: 9, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 } },
  })
  await tick()
  const task = env.taskService.getTask(created.task.taskId)
  assert.equal(task.status, 'blocked')
  assert.equal(task.blockedReason, 'budget-exceeded')
  assert.equal(task.attention.kind, 'budget')
  assert.ok(env.agents.get(worker.sessionId).cancels.length >= 1)
  assert.equal(env.taskService.getTask(created.task.taskId).assignments.filter(item => item.kind === 'retry').length, 0)
  await env.dispose()
})

test('lastUsageSeq prevents duplicate accounting for one event', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 100 } })
  const created = await startTask(env)
  await env.taskService.assign(created.task.taskId)
  const worker = assignmentOf(env, created.task.taskId)
  const event = { type: 'assistant/message', seq: 4, data: { usage: { inputTokens: 10, outputTokens: 2 } } }
  env.emitSession(worker.sessionId, event)
  await tick()
  env.emitSession(worker.sessionId, event)
  await tick()
  assert.equal(env.taskService.getTask(created.task.taskId).usage.totalTokens, 12)
  assert.equal(env.taskService.getTask(created.task.taskId).usage.lastUsageSeq, 4)
  await env.dispose()
})

test('startup recovery marks interrupted assignments unknown and blocks the task', async () => {
  const now = Date.now()
  const task = {
    taskId: 'task-recover',
    title: 'Interrupted work',
    goal: 'finish',
    status: 'running',
    origin: 'human',
    priority: 100,
    cwd: 'C:\\work',
    workspaceMode: 'lease',
    assignments: [{
      assignmentId: 'assign-recover',
      kind: 'initial',
      sessionId: 'worker-recover',
      status: 'running',
      promptStatus: 'sent',
      promptRequestId: 'one:task-recover:input-initial',
      leaseId: 'lease-recover',
      createdAt: now,
      updatedAt: now,
    }],
    inputs: [{
      inputId: 'input-initial',
      kind: 'work',
      text: 'do it',
      requestId: 'one:task-recover:input-initial',
      createdAt: now,
      deliveryStatus: 'sent',
    }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, lastUsageSeq: -1 },
    tokenBudget: 0,
    createdAt: now,
    updatedAt: now,
  }
  const lease = {
    leaseId: 'lease-recover',
    workspace: 'c:\\work',
    ownerTaskId: 'task-recover',
    ownerAssignmentId: 'assign-recover',
    status: 'active',
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: now + 120000,
  }
  const seed = {
    tasks: [['task-recover', task]],
    leases: [['lease-recover', lease]],
  }
  const env = await createEnv({ seed, delegateConfig: { taskMode: 'active', tokenBudget: 0 } })
  const recovered = env.taskService.getTask('task-recover')
  assert.equal(recovered.status, 'blocked')
  assert.equal(recovered.blockedReason, 'host-restarted')
  assert.equal(recovered.assignments[0].status, 'unknown')
  assert.equal(recovered.assignments[0].promptStatus, 'unknown')
  assert.equal(env.storageDomain.tables.get('leases').get('lease-recover').status, 'expired')
  assert.equal(env.controller.calls.prompt.length, 0)
  await env.dispose()
})

test('retry creates a new assignment with a recovery prompt', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, retryLimit: 2, tokenBudget: 0 } })
  const created = await startTask(env, {}, { callerCwd: 'C:\\work' })
  await env.taskService.assign(created.task.taskId)
  const worker = assignmentOf(env, created.task.taskId)
  await env.taskService.blockTask(created.task.taskId, 'host-restarted')
  const retried = await env.taskService.control({ taskId: created.task.taskId, action: 'retry', reason: 'pretend crash' })
  assert.equal(retried.status, 'running')
  const task = env.taskService.getTask(created.task.taskId)
  const retryAssignment = task.assignments.filter(item => item.kind === 'retry')
  assert.equal(retryAssignment.length, 1)
  assert.notEqual(retryAssignment[0].sessionId, worker.sessionId)
  assert.ok(env.controller.calls.prompt.some(request => /DeepSeek Harness may have restarted/u.test(request.content[0].text)))
  await env.dispose()
})

test('agent task tools observe without creating a task by default', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'observe', tokenBudget: 0 } })
  const result = await env.tools.get('one_task_create').execute({
    title: 'Observed task',
    goal: 'record only',
    cwd: 'C:\\work',
  }, { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) })
  assert.equal(result.created, false)
  assert.equal(result.observed, true)
  assert.equal(env.storageDomain.tables.get('tasks').size, 0)
  await env.dispose()
})

const LABEL = '[来自助手「鲸宝」]'

test('an assistant task prompt carries the origin header and keeps it across a retry', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, retryLimit: 2, tokenBudget: 0 } })
  await env.settings.setAssistantSessionId('assistant')
  const created = await env.tools.get('one_task_create').execute({
    title: 'Check the inbox',
    goal: 'Summarize what needs doing today.',
    cwd: 'C:\\work',
    assign: true,
  }, { agent: makeAgent('assistant', 'C:\\work'), signal: AbortSignal.timeout(5000) })

  const task = env.taskService.getTask(created.taskId)
  assert.equal(task.assistantLabel, LABEL)
  assert.match(task.inputs[0].text, /^\[来自助手「鲸宝」\]\n\n\[DSH One task /u)
  assert.match(env.controller.calls.prompt[0].content[0].text, /^\[来自助手「鲸宝」\]\n\n/u)

  // A rename must not rewrite a retry: the label is frozen at creation time.
  await env.settings.setName('新名字')
  await env.taskService.blockTask(task.taskId, 'host-restarted')
  await env.taskService.control({ taskId: task.taskId, action: 'retry', reason: 'pretend crash' })
  const recovery = env.taskService.getTask(task.taskId).inputs.find(item => item.kind === 'recovery')
  assert.ok(recovery !== undefined)
  assert.match(recovery.text, /^\[来自助手「鲸宝」\]\n\n\[DSH One task /u)
  await env.dispose()
})

test('a non-assistant task prompt has no origin header', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 0 } })
  await env.settings.setAssistantSessionId('assistant')
  const created = await env.tools.get('one_task_create').execute({
    title: 'Plain task',
    goal: 'plain work',
    cwd: 'C:\\work',
    assign: true,
  }, { agent: makeAgent('caller', 'C:\\work'), signal: AbortSignal.timeout(5000) })

  const task = env.taskService.getTask(created.taskId)
  assert.equal(task.assistantLabel, undefined)
  assert.match(task.inputs[0].text, /^\[DSH One task /u)
  await env.dispose()
})
test('a turn ending without a report blocks the task', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 0 } })
  const created = await startTask(env)
  await env.taskService.assign(created.task.taskId)
  const worker = assignmentOf(env, created.task.taskId)
  env.emitSession(worker.sessionId, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  const task = env.taskService.getTask(created.task.taskId)
  assert.equal(task.status, 'blocked')
  assert.equal(task.blockedReason, 'turn-ended-without-report')
  await env.dispose()
})

test('prompt admission failure blocks the task and records it', async () => {
  const env = await createEnv({
    delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 0 },
    controller: undefined,
  })
  const created = await startTask(env)
  env.controller.calls.prompt.length = 0
  const original = env.controller.prompt
  env.controller.prompt = async () => {
    const error = new Error('writer held')
    error.code = 'session/writer-held'
    throw error
  }
  await env.taskService.assign(created.task.taskId)
  const task = env.taskService.getTask(created.task.taskId)
  assert.equal(task.status, 'blocked')
  assert.match(task.blockedReason, /dispatch failed/u)
  assert.equal(task.assignments[0].promptStatus, 'pending')
  env.controller.prompt = original
  await env.dispose()
})

test('a missing worker agent blocks the task instead of retrying silently', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 1, tokenBudget: 0 } })
  const created = await startTask(env)
  env.controller.resolveAgent = async () => ({ error: { code: 'session/not-found', message: 'gone' } })
  await env.taskService.assign(created.task.taskId)
  const task = env.taskService.getTask(created.task.taskId)
  assert.equal(task.status, 'blocked')
  assert.match(task.blockedReason, /worker agent/u)
  await env.dispose()
})

test('seed helpers stay importable for direct storage assertions', async () => {
  assert.equal(typeof makeStorageDomain, 'function')
  assert.equal(typeof makeTable, 'function')
})
