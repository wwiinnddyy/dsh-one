import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ASSIST_LIMITS,
  normalizeLimits,
  planSteps,
  runAssist,
} from '../lib/task/assist.js'
import {
  DEFAULT_QUIET_POLICY,
  candidatesFromOutcome,
  inQuietHours,
  localMinuteOfDay,
  selectNotifications,
  suppressionOf,
} from '../lib/task/notify.js'
import {
  buildWorkspaceOverview,
  canonicalPath,
  groupSessionsByWorkspace,
  workspaceLabel,
} from '../lib/core/workspaces.js'

/** A task port whose statuses the test drives directly. */
function fakePort(statuses) {
  const created = []
  const assigned = []
  return {
    created,
    assigned,
    port: {
      async createTask(input, options) {
        const id = `t${created.length + 1}`
        created.push({ id, input, options })
        return { task: { id, status: 'queued' } }
      },
      async assign(taskId, options) {
        assigned.push({ taskId, options })
        return { started: true }
      },
      getTask(taskId) {
        const status = statuses[taskId]
        return status === undefined ? undefined : { id: taskId, status }
      },
    },
  }
}

// ---------------------------------------------------------------- workspaces

test('canonicalPath normalizes separators, trailing slashes, and drive case', () => {
  assert.equal(canonicalPath('C:\\work\\proj\\'), 'c:/work/proj')
  assert.equal(canonicalPath('/home/me/proj/'), '/home/me/proj')
  assert.equal(canonicalPath('   '), '')
  // POSIX paths are case-sensitive and must keep their case.
  assert.equal(canonicalPath('/Home/Me'), '/Home/Me')
})

test('workspaceLabel returns the final segment and marks the empty path', () => {
  assert.equal(workspaceLabel('c:/work/proj'), 'proj')
  assert.equal(workspaceLabel('/home/me'), 'me')
  assert.equal(workspaceLabel(''), '(no workspace)')
})

test('groupSessionsByWorkspace groups by cwd and skips subagents', () => {
  const { workspaces, homeless } = groupSessionsByWorkspace([
    { sessionId: 'a', cwd: 'C:\\work\\one', running: true, blank: false, registered: true, subagent: false, trusted: true, lastSeenAt: 10 },
    { sessionId: 'b', cwd: 'C:/work/one/', running: false, blank: false, registered: false, subagent: false, trusted: true, lastSeenAt: 20 },
    { sessionId: 'c', cwd: 'C:\\work\\two', running: false, blank: false, registered: true, subagent: false, trusted: true, lastSeenAt: 5 },
    { sessionId: 'd', running: false, blank: false, registered: true, subagent: false, trusted: true },
    { sessionId: 'e', cwd: 'C:\\work\\one', running: false, blank: false, registered: true, subagent: true, trusted: true },
  ])
  // `a` and `b` differ only by separator, trailing slash, and drive case.
  assert.equal(workspaces.length, 2)
  assert.equal(workspaces[0].path, 'c:/work/one')
  assert.equal(workspaces[0].sessions.length, 2)
  assert.equal(workspaces[0].running, 1)
  assert.equal(workspaces[0].unregistered, 1)
  assert.equal(workspaces[0].lastActivityAt, 20)
  // A session with no cwd cannot belong to a Workspace.
  assert.deepEqual(homeless.map(session => session.sessionId), ['d'])
})

test('buildWorkspaceOverview reports totals and attributes instructions', () => {
  const overview = buildWorkspaceOverview({
    sessions: [
      { sessionId: 'a', cwd: '/w/one', running: true, blank: false, registered: true, subagent: false, trusted: true },
      { sessionId: 'b', cwd: '/w/two', running: false, blank: false, registered: true, subagent: false, trusted: true },
    ],
    instructions: [
      { requestId: 'r1', targetSessionId: 'a', status: 'pending', attempts: 1, createdAt: 1, updatedAt: 2, text: 'go' },
      { requestId: 'r2', targetSessionId: 'b', status: 'delivered', attempts: 1, createdAt: 1, updatedAt: 2, text: 'done' },
    ],
  })
  assert.equal(overview.totals.workspaces, 2)
  assert.equal(overview.totals.sessions, 2)
  assert.equal(overview.totals.running, 1)
  assert.equal(overview.totals.pendingInstructions, 1)
  assert.equal(overview.instructions[0].targetWorkspace, '/w/one')
  assert.equal(overview.instructions[1].targetWorkspace, '/w/two')
})

