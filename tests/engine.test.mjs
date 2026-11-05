import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../lib/core/engine.js'
import { MemoryStore } from '../lib/app/store.js'

function makeEngine() {
  let now = 1000
  const store = new MemoryStore()
  const engine = new Engine(store, store, () => now)
  return {
    engine,
    store,
    tick(ms = 1) { now += ms },
  }
}

test('create -> assign -> report ready -> complete', async () => {
  const { engine } = makeEngine()
  const created = await engine.createTicket({ title: 'Fix it', goal: 'Tests pass' })
  assert.equal(created.status, 'open')
  assert.equal(engine.view(created.ticketId).stage, 'working/queued')

  const assigned = await engine.assign({ ticketId: created.ticketId, sessionId: 'session-1' })
  assert.equal(assigned.assignments.length, 1)
  assert.equal(engine.view(created.ticketId).stage, 'working')
  const assignmentId = assigned.assignments[0].assignmentId

  const reported = await engine.report({
    ticketId: created.ticketId,
    assignmentId,
    sessionId: 'session-1',
    kind: 'ready',
    summary: 'Tests pass',
  })
  assert.equal(reported.latestReport.kind, 'ready')
  assert.equal(reported.assignments[0].status, 'ended')
  assert.equal(engine.view(created.ticketId).stage, 'person/review')

  const completed = await engine.complete({ ticketId: created.ticketId })
  assert.equal(completed.status, 'ended')
  assert.equal(completed.outcome, 'completed')
})

test('a repeated ticketId returns the same ticket instead of creating a second', async () => {
  const { engine } = makeEngine()
  const first = await engine.createTicket({ title: 'A', goal: 'B', ticketId: 'ticket-fixed' })
  const second = await engine.createTicket({ title: 'A', goal: 'B', ticketId: 'ticket-fixed' })
  assert.equal(first.ticketId, second.ticketId)
  assert.equal(engine.list().length, 1)
})

test('a report from an ended assignment is refused', async () => {
  const { engine } = makeEngine()
  const ticket = await engine.createTicket({ title: 'A', goal: 'B' })
  const assigned = await engine.assign({ ticketId: ticket.ticketId, sessionId: 's' })
  const assignmentId = assigned.assignments[0].assignmentId
  await engine.report({ ticketId: ticket.ticketId, assignmentId, sessionId: 's', kind: 'waiting', summary: 'waiting' })
  await assert.rejects(
    engine.report({ ticketId: ticket.ticketId, assignmentId, sessionId: 's', kind: 'progress', summary: 'again' }),
    error => error.code === 'one/assignment-not-running',
  )
})

test('a dropped report ends the ticket without asking a person', async () => {
  const { engine } = makeEngine()
  const ticket = await engine.createTicket({ title: 'A', goal: 'B' })
  const assigned = await engine.assign({ ticketId: ticket.ticketId, sessionId: 's' })
  const dropped = await engine.report({
    ticketId: ticket.ticketId,
    assignmentId: assigned.assignments[0].assignmentId,
    sessionId: 's',
    kind: 'dropped',
    summary: 'nothing to do',
  })
  assert.equal(dropped.status, 'ended')
  assert.equal(dropped.outcome, 'dropped')
})

test('stop ends an open ticket and cannot be repeated', async () => {
  const { engine } = makeEngine()
  const ticket = await engine.createTicket({ title: 'A', goal: 'B' })
  const stopped = await engine.stop({ ticketId: ticket.ticketId, reason: 'user cancelled' })
  assert.equal(stopped.status, 'ended')
  assert.equal(stopped.outcome, 'cancelled')
  await assert.rejects(engine.stop({ ticketId: ticket.ticketId }), error => error.code === 'one/ticket-ended')
})

test('complete only works on a ready ticket', async () => {
  const { engine } = makeEngine()
  const ticket = await engine.createTicket({ title: 'A', goal: 'B' })
  await assert.rejects(engine.complete({ ticketId: ticket.ticketId }), error => error.code === 'one/not-ready')
})

test('a write replaces the row instead of mutating the previous snapshot', async () => {
  const { engine } = makeEngine()
  const created = await engine.createTicket({ title: 'A', goal: 'B' })
  const assigned = await engine.assign({ ticketId: created.ticketId, sessionId: 's' })
  assert.equal(created.assignments.length, 0)
  assert.equal(assigned.assignments.length, 1)
})

test('asking and answering moves the ticket through person/answer', async () => {
  const { engine } = makeEngine()
  const ticket = await engine.createTicket({ title: 'A', goal: 'B' })
  const asked = await engine.ask({ ticketId: ticket.ticketId, question: 'which branch?' })
  assert.equal(engine.view(asked.ticketId).stage, 'person/answer')
  const answered = await engine.answer({ ticketId: ticket.ticketId, answer: 'main' })
  assert.equal(answered.attention.answer, 'main')
  assert.notEqual(engine.view(ticket.ticketId).stage, 'person/answer')
})

test('a goal is only a grouping and derives its progress from tickets', async () => {
  const { engine } = makeEngine()
  const goal = await engine.createGoal({ title: 'Ship it' })
  const ticket = await engine.createTicket({ title: 'A', goal: 'B', goalId: goal.goalId })
  const attached = await engine.attachToGoal(goal.goalId, ticket.ticketId)
  assert.deepEqual(attached.ticketIds, [ticket.ticketId])
  const view = engine.goalView(goal.goalId)
  assert.equal(view.total, 1)
  assert.equal(view.open, 1)
  assert.equal(view.done, 0)
})
