import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnv, makeAgent } from './harness.mjs'

const session = { sessionId: 'session-1', updatedAt: 1, running: false, blank: false, agentAvailable: true, cwd: 'C:\\\\work' }

const call = (tool, args, agent = makeAgent('caller', 'C:\\\\work')) =>
  tool.execute(args, { agent, signal: AbortSignal.timeout(5_000) })

test('the row registers its two tools and provides the runtime', async () => {
  const env = await createEnv()
  try {
    assert.deepEqual([...env.tools.keys()].sort(), ['one_status', 'one_work'])
    const services = env.services.get('oneEngine')
    assert.ok(services.runtime)
    assert.equal(typeof services.runtime.engine.createTicket, 'function')
    assert.equal(typeof services.runtime.executor.enqueueLaunch, 'function')
  } finally {
    await env.dispose()
  }
})

test('one_work drives a ticket from creation to completion', async () => {
  const env = await createEnv({ sessions: [session] })
  try {
    const work = env.tools.get('one_work')
    const created = await call(work, { action: 'create', title: 'Fix tests', goal: 'All green' })
    assert.equal(created.status, 'open')
    assert.equal(created.stage, 'working/queued')

    const assigned = await call(work, {
      action: 'assign',
      ticketId: created.ticketId,
      sessionId: 'session-1',
    })
    assert.equal(assigned.stage, 'working')

    const ticket = env.runtime.engine.get(created.ticketId)
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
  } finally {
    await env.dispose()
  }
})

test('one_status reports ticket stages, sessions and workspaces', async () => {
  const env = await createEnv()
  try {
    await call(env.tools.get('one_work'), { action: 'create', title: 'A', goal: 'B' })
    const status = await call(env.tools.get('one_status'), {})
    assert.equal(status.total, 1)
    assert.equal(status.open, 1)
    assert.equal(status.byStage['working/queued'], 1)
    assert.ok(Array.isArray(status.sessions))
    assert.ok(Array.isArray(status.workspaces))
  } finally {
    await env.dispose()
  }
})

test('create_workspace creates the folder and registers it', async () => {
  const env = await createEnv()
  const root = mkdtempSync(join(tmpdir(), 'dsh-one-ws-'))
  const path = join(root, 'new-area')
  try {
    const result = await call(env.tools.get('one_work'), {
      action: 'create_workspace',
      cwd: path,
      name: 'New Area',
    })
    assert.equal(result.path, path)
    assert.equal(result.workspaceId, 'ws-1')
    assert.deepEqual(env.workspaceRegistry.created[0].path, path)
  } finally {
    await env.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unknown action is refused instead of silently doing nothing', async () => {
  const env = await createEnv()
  try {
    await assert.rejects(call(env.tools.get('one_work'), { action: 'explode' }), /unknown action/u)
  } finally {
    await env.dispose()
  }
})

test('a workspace outside the allowed roots is refused', async () => {
  const env = await createEnv({ config: { allowedWorkspaceRoots: ['C:\\allowed'] } })
  try {
    await assert.rejects(
      call(env.tools.get('one_work'), { action: 'create_workspace', cwd: 'C:\\elsewhere' }),
      error => error.code === 'one/workspace-forbidden',
    )
  } finally {
    await env.dispose()
  }
})

/** Walk a JSON schema and record every `type` that is not a single string. */
function collectTypeArrays(node, path, failures) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectTypeArrays(item, `${path}[${index}]`, failures))
    return
  }
  if ('type' in node && typeof node.type !== 'string') failures.push(`${path}.type`)
  for (const [key, value] of Object.entries(node)) {
    collectTypeArrays(value, `${path}.${key}`, failures)
  }
}

test('tool schemas use only the schema subset the host accepts', async () => {
  const env = await createEnv()
  try {
    const failures = []
    for (const tool of env.tools.values()) {
      collectTypeArrays(tool.parameters, `${tool.name}.parameters`, failures)
      collectTypeArrays(tool.output.schema, `${tool.name}.output`, failures)
    }
    assert.deepEqual(failures, [])
  } finally {
    await env.dispose()
  }
})

test('observe mode refuses mutations instead of half-executing them', async () => {
  const env = await createEnv({ config: { mode: 'observe' } })
  try {
    await assert.rejects(
      call(env.tools.get('one_work'), { action: 'create', title: 'A', goal: 'B' }),
      /observe mode/u,
    )
    assert.equal(env.runtime.engine.list().length, 0)
  } finally {
    await env.dispose()
  }
})

test('a goal groups the tickets created with its id', async () => {
  const env = await createEnv()
  try {
    const goal = await call(env.tools.get('one_work'), { action: 'create_goal', title: 'Ship it' })
    assert.equal(typeof goal.goalId, 'string')
    const ticket = await call(env.tools.get('one_work'), {
      action: 'create', title: 'A', goal: 'B', goalId: goal.goalId,
    })
    assert.equal(ticket.status, 'open')
    const view = env.runtime.engine.goalView(goal.goalId)
    assert.equal(view.total, 1)
    assert.equal(view.open, 1)
  } finally {
    await env.dispose()
  }
})
