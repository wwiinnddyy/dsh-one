import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_QUIET_POLICY,
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
import { attentionOf, isTerminalRun, runStatusOf, transitionsOf } from '../lib/run/filter.js'

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
  assert.equal(workspaces.length, 2)
  assert.equal(workspaces[0].path, 'c:/work/one')
  assert.equal(workspaces[0].sessions.length, 2)
  assert.equal(workspaces[0].running, 1)
  assert.equal(workspaces[0].unregistered, 1)
  assert.equal(workspaces[0].lastActivityAt, 20)
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

// ------------------------------------------------------------------- notify

test('localMinuteOfDay and inQuietHours handle a window that wraps midnight', () => {
  const at = Date.UTC(2024, 0, 1, 23, 30)
  assert.equal(localMinuteOfDay(at), 23 * 60 + 30)
  assert.equal(inQuietHours(23 * 60 + 30, 22 * 60, 7 * 60), true)
  assert.equal(inQuietHours(3 * 60, 22 * 60, 7 * 60), true)
  assert.equal(inQuietHours(12 * 60, 22 * 60, 7 * 60), false)
  assert.equal(inQuietHours(5, 5, 5), false)
})

test('suppressionOf mutes noise but lets a block through', () => {
  const muted = { ...DEFAULT_QUIET_POLICY, muted: true }
  const base = { key: 'k', title: 't', at: 0 }
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

// ------------------------------------------------------------------- filter

function step(status, overrides = {}) {
  return { index: 0, taskId: 't1', title: 'step', goal: 'g', status, ...overrides }
}

function run(overrides = {}) {
  return {
    runId: 'run-1', goal: 'g', title: 't', cwd: '/w', cwdLabel: '/w',
    origin: 'human', mode: 'execute', status: 'active', paused: false,
    steps: [], limits: { maxTasks: 5, deadlineMs: 60_000 }, deadlineAt: 0,
    activitySeq: 0, seen: {}, createdAt: 0, updatedAt: 0, ...overrides,
  }
}

test('runStatusOf projects step states into the run state', () => {
  assert.equal(runStatusOf(run(), [step('done')]), 'done')
  assert.equal(runStatusOf(run(), [step('running')]), 'active')
  assert.equal(runStatusOf(run(), [step('failed')]), 'failed')
  assert.equal(runStatusOf(run(), [step('blocked')]), 'needs-you')
  assert.equal(runStatusOf(run(), [step('ready')]), 'needs-you')
  assert.equal(runStatusOf(run({ paused: true }), [step('ready')]), 'active')
  assert.equal(runStatusOf(run(), []), 'done')
})

test('transitionsOf records terminal and attention states only', () => {
  const done = transitionsOf(run({ seen: { t1: 'running' } }), [step('done')])
  assert.equal(done.length, 1)
  assert.equal(done[0].kind, 'step-done')
  assert.equal(done[0].previous, 'running')

  assert.equal(transitionsOf(run({ seen: { t1: 'running' } }), [step('running')]).length, 0)
  assert.equal(transitionsOf(run({ seen: { t1: 'queued' } }), [step('queued')]).length, 0)

  const blocked = transitionsOf(run({ seen: { t1: 'running' } }), [step('blocked')])
  assert.equal(blocked[0].kind, 'step-blocked')
  assert.equal(blocked[0].level, 'attention')

  const failed = transitionsOf(run(), [step('failed')])
  assert.equal(failed[0].kind, 'step-failed')
  assert.equal(failed[0].level, 'error')
})

test('attentionOf prefers the task report reason and keeps its timestamp', () => {
  const attention = attentionOf([step('ready', { attention: 'please accept', updatedAt: 5 })], 10)
  assert.deepEqual(attention, { reason: 'please accept', taskId: 't1', since: 5 })
  assert.equal(attentionOf([step('running')], 10), undefined)
  assert.equal(isTerminalRun('done'), true)
  assert.equal(isTerminalRun('needs-you'), false)
})
