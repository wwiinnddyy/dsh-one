import test from 'node:test'
import assert from 'node:assert/strict'
import { stageOf } from '../lib/core/stage.js'

const base = {
  ticketId: 't1',
  title: 'T',
  goal: 'G',
  status: 'open',
  assignments: [],
  createdAt: 1,
  updatedAt: 1,
}

const running = { assignmentId: 'a1', sessionId: 's1', status: 'running', startedAt: 1 }
const ended = { assignmentId: 'a1', sessionId: 's1', status: 'ended', startedAt: 1, endedAt: 2 }

test('a fresh ticket is queued for work', () => {
  assert.equal(stageOf(base), 'working/queued')
})

test('a running assignment is working', () => {
  assert.equal(stageOf({ ...base, assignments: [running] }), 'working')
})

test('a waiting report with an ended assignment is idle', () => {
  assert.equal(stageOf({
    ...base,
    assignments: [ended],
    latestReport: { reportId: 'r', assignmentId: 'a1', sessionId: 's1', kind: 'waiting', summary: 'waiting', at: 2 },
  }), 'idle')
})

test('ready, blocked and failed reports are person stages', () => {
  const withReport = kind => ({
    ...base,
    assignments: [ended],
    latestReport: { reportId: 'r', assignmentId: 'a1', sessionId: 's1', kind, summary: kind, at: 2 },
  })
  assert.equal(stageOf(withReport('ready')), 'person/review')
  assert.equal(stageOf(withReport('blocked')), 'person/blocked')
  assert.equal(stageOf(withReport('failed')), 'person/failed')
})

test('questions and delivery failures outrank a report', () => {
  const ready = {
    ...base,
    assignments: [ended],
    latestReport: { reportId: 'r', assignmentId: 'a1', sessionId: 's1', kind: 'ready', summary: 'ready', at: 2 },
  }
  assert.equal(stageOf({ ...ready, attention: { question: 'which branch?', askedAt: 3 } }), 'person/answer')
  assert.equal(stageOf({ ...ready, delivery: { message: 'no such session', at: 3 } }), 'person/delivery')
})

test('an ended ticket has an ended stage', () => {
  assert.equal(stageOf({ ...base, status: 'ended', outcome: 'completed' }), 'ended')
})
