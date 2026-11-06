/**
 * The assistant's own conversation — self-contained, no DSH Session at all.
 *
 * The interaction model is deliberately human:
 * - a sent message is shown immediately with a delivery state;
 * - the user may recall it within five seconds;
 * - while the assistant is busy, later messages wait and say so;
 * - once the assistant starts answering, the page shows "正在处理中…" and the
 *   reply streams in token by token.
 *
 * Nothing here creates or opens a DSH Session. The host's `llm` service is the
 * only engine, and this module owns the transcript.
 */

import type { DshContextLike, OneConfig } from '../types.js'
import type { ChatRecord, Store } from './store.js'
import type { OneRuntime } from './runtime.js'
import { newId } from '../core/ids.js'
import { personaFor } from './persona.js'

const WELCOME = '你好，我是你的常驻助手。直接告诉我你想做什么，我会自己拆成工单、挑合适的会话去推进，需要你决定时再回来找你。'
const RECALL_WINDOW_MS = 5_000

interface LlmChunk {
  readonly type?: string
  readonly text?: string
}

interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<LlmChunk>
}

interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly at: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Extract answer text from one llm.stream chunk. Reasoning deltas are not answer text. */
export function chunkText(chunk: unknown): string {
  const item = record(chunk)
  if (item === undefined) return ''
  if (item['type'] === 'text-delta' && typeof item['text'] === 'string') return item['text']
  return ''
}

export class AssistantChat {
  private readonly ctx: DshContextLike
  private readonly config: OneConfig
  private readonly store: Store
  private readonly runtime: OneRuntime
  private readonly now: () => number
  private readonly queue: QueuedMessage[] = []
  private readonly recalled = new Set<string>()
  private active: { readonly userMessageId: string; readonly controller: AbortController } | undefined
  private pumping = false

  constructor(runtime: OneRuntime, now: () => number = Date.now) {
    this.runtime = runtime
    this.ctx = runtime.ctx
    this.config = runtime.config
    this.store = runtime.store
    this.now = now
  }

  /** Seed a welcome row once, so an empty page still reads as an assistant. */
  async ensureWelcome(): Promise<void> {
    if (this.store.listChat(1).length > 0) return
    await this.store.putChat({ id: 'welcome', role: 'assistant', text: WELCOME, at: this.now(), status: 'replied' })
  }

  list(limit = 200): readonly ChatRecord[] {
    return this.store.listChat(limit)
  }

  /** The host's default model route, or the configured override. */
  modelRoute(): { provider: string; model: string } {
    const configured = this.store.getSetting('one', 'chatModel')?.value
    if (configured !== undefined) {
      const slash = configured.indexOf('/')
      if (slash > 0 && slash < configured.length - 1) {
        return { provider: configured.slice(0, slash), model: configured.slice(slash + 1) }
      }
    }
    const defaults = this.ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined
    const selection = defaults?.currentSelection?.()
    if (selection !== undefined && selection.provider !== '' && selection.model !== '') return selection
    return { provider: '', model: '' }
  }

  /**
   * Accept one message and return immediately: the user has "sent" it. The
   * answer arrives later through streaming writes to the transcript.
   */
  async send(text: string): Promise<{ readonly id: string; readonly status: ChatRecord['status'] }> {
    const clean = text.trim()
    if (clean === '') throw new Error('one/invalid-argument: message must not be blank')
    if (clean.length > 20_000) throw new Error('one/message-too-long: message is too long')
    await this.ensureWelcome()
    const id = newId('chat')
    const at = this.now()
    const waiting = this.pumping || this.active !== undefined || this.queue.length > 0
    await this.store.putChat({
      id,
      role: 'user',
      text: clean,
      at,
      status: waiting ? 'waiting' : 'sending',
      requestId: newId('chatreq'),
    })
    this.queue.push({ id, text: clean, at })
    void this.pump()
    return { id, status: waiting ? 'waiting' : 'sending' }
  }

  /**
   * Recall one message within five seconds. It is removed from the queue, an
   * in-flight generation is aborted, and any partial answer disappears with it.
   */
  async recall(messageId: string): Promise<{ readonly ok: true }> {
    const row = this.store.getChat(messageId)
    if (row === undefined || row.role !== 'user') {
      throw new Error('one/message-not-found: that message no longer exists')
    }
    if (this.now() - row.at > RECALL_WINDOW_MS) {
      throw new Error('one/recall-expired: the five-second recall window has passed')
    }
    const index = this.queue.findIndex(item => item.id === messageId)
    if (index >= 0) this.queue.splice(index, 1)
    this.recalled.add(messageId)
    if (this.active?.userMessageId === messageId) this.active.controller.abort()
    for (const other of this.store.listChat(10_000)) {
      if (other.replyTo === messageId) await this.store.deleteChat(other.id)
    }
    await this.store.deleteChat(messageId)
    return { ok: true }
  }

  /** Start a fresh conversation: drop every row, then seed the welcome line. */
  async clear(): Promise<void> {
    this.queue.length = 0
    this.active?.controller.abort()
    if (this.active !== undefined) this.recalled.add(this.active.userMessageId)
    for (const row of this.store.listChat(10_000)) await this.store.deleteChat(row.id)
    await this.ensureWelcome()
  }

