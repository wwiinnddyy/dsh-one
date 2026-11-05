import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../lib/core/engine.js'
import { MemoryTicketRepository } from '../lib/app/store.js'

function makeEngine() {
  let now = 1000
  const repo = new MemoryTicketRepository()
  const engine = new Engine(repo, () => now)
  return {
    engine,
    repo,
    tick(ms = 1) { now += ms },
  }
}

test('create -> assign -> report ready -> complete', () => {
  const { engine } = makeEngine()
  const created = engine.createTicket({ title: 'Fix it', goal: 'Tests pass' })
  assert.equal(created.status, 'open')
  assert.equal(engine.view(created.ticketId).stage, 'working/queued')

  const assigned = engine.assign({ ticketId: created.ticketId, sessionId: 'session-1' })
  assert.equal(assigned.assignments.length, 1)
  assert.equal(engine.view(created.ticketId).stage, 'working')
  const assignmentId = assigned.assignments[0].assignmentId

  const reported = engine.report({
    ticketId: created.ticketId,
    assignmentId,
    sessionId: 'session-1',
    kind: 'ready',
    summary: 'Tests pass',
  })
  assert.equal(reported.latestReport.kind, 'ready')
  assert.equal(reported.assignments[0].status, 'ended')
  assert.equal(engine.view(created.ticketId).stage, 'person/review')

  const completed = engine.complete({ ticketId: created.ticketId })
  assert.equal(completed.status, 'ended')
  assert.equal(completed.outcome, 'completed')
})

test('a repeated ticketId returns the same ticket instead of creating a second', () => {
  const { engine } = makeEngine()
  const first = engine.createTicket({ title: 'A', goal: 'B', ticketId: 'ticket-fixed' })
  const second = engine.createTicket({ title: 'A', goal: 'B', ticketId: 'ticket-fixed' })
  assert.equal(first.ticketId, second.ticketId)
  assert.equal(engine.list().length, 1)
})

test('a report from an ended assignment is refused', () => {
  const { engine } = makeEngine()
  const ticket = engine.createTicket({ title: 'A', goal: 'B' })
  const assigned = engine.assign({ ticketId: ticket.ticketId, sessionId: 's' })
  const assignmentId = assigned.assignments[0].assignmentId
  engine.report({ ticketId: ticket.ticketId, assignmentId, sessionId: 's', kind: 'waiting', summary: 'waiting' })
  assert.throws(
    () => engine.report({ ticketId: ticket.ticketId, assignmentId, sessionId: 's', kind: 'progress', summary: 'again' }),
    error => error.code === 'one/assignment-not-running',
  )
})

test('a dropped report ends the ticket without asking a person', () => {
  const { engine } = makeEngine()
  const ticket = engine.createTicket({ title: 'A', goal: 'B' })
  const assigned = engine.assign({ ticketId: ticket.ticketId, sessionId: 's' })
  const dropped = engine.report({
    ticketId: ticket.ticketId,
    assignmentId: assigned.assignments[0].assignmentId,
    sessionId: 's',
    kind: 'dropped',
    summary: 'nothing to do',
  })
  assert.equal(dropped.status, 'ended')
  assert.equal(dropped.outcome, 'dropped')
})

test('stop ends an open ticket and cannot be repeated', () => {
  const { engine } = makeEngine()
  const ticket = engine.createTicket({ title: 'A', goal: 'B' })
  const stopped = engine.stop({ ticketId: ticket.ticketId, reason: 'user cancelled' })
  assert.equal(stopped.status, 'ended')
  assert.equal(stopped.outcome, 'cancelled')
  assert.throws(() => engine.stop({ ticketId: ticket.ticketId }), error => error.code === 'one/ticket-ended')
})

test('complete only works on a ready ticket', () => {
  const { engine } = makeEngine()
  const ticket = engine.createTicket({ title: 'A', goal: 'B' })
  assert.throws(() => engine.complete({ ticketId: ticket.ticketId }), error => error.code === 'one/not-ready')
})

test('a write replaces the row instead of mutating the previous snapshot', () => {
  const { engine } = makeEngine()
  const created = engine.createTicket({ title: 'A', goal: 'B' })
  const assigned = engine.assign({ ticketId: created.ticketId, sessionId: 's' })
  assert.equal(created.assignments.length, 0)
  assert.equal(assigned.assignments.length, 1)
})

test('asking and answering moves the ticket through person/answer', () => {
  const { engine } = makeEngine()
  const ticket = engine.createTicket({ title: 'A', goal: 'B' })
  const asked = engine.ask({ ticketId: ticket.ticketId, question: 'which branch?' })
  assert.equal(engine.view(asked.ticketId).stage, 'person/answer')
  const answered = engine.answer({ ticketId: ticket.ticketId, answer: 'main' })
  assert.equal(answered.attention.answer, 'main')
  assert.notEqual(engine.view(ticket.ticketId).stage, 'person/answer')
})