// ------------------------------------------------------------------- assist

test('normalizeLimits clamps absurd values into a safe range', () => {
  assert.deepEqual(normalizeLimits(undefined), DEFAULT_ASSIST_LIMITS)
  const clamped = normalizeLimits({ maxTasks: 999, maxRounds: -5, pollIntervalMs: 1e9 })
  assert.equal(clamped.maxTasks, 20)
  assert.equal(clamped.maxRounds, 1)
  assert.equal(clamped.pollIntervalMs, 60_000)
})

test('planSteps derives one step from the goal when no plan is given', () => {
  assert.deepEqual(planSteps('ship it'), [{ title: 'ship it', goal: 'ship it' }])
  const explicit = [{ title: 'a', goal: 'a' }]
  assert.deepEqual(planSteps('ignored', explicit), explicit)
})

test('runAssist completes when every task reaches done', async () => {
  const statuses = { t1: 'running', t2: 'running' }
  const { port, created, assigned } = fakePort(statuses)
  const outcome = await runAssist(port, {
    goal: 'do work',
    steps: [{ title: 'a', goal: 'a' }, { title: 'b', goal: 'b' }],
    limits: { pollIntervalMs: 0 },
    sleep: async () => { statuses.t1 = 'done'; statuses.t2 = 'done' },
  })
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(outcome.completed, ['t1', 't2'])
  assert.equal(created.length, 2)
  assert.equal(assigned.length, 2)
  // `origin` is a creation-option, not part of the task input.
  assert.equal(created[0].options.origin, 'agent')
})

test('runAssist reports partial when some tasks fail and some finish', async () => {
  const statuses = { t1: 'done', t2: 'failed' }
  const { port } = fakePort(statuses)
  const outcome = await runAssist(port, {
    goal: 'do work',
    steps: [{ title: 'a', goal: 'a' }, { title: 'b', goal: 'b' }],
    limits: { pollIntervalMs: 0 },
    sleep: async () => {},
  })
  assert.equal(outcome.status, 'partial')
  assert.deepEqual(outcome.completed, ['t1'])
  assert.deepEqual(outcome.failed, ['t2'])
})

test('runAssist reports blocked when a task needs a person and nothing failed', async () => {
  const { port } = fakePort({ t1: 'blocked' })
  const outcome = await runAssist(port, {
    goal: 'do work',
    limits: { pollIntervalMs: 0 },
    sleep: async () => {},
  })
  assert.equal(outcome.status, 'blocked')
  assert.deepEqual(outcome.blocked, ['t1'])
})

test('runAssist stops as exhausted when maxRounds is hit with work running', async () => {
  const { port } = fakePort({ t1: 'running' })
  const outcome = await runAssist(port, {
    goal: 'do work',
    limits: { maxRounds: 3, pollIntervalMs: 0 },
    sleep: async () => {},
  })
  assert.equal(outcome.status, 'exhausted')
  assert.equal(outcome.rounds, 3)
})

test('runAssist stops as exhausted when the deadline passes', async () => {
  const { port } = fakePort({ t1: 'running' })
  let clock = 0
  const outcome = await runAssist(port, {
    goal: 'do work',
    limits: { maxRounds: 100, deadlineMs: 1_000, pollIntervalMs: 0 },
    now: () => clock,
    // Each poll advances past the deadline without ever finishing the task.
    sleep: async () => { clock += 600 },
  })
  assert.equal(outcome.status, 'exhausted')
  assert.match(outcome.detail, /deadline/u)
})

