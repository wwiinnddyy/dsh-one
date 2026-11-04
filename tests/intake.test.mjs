import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createEnv, githubEvent, makeConnection, makeReq, makeResponse } from './harness.mjs'

const ingressConfig = (overrides = {}) => ({
  acceptMode: 'observe',
  confirmReply: false,
  taskWorkspaceRoot: 'C:\\work',
  policyScope: '*',
  github: {
    enabled: true,
    repositories: ['acme/repo'],
    allowedActors: ['alice'],
    botLogins: ['dependabot[bot]'],
    requireMention: true,
    mentionLogin: 'one',
    eventTypes: ['issues', 'issue_comment', 'pull_request', 'pull_request_review_comment'],
    pollEnabled: false,
    requireHostAuth: false,
  },
  ...overrides,
})

function overrideGithub(config, github = {}) {
  return { ...config, github: { ...config.github, ...github } }
}

test('trigger ids dedupe and observe records would-accept without a task', async () => {
  const env = await createEnv({ ingress: true, ingressConfig: ingressConfig() })
  const first = await env.intake.handle(githubEvent())
  assert.equal(first.status, 'observed')
  assert.equal(first.decision.outcome, 'would-accept')
  assert.equal(env.storageDomain.tables.get('tasks').size, 0)
  const second = await env.intake.handle(githubEvent())
  assert.equal(second.status, 'duplicate')
  assert.equal(env.storageDomain.tables.get('triggers').size, 1)
  await env.dispose()
})

test('auto accept creates task, mandate, subscription, and decision', async () => {
  const env = await createEnv({
    ingress: true,
    ingressConfig: ingressConfig({ acceptMode: 'auto' }),
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const result = await env.intake.handle(githubEvent())
  assert.equal(result.status, 'accepted')
  assert.ok(result.taskId)
  const task = env.taskService.getTask(result.taskId)
  assert.equal(task.origin, 'source')
  assert.equal(task.mandateId, result.decision.mandateId)
  assert.equal(env.storageDomain.tables.get('mandates').size, 1)
  assert.equal(env.storageDomain.tables.get('subscriptions').size, 1)
  assert.equal(result.decision.outcome, 'accept')
  assert.ok(env.controller.calls.prompt.some(request => request.sessionId === task.assignments[0].sessionId))
  assert.equal(env.storageDomain.tables.get('threads').get(result.decision.threadId).accepted, 1)
  await env.dispose()
})

test('gate rejects an actor outside the allowlist', async () => {
  const env = await createEnv({ ingress: true, ingressConfig: ingressConfig({ acceptMode: 'auto' }) })
  const result = await env.intake.handle(githubEvent({ actor: 'mallory' }))
  assert.equal(result.status, 'declined')
  assert.match(result.reason, /actor/u)
  assert.equal(env.storageDomain.tables.get('evals').size, 0)
  await env.dispose()
})

test('gate rejects a repository outside the allowlist', async () => {
  const env = await createEnv({ ingress: true, ingressConfig: ingressConfig({ acceptMode: 'auto' }) })
  const result = await env.intake.handle(githubEvent({ repository: 'other/repo' }))
  assert.equal(result.status, 'declined')
  assert.match(result.reason, /repository/u)
  await env.dispose()
})

test('an unavailable model assessment fails closed in auto mode', async () => {
  const config = ingressConfig({
    acceptMode: 'auto',
    assessment: { enabled: true, provider: 'p', model: 'm', maxTokens: 256, timeoutMs: 5000 },
  })
  const env = await createEnv({ ingress: true, ingressConfig: config })
  const result = await env.intake.handle(githubEvent())
  assert.equal(result.status, 'declined')
  assert.match(result.reason, /assessment unavailable/u)
  await env.dispose()
})

test('model assessment accepts when every required rule passes', async () => {
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: '[{"ruleId":"actionable","pass":true},{"ruleId":"safe","pass":true}]' }
    },
  }
  const config = ingressConfig({
    acceptMode: 'auto',
    assessment: { enabled: true, provider: 'p', model: 'm', maxTokens: 256, timeoutMs: 5000 },
  })
  const env = await createEnv({ ingress: true, ingressConfig: config, llm })
  const result = await env.intake.handle(githubEvent())
  assert.equal(result.status, 'accepted')
  await env.dispose()
})

test('a denyPattern rule declines the event deterministically', async () => {
  const config = ingressConfig({
    acceptMode: 'auto',
    policyRules: [
      { id: 'safe', text: 'no secrets', required: true, denyPattern: 'api[_-]?key\\s*[:=]' },
    ],
  })
  const env = await createEnv({ ingress: true, ingressConfig: config })
  const result = await env.intake.handle(githubEvent({ body: '@one api_key=abc123 fix it' }))
  assert.equal(result.status, 'declined')
  await env.dispose()
})