  /** A short status line for the page header. */
  status(): {
    readonly openTickets: number
    readonly waiting: number
    readonly backend: string
    readonly model: string
    readonly busy: boolean
    readonly activeMessageId?: string
  } {
    const tickets = this.runtime.engine.list()
    const route = this.modelRoute()
    return {
      openTickets: tickets.filter(item => item.status === 'open').length,
      waiting: tickets.filter(item => item.latestReport?.kind === 'ready'
        || item.latestReport?.kind === 'blocked' || item.latestReport?.kind === 'failed').length,
      backend: this.store.backend,
      model: route.provider === '' ? '未配置' : `${route.provider}/${route.model}`,
      busy: this.active !== undefined || this.queue.length > 0,
      ...(this.active === undefined ? {} : { activeMessageId: this.active.userMessageId }),
    }
  }

  /** One worker: drains queued messages in order, streaming each answer. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()
        if (item === undefined) break
        const current = this.store.getChat(item.id)
        if (current === undefined || this.recalled.has(item.id)) continue // recalled while waiting
        await this.setUserStatus(item.id, 'delivered')
        await this.run(item)
      }
    } finally {
      this.pumping = false
    }
  }

  private async run(item: QueuedMessage): Promise<void> {
    const controller = new AbortController()
    this.active = { userMessageId: item.id, controller }
    const assistantId = newId('chat')
    let answer = ''
    let written = false
    const flush = async (status: ChatRecord['status']): Promise<void> => {
      if (this.recalled.has(item.id)) return
      if (answer === '' && status === 'sending') return
      const row: ChatRecord = {
        id: assistantId,
        role: 'assistant',
        text: answer,
        at: this.now(),
        status,
        replyTo: item.id,
      }
      await this.store.putChat(row)
      written = true
    }
    try {
      const llm = this.ctx.get('llm') as LlmLike | undefined
      if (llm === undefined || typeof llm.stream !== 'function') {
        answer = '当前环境没有可用的模型服务，我已记下你的消息。配置好模型后再试一次。'
        await flush('failed')
        await this.setUserStatus(item.id, 'failed')
        return
      }
      const route = this.modelRoute()
      if (route.provider === '' || route.model === '') {
        answer = '还没有选定模型。请在设置里为助手指定一个模型后重试。'
        await flush('failed')
        await this.setUserStatus(item.id, 'failed')
        return
      }
      await this.setUserStatus(item.id, 'read')
      let lastFlush = 0
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: personaFor(this.runtime.assistantName(), this.runtime.settings.persona()),
        messages: this.messages(item.id),
        maxTokens: 4_096,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.commandTimeoutMs * 4)]),
      })) {
        if (this.recalled.has(item.id)) { controller.abort(); break }
        const envelope = record(chunk)
        if (envelope?.['type'] === 'finish') {
          const reason = record(envelope['reason'])
          if (reason?.['kind'] === 'error') {
            const failure = record(reason['failure'])
            throw new Error(typeof failure?.['message'] === 'string' ? failure['message'] : 'model stream failed')
          }
          continue
        }
        const piece = chunkText(chunk)
        if (piece === '') continue
        answer += piece
        const at = Date.now()
        if (at - lastFlush > 60) {
          await flush('sending')
          lastFlush = at
        }
      }
      if (this.recalled.has(item.id)) { controller.abort(); return }
      answer = answer.trim() === '' ? '（模型没有返回内容）' : answer
      await flush('replied')
      await this.setUserStatus(item.id, 'replied')
    } catch (error: unknown) {
      if (controller.signal.aborted || this.recalled.has(item.id)) {
        // The recall path already deleted both rows; make sure nothing lingers.
        if (written) await this.store.deleteChat(assistantId)
        await this.store.deleteChat(item.id)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      answer = `这次没能生成回复：${message}`
      await flush('failed')
      await this.setUserStatus(item.id, 'failed')
    } finally {
      // Keep the marker only as long as a late write could still race the recall.
      const id = item.id
      setTimeout(() => this.recalled.delete(id), 500).unref?.()
      this.active = undefined
    }
  }

  private async setUserStatus(id: string, status: ChatRecord['status']): Promise<void> {
    // A recalled row is gone; never resurrect it. The set is pruned in `finally`
    // of `run`, not here, because a reply must still be recallable within 5 s.
    if (this.recalled.has(id)) return
    const row = this.store.getChat(id)
    if (row === undefined) return
    await this.store.putChat({ ...row, status })
  }

  /** Build the message array handed to the model, ending with the new message. */
  private messages(userMessageId: string): Record<string, unknown>[] {
    const rows = this.store.listChat(60).filter(row => row.id !== userMessageId)
    const history = rows
      .filter(row => row.status !== 'sending' && row.status !== 'waiting' && row.status !== 'failed')
      .map(row => ({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: row.text }],
        // dsh-llm inspects `message.source.replayState` on assistant turns.
        source: row.role === 'assistant'
          ? { kind: 'plugin', plugin: 'dsh-one', provider: '', model: '' }
          : { kind: 'user' },
      }))
    const user = this.store.getChat(userMessageId)
    if (user !== undefined) {
      history.push({ role: 'user', content: [{ type: 'text', text: user.text }], source: { kind: 'user' } })
    }
    return history
  }
}