test('runAssist reports cancelled when the signal is already aborted', async () => {
  const { port, created } = fakePort({})
  const controller = new AbortController()
  controller.abort()
  const outcome = await runAssist(port, {
    goal: 'do work',
    steps: [{ title: 'a', goal: 'a' }],
    limits: { pollIntervalMs: 0 },
    signal: controller.signal,
    sleep: async () => {},
  })
  assert.equal(outcome.status, 'cancelled')
  assert.equal(created.length, 0)
})

test('runAssist never creates more tasks than maxTasks', async () => {
  const { port, created } = fakePort({ t1: 'done', t2: 'done' })
  await runAssist(port, {
    goal: 'do work',
    steps: [{ title: 'a', goal: 'a' }, { title: 'b', goal: 'b' }, { title: 'c', goal: 'c' }],
    limits: { maxTasks: 2, pollIntervalMs: 0 },
    sleep: async () => {},
  })
  assert.equal(created.length, 2)
})

// ------------------------------------------------------------------- notify

test('localMinuteOfDay and inQuietHours handle a window that wraps midnight', () => {
  const at = Date.UTC(2024, 0, 1, 23, 30)
  assert.equal(localMinuteOfDay(at), 23 * 60 + 30)
  assert.equal(inQuietHours(23 * 60 + 30, 22 * 60, 7 * 60), true)
  assert.equal(inQuietHours(3 * 60, 22 * 60, 7 * 60), true)
  assert.equal(inQuietHours(12 * 60, 22 * 60, 7 * 60), false)
  // An empty window is never quiet.
  assert.equal(inQuietHours(5, 5, 5), false)
})

test('suppressionOf mutes noise but lets a block through', () => {
  const muted = { ...DEFAULT_QUIET_POLICY, muted: true }
  const base = { key: 'k', title: 't', at: 0 }
  // Progress chatter is suppressed; a block and a failure break through.
  assert.equal(suppressionOf({ ...base, reason: 'done' }, muted), 'muted')
  assert.equal(suppressionOf({ ...base, reason: 'needs-you' }, muted), undefined)
  assert.equal(suppressionOf({ ...base, reason: 'failed' }, muted), undefined)
})

test('quiet hours hold back a finished plan but not a block', () => {
  const at = Date.UTC(2024, 0, 1, 23, 0)
  const policy = { ...DEFAULT_QUIET_POLICY, quietFrom: 22 * 60, quietTo: 7 * 60 }
  const base = { key: 'k', title: 't', at }
  assert.equal(suppressionOf({ ...base, reason: 'done' }, policy), 'quiet hours')
  assert.equal(suppressionOf({ ...base, reason: 'needs-you' }, policy), undefined)
})

test('selectNotifications is idempotent across repeated calls', () => {
  const candidates = [{ reason: 'done', key: 'run:completed', title: 't', at: 0 }]
  const first = selectNotifications(candidates, DEFAULT_QUIET_POLICY, new Set())
  assert.equal(first.length, 1)
  const second = selectNotifications(candidates, DEFAULT_QUIET_POLICY, new Set(['run:completed']))
  assert.equal(second.length, 0)
})

test('candidatesFromOutcome raises one message per run, not one per task', () => {
  const done = candidatesFromOutcome(
    { status: 'completed', createdTasks: ['a', 'b'], completed: ['a', 'b'], failed: [], blocked: [], detail: 'ok' },
    5,
    'run1',
  )
  assert.equal(done.length, 1)
  assert.equal(done[0].reason, 'done')

  const blocked = candidatesFromOutcome(
    { status: 'blocked', createdTasks: ['a'], completed: [], failed: [], blocked: ['a'], detail: 'need you' },
    5,
    'run2',
  )
  assert.equal(blocked[0].reason, 'needs-you')

  const failed = candidatesFromOutcome(
    { status: 'failed', createdTasks: ['a'], completed: [], failed: ['a'], blocked: [], detail: 'nope' },
    5,
    'run3',
  )
  assert.equal(failed[0].reason, 'failed')
})