test('policy changes append a policy-changed input to affected tasks', async () => {
  const first = await createEnv({
    ingress: true,
    ingressConfig: ingressConfig({ acceptMode: 'auto', confirmReply: false }),
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const accepted = await first.intake.handle(githubEvent())
  const worker = first.taskService.getTask(accepted.taskId).assignments[0]
  await first.taskService.report({
    taskId: accepted.taskId,
    reportId: 'ready-before-policy',
    kind: 'ready',
    summary: 'ready',
    callerSessionId: worker.sessionId,
  })
  const changed = ingressConfig({
    acceptMode: 'auto',
    confirmReply: false,
    policyRules: [
      { id: 'actionable', text: 'The request asks for concrete repository work.', required: true },
      { id: 'safe', text: 'No destructive instructions.', required: true, denyPattern: 'rm\\s+-rf' },
      { id: 'reviewed', text: 'A human has reviewed scope.', required: false },
    ],
  })
  const second = await createEnv({
    ingress: true,
    ingressConfig: changed,
    storageDomain: first.storageDomain,
    controller: first.controller,
    agents: first.agents,
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const task = second.taskService.getTask(accepted.taskId)
  assert.ok(task.inputs.some(input => input.kind === 'policy-changed'))
  assert.equal(second.storageDomain.tables.get('policies').size >= 2, true)
  await second.dispose()
  await first.dispose()
})

test('a mandate whose scope is no longer covered is blocked on recovery', async () => {
  const first = await createEnv({
    ingress: true,
    ingressConfig: ingressConfig({ acceptMode: 'auto', confirmReply: false }),
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const accepted = await first.intake.handle(githubEvent())
  const worker = first.taskService.getTask(accepted.taskId).assignments[0]
  await first.taskService.report({
    taskId: accepted.taskId,
    reportId: 'ready-before-scope',
    kind: 'ready',
    summary: 'ready',
    callerSessionId: worker.sessionId,
  })
  const second = await createEnv({
    ingress: true,
    ingressConfig: ingressConfig({ acceptMode: 'auto', confirmReply: false, policyScope: 'repo:other/*' }),
    storageDomain: first.storageDomain,
    controller: first.controller,
    agents: first.agents,
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const task = second.taskService.getTask(accepted.taskId)
  assert.equal(task.status, 'blocked')
  assert.match(task.blockedReason, /mandate-invalid/u)
  await second.dispose()
  await first.dispose()
})

test('webhook HMAC verification, route acceptance, and delivery dedupe', async () => {
  process.env.DSH_ONE_GITHUB_WEBHOOK_SECRET = 'test-secret'
  const env = await createEnv({
    ingress: true,
    ingressConfig: ingressConfig({ acceptMode: 'auto', confirmReply: false }),
    delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 },
  })
  const payload = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/repo' },
    sender: { login: 'alice' },
    issue: { number: 2, title: 'Fix it', body: '@one please fix it', html_url: 'https://github.com/acme/repo/issues/2', created_at: '2026-01-01T00:00:00Z' },
  })
  const signature = `sha256=${createHmac('sha256', 'test-secret').update(payload).digest('hex')}`
  const headers = {
    'x-hub-signature-256': signature,
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'issues',
  }
  const response = await env.webServer.request('/one/webhook/github', makeReq({ method: 'POST', headers, body: payload }))
  assert.equal(response.status, 202)
  assert.equal(response.json().statuses[0], 'accepted')
  const duplicate = await env.webServer.request('/one/webhook/github', makeReq({ method: 'POST', headers, body: payload }))
  assert.equal(duplicate.status, 202)
  assert.equal(duplicate.json().duplicate, true)
  const bad = await env.webServer.request('/one/webhook/github', makeReq({
    method: 'POST',
    headers: { ...headers, 'x-hub-signature-256': 'sha256=bad' },
    body: payload,
  }))
  assert.equal(bad.status, 401)
  await env.dispose()
  delete process.env.DSH_ONE_GITHUB_WEBHOOK_SECRET
})

test('panel API rejects unauthenticated requests and degrades without task rows', async () => {
  const env = await createEnv({ delegate: false, connection: makeConnection(401) })
  const denied = await env.webServer.request('/one/api/overview', makeReq())
  assert.equal(denied.status, 401)
  await env.dispose()

  const open = await createEnv({ delegate: false, ingress: false })
  const response = await open.webServer.request('/one/api/overview', makeReq())
  assert.equal(response.status, 200)
  const body = response.json()
  assert.equal(body.health.delegate, 'unavailable')
  assert.equal(body.health.ingress, 'unavailable')
  assert.equal(body.attention.length, 0)
  await open.dispose()
})

test('panel API puts attention before running before history', async () => {
  const env = await createEnv({ delegateConfig: { taskMode: 'active', maxWorkers: 2, defaultWorkspaceRoot: 'C:\\work', tokenBudget: 0 } })
  const ready = await env.taskService.createTask({ title: 'Ready', goal: 'g', cwd: 'C:\\work' }, { source: 'command' })
  await env.taskService.assign(ready.task.taskId)
  const worker = env.taskService.getTask(ready.task.taskId).assignments[0]
  await env.taskService.report({ taskId: ready.task.taskId, reportId: 'ready', kind: 'ready', summary: 'needs review', callerSessionId: worker.sessionId })
  const running = await env.taskService.createTask({ title: 'Running', goal: 'g', cwd: 'C:\\other' }, { source: 'command' })
  await env.taskService.assign(running.task.taskId)
  const response = await env.webServer.request('/one/api/overview', makeReq())
  const body = response.json()
  assert.equal(body.attention[0].title, 'Ready')
  assert.equal(body.running[0].title, 'Running')
  const tasks = await env.webServer.request('/one/api/tasks', makeReq())
  assert.equal(tasks.json().items.length, 2)
  await env.dispose()
})
