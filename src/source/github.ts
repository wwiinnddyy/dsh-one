/** GitHub source adapter: HMAC webhook verification, comment polling, and replies. */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DispatchEvent, GithubSourceConfig, HttpRequestLike, HttpResponseLike, ThreadRecord } from '../types.js'
import { OneError } from '../types.js'
import type { OneStore } from '../store/store.js'
import { asRecord, asString, classifyError, now as systemNow, parseJsonObject } from '../util.js'

export interface WebhookEnvelope {
  readonly deliveryId: string
  readonly eventType: string
  readonly events: readonly DispatchEvent[]
}

/** Read a bounded request body; rejects oversize input with 413. */
export async function readBody(req: HttpRequestLike, maxBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error !== undefined) {
        reject(error)
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    req.on('data', (chunk: unknown) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += part.length
      if (size > maxBytes) {
        finish(Object.assign(new Error('request body too large'), { status: 413 }))
        req.resume?.()
        return
      }
      chunks.push(part)
    })
    req.on('end', () => finish())
    req.on('error', () => finish(Object.assign(new Error('request body could not be read'), { status: 400 })))
    req.on('aborted', () => finish(Object.assign(new Error('request aborted'), { status: 400 })))
  })
}

/** Write one JSON response. */
export function jsonResponse(res: HttpResponseLike, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Case-insensitive header read. */
export function headerOf(headers: HttpRequestLike['headers'], name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
  if (Array.isArray(direct)) return direct[0]
  return direct
}

export class GithubSource {
  private readonly config: GithubSourceConfig
  private readonly store: OneStore
  private readonly now: () => number

  constructor(config: GithubSourceConfig, store: OneStore, now: () => number = systemNow) {
    this.config = config
    this.store = store
    this.now = now
  }

  /** Verify one webhook and parse its events. */
  verify(headers: HttpRequestLike['headers'], rawBody: string): WebhookEnvelope {
    const signature = headerOf(headers, 'x-hub-signature-256')
    const deliveryId = headerOf(headers, 'x-github-delivery')
    const eventType = headerOf(headers, 'x-github-event')
    if (signature === undefined || deliveryId === undefined || eventType === undefined) {
      throw new OneError('github/webhook-headers', 'missing GitHub webhook headers', {})
    }
    const secret = process.env[this.config.secretEnv] ?? ''
    if (secret === '') {
      throw new OneError('github/secret-missing', `webhook secret env "${this.config.secretEnv}" is empty`, {})
    }
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
    const actual = signature.trim()
    const expectedBuffer = Buffer.from(expected)
    const actualBuffer = Buffer.from(actual)
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new OneError('github/bad-signature', 'webhook signature did not match', {})
    }
    const payload = parseJsonObject(rawBody)
    if (payload === undefined) throw new OneError('github/bad-body', 'webhook body is not a JSON object', {})
    const events = this.parsePayload(eventType, payload, deliveryId)
    return { deliveryId, eventType, events }
  }

  /** Poll issue comments for each configured repository. */
  async poll(signal?: AbortSignal): Promise<DispatchEvent[]> {
    const token = process.env[this.config.tokenEnv] ?? ''
    if (token === '') throw new OneError('github/token-missing', `polling token env "${this.config.tokenEnv}" is empty`, {})
    const events: DispatchEvent[] = []
    for (const repository of this.config.repositories) {
      const cursorId = `github:${repository}:comments`
      const cursor = this.store.getCursor(cursorId)
      const url = new URL(`${trimSlash(this.config.apiBaseUrl)}/repos/${repository}/issues/comments`)
      url.searchParams.set('sort', 'updated')
      url.searchParams.set('direction', 'asc')
      url.searchParams.set('per_page', '100')
      if (cursor !== undefined && cursor.value !== '') url.searchParams.set('since', cursor.value)
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'dsh-one',
        'x-github-api-version': '2022-11-28',
      }
      if (cursor?.etag !== undefined) headers['if-none-match'] = cursor.etag
      const response = await fetch(url, { headers, signal })
      if (response.status === 304) continue
      if (!response.ok) {
        throw new OneError('github/poll-failed', `GitHub returned ${response.status} for ${repository}`, { status: response.status })
      }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) continue
      let latest = cursor?.value ?? ''
      for (const item of body) {
        const record = asRecord(item)
        if (record === undefined) continue
        const id = asString(record['id'])
        const bodyText = asString(record['body']) ?? ''
        const updatedAt = asString(record['updated_at']) ?? asString(record['created_at']) ?? ''
        const actor = asString(asRecord(record['user'])?.['login']) ?? ''
        const htmlUrl = asString(record['html_url'])
        const issueUrl = asString(record['issue_url']) ?? ''
        if (id === undefined || actor === '') continue
        if (updatedAt !== '' && updatedAt > latest) latest = updatedAt
        const pull = (htmlUrl ?? '').includes('/pull/')
        const numberMatch = /\/issues\/(\d+)$/u.exec(issueUrl) ?? /#(\d+)$/u.exec(htmlUrl ?? '')
        const number = numberMatch === null ? 0 : Number.parseInt(numberMatch[1] ?? '0', 10)
        events.push({
          id: `github:${repository}:comment:${id}`,
          kind: 'issue_comment',
          sourceId: 'github',
          repository,
          actor,
          action: 'created',
          threadId: `github:${repository}:${pull ? 'pr' : 'issue'}-${number}`,
          externalId: `${pull ? 'pr' : 'issue'}-${number}`,
          number,
          title: `${pull ? 'PR' : 'Issue'} #${number}`,
          body: bodyText,
          ...(htmlUrl === undefined ? {} : { url: htmlUrl }),
          isPullRequest: pull,
          createdAt: parseTime(updatedAt),
          deliveryId: `github:${repository}:comment:${id}`,
        })
      }
      await this.store.putCursor({
        cursorId,
        sourceId: 'github',
        repository,
        value: latest,
        ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag') as string }),
        updatedAt: this.now(),
      })
    }
    return events
  }

  /** Post one comment on the thread. */
  async reply(thread: ThreadRecord, text: string, key: string): Promise<void> {
    const token = process.env[this.config.tokenEnv] ?? ''
    if (token === '') throw new OneError('github/token-missing', `reply token env "${this.config.tokenEnv}" is empty`, {})
    const response = await fetch(`${trimSlash(this.config.apiBaseUrl)}/repos/${thread.repository}/issues/${thread.number}/comments`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'dsh-one',
        'x-github-api-version': '2022-11-28',
        'x-one-idempotency-key': key,
      },
      body: JSON.stringify({ body: text }),
    })
    if (!response.ok) {
      throw new OneError('github/reply-failed', `GitHub returned ${response.status}`, { status: response.status })
    }
  }

  private parsePayload(eventType: string, payload: Record<string, unknown>, deliveryId: string): DispatchEvent[] {
    const repository = asString(asRecord(payload['repository'])?.['full_name'])
    const actor = asString(asRecord(payload['sender'])?.['login']) ?? ''
    if (repository === undefined || actor === '') return []
    const action = asString(payload['action']) ?? ''
    if (eventType === 'issues') {
      const issue = asRecord(payload['issue'])
      if (issue === undefined || !['opened', 'reopened'].includes(action)) return []
      return [this.issueEvent('issues', repository, actor, action, issue, deliveryId)]
    }
    if (eventType === 'issue_comment') {
      const comment = asRecord(payload['comment'])
      const issue = asRecord(payload['issue'])
      if (comment === undefined || issue === undefined || action !== 'created') return []
      const body = asString(comment['body']) ?? ''
      const commentId = asString(comment['id']) ?? deliveryId
      const number = Number(issue['number'] ?? 0)
      const pull = asRecord(issue['pull_request']) !== undefined
      return [{
        id: `github:${repository}:comment:${commentId}`,
        kind: 'issue_comment',
        sourceId: 'github',
        repository,
        actor: asString(asRecord(comment['user'])?.['login']) ?? actor,
        action,
        threadId: `github:${repository}:${pull ? 'pr' : 'issue'}-${number}`,
        externalId: `${pull ? 'pr' : 'issue'}-${number}`,
        number,
        title: asString(issue['title']) ?? `${pull ? 'PR' : 'Issue'} #${number}`,
        body,
        ...(asString(comment['html_url']) === undefined ? {} : { url: asString(comment['html_url']) as string }),
        isPullRequest: pull,
        createdAt: parseTime(asString(comment['created_at']) ?? ''),
        deliveryId: `github:${repository}:comment:${commentId}`,
      }]
    }
    if (eventType === 'pull_request') {
      const pull = asRecord(payload['pull_request'])
      if (pull === undefined || !['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)) return []
      const number = Number(pull['number'] ?? 0)
      return [{
        id: `github:${repository}:pr:${number}:${asString(pull['updated_at']) ?? deliveryId}`,
        kind: 'pull_request',
        sourceId: 'github',
        repository,
        actor,
        action,
        threadId: `github:${repository}:pr-${number}`,
        externalId: `pr-${number}`,
        number,
        title: asString(pull['title']) ?? `PR #${number}`,
        body: asString(pull['body']) ?? '',
        ...(asString(pull['html_url']) === undefined ? {} : { url: asString(pull['html_url']) as string }),
        isPullRequest: true,
        createdAt: parseTime(asString(pull['created_at']) ?? ''),
        deliveryId: `github:${repository}:pr:${number}:${deliveryId}`,
      }]
    }
    if (eventType === 'pull_request_review_comment') {
      const comment = asRecord(payload['comment'])
      const pull = asRecord(payload['pull_request'])
      if (comment === undefined || pull === undefined || action !== 'created') return []
      const number = Number(pull['number'] ?? 0)
      return [{
        id: `github:${repository}:review-comment:${asString(comment['id']) ?? deliveryId}`,
        kind: 'pull_request_review_comment',
        sourceId: 'github',
        repository,
        actor: asString(asRecord(comment['user'])?.['login']) ?? actor,
        action,
        threadId: `github:${repository}:pr-${number}`,
        externalId: `pr-${number}`,
        number,
        title: asString(pull['title']) ?? `PR #${number}`,
        body: asString(comment['body']) ?? '',
        ...(asString(comment['html_url']) === undefined ? {} : { url: asString(comment['html_url']) as string }),
        isPullRequest: true,
        createdAt: parseTime(asString(comment['created_at']) ?? ''),
        deliveryId: `github:${repository}:review-comment:${asString(comment['id']) ?? deliveryId}`,
      }]
    }
    return []
  }

  private issueEvent(
    kind: 'issues',
    repository: string,
    actor: string,
    action: string,
    issue: Record<string, unknown>,
    deliveryId: string,
  ): DispatchEvent {
    const number = Number(issue['number'] ?? 0)
    return {
      id: `github:${repository}:issue:${number}:${deliveryId}`,
      kind,
      sourceId: 'github',
      repository,
      actor,
      action,
      threadId: `github:${repository}:issue-${number}`,
      externalId: `issue-${number}`,
      number,
      title: asString(issue['title']) ?? `Issue #${number}`,
      body: asString(issue['body']) ?? '',
      ...(asString(issue['html_url']) === undefined ? {} : { url: asString(issue['html_url']) as string }),
      isPullRequest: asRecord(issue['pull_request']) !== undefined,
      createdAt: parseTime(asString(issue['created_at']) ?? ''),
      deliveryId: `github:${repository}:issue:${number}:${deliveryId}`,
    }
  }
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function parseTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : systemNow()
}

/** Build one acceptance reply key so a delivery retry is identifiable. */
export function confirmationKey(taskId: string): string {
  return `out:${taskId}:accept`
}

/** Log one poll failure without leaking the token. */
export function pollErrorDetail(error: unknown): string {
  const { code, message } = classifyError(error)
  return `${code}: ${message.replace(/Bearer\s+\S+/gu, 'Bearer [redacted]')}`
}
