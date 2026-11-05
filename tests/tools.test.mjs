import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** Minimal fake Cordis host: records tools, provided services and effects. */
function makeCtx() {
  const tools = new Map()
  const services = new Map()
  const effects = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    get() { return undefined },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, tools, services, effects }
}

const call = (tool, args) => tool.execute(args, { signal: AbortSignal.timeout(5_000) })

test('the base row registers its two tools and provides the engine', async () => {
  const host = makeCtx()
  await apply(host.ctx, {})
  assert.deepEqual([...host.tools.keys()].sort(), ['one_status', 'one_work'])
  assert.ok(host.services.has('oneEngine'))
  assert.equal(typeof host.services.get('oneEngine').engine.createTicket, 'function')
  assert.equal(typeof host.services.get('oneEngine').effects.enqueue, 'function')
})

test('one_work drives a ticket from creation to completion', async () => {
  const host = makeCtx()
  await apply(host.ctx, {})
  const work = host.tools.get('one_work')

  const created = await call(work, { action: 'create', title: 'Fix tests', goal: 'All green' })
  assert.equal(created.status, 'open')
  assert.equal(created.stage, 'working/queued')

  const assigned = await call(work, { action: 'assign', ticketId: created.ticketId, sessionId: 'session-1' })
  assert.equal(assigned.stage, 'working')

  const status = host.services.get('oneEngine')
  const ticket = status.engine.get(created.ticketId)
  const assignmentId = ticket.assignments[0].assignmentId

  const reported = await call(work, {
    action: 'report',
    ticketId: created.ticketId,
    assignmentId,
    sessionId: 'session-1',
    reportKind: 'ready',
    summary: 'Tests pass',
  })
  assert.equal(reported.stage, 'person/review')

  const completed = await call(work, { action: 'complete', ticketId: created.ticketId })
  assert.equal(completed.status, 'ended')
  assert.equal(completed.outcome, 'completed')
})

test('one_status reports counts by stage', async () => {
  const host = makeCtx()
  await apply(host.ctx, {})
  await call(host.tools.get('one_work'), { action: 'create', title: 'A', goal: 'B' })
  const status = await call(host.tools.get('one_status'), {})
  assert.equal(status.total, 1)
  assert.equal(status.open, 1)
  assert.equal(status.byStage['working/queued'], 1)
})

test('an unknown action is refused instead of silently doing nothing', async () => {
  const host = makeCtx()
  await apply(host.ctx, {})
  await assert.rejects(call(host.tools.get('one_work'), { action: 'explode' }), /unknown action/u)
})

test('a host without slots still loads: apply only needs tools', async () => {
  const host = makeCtx()
  await assert.doesNotReject(apply(host.ctx, { displayName: '鲸宝' }))
})
