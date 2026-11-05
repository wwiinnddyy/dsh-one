/**
 * The assistant's own conversation — self-contained, no DSH Session at all.
 *
 * A personal assistant page must not depend on the host's chat shell: opening a
 * Session asks the user to pick a Workspace, and a Session's write handle
 * collides with ours (`session/writer-held`). So this plugin calls the host's
 * `llm` service directly and owns the transcript, the composer and the rows.
 *
 * Nothing here creates or opens a Session. That is the whole design.
 */

import type { DshContextLike, OneConfig } from '../types.js'
import type { ChatRecord, Store } from './store.js'
import type { OneRuntime } from './runtime.js'
import { newId } from '../core/ids.js'
import { personaFor } from './persona.js'

const WELCOME = '你好，我是你的常驻助手。直接告诉我你想做什么，我会自己拆成工单、挑合适的会话去推进，需要你决定时再回来找你。'

interface LlmChunk {
  readonly type?: string
  readonly text?: string
  readonly content?: string
  readonly delta?: string
}

interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<LlmChunk>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Extract text from one llm.stream chunk. */
export function chunkText(chunk: unknown): string {
  const item = record(chunk)
  if (item === undefined) return ''
  if ((item['type'] === 'text-delta' || item['type'] === 'text') && typeof item['text'] === 'string') return item['text']
  if (typeof item['text'] === 'string') return item['text']
  if (typeof item['delta'] === 'string') return item['delta']
  return ''
}

export class AssistantChat {
  private readonly ctx: DshContextLike
  private readonly config: OneConfig
  private readonly store: Store
  private readonly runtime: OneRuntime
  private readonly now: () => number

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
    await this.store.putChat({ id: 'welcome', role: 'assistant', text: WELCOME, at: this.now() })
  }

  list(limit = 200): readonly ChatRecord[] {
    return this.store.listChat(limit)
  }

  /** The host's default model route, or the configured override. */
  private modelRoute(): { provider: string; model: string } {
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

  /** Build the message array handed to the model from our own transcript. */
  private messages(): Record<string, unknown>[] {
    const rows = this.store.listChat(60)
    return rows.map(row => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: row.text }],
      // dsh-llm inspects `message.source.replayState` on assistant turns, so a
      // plugin-authored message must carry an explicit source object.
      source: row.role === 'assistant'
        ? { kind: 'plugin', plugin: 'dsh-one', provider: '', model: '' }
        : { kind: 'user' },
    }))
  }

  /**
   * Record one human message and stream the assistant's answer into our own
   * transcript. No Session is created, opened or written to.
   */
  async send(text: string): Promise<{ readonly id: string; readonly reply: string; readonly error?: string }> {
    const clean = text.trim()
    if (clean === '') throw new Error('one/invalid-argument: message must not be blank')
    if (clean.length > 20_000) throw new Error('one/message-too-long: message is too long')
    await this.ensureWelcome()
    const id = newId('chat')
    await this.store.putChat({ id, role: 'user', text: clean, at: this.now() })

    const llm = this.ctx.get('llm') as LlmLike | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      const reply = '当前环境没有可用的模型服务，我已记下你的消息。配置好模型后再试一次。'
      await this.store.putChat({ id: newId('chat'), role: 'assistant', text: reply, at: this.now() })
      return { id, reply, error: 'llm service is unavailable' }
    }
    const route = this.modelRoute()
    if (route.provider === '' || route.model === '') {
      const reply = '还没有选定模型。请在设置里为助手指定一个模型后重试。'
      await this.store.putChat({ id: newId('chat'), role: 'assistant', text: reply, at: this.now() })
      return { id, reply, error: 'no model configured' }
    }
    try {
      let answer = ''
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: personaFor(this.runtime.assistantName(), this.runtime.settings.persona()),
        messages: this.messages(),
        maxTokens: 4_096,
        signal: AbortSignal.timeout(this.config.commandTimeoutMs * 4),
      })) {
        const item = record(chunk)
        if (item?.['type'] === 'finish') {
          const reason = record(item['reason'])
          if (reason?.['kind'] === 'error') {
            const failure = record(reason['failure'])
            throw new Error(typeof failure?.['message'] === 'string' ? failure['message'] : 'model stream failed')
          }
        }
        answer += chunkText(chunk)
      }
      const reply = answer.trim() || '（模型没有返回内容）'
      await this.store.putChat({ id: newId('chat'), role: 'assistant', text: reply, at: this.now() })
      return { id, reply }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const reply = `这次没能生成回复：${message}`
      await this.store.putChat({ id: newId('chat'), role: 'system', text: reply, at: this.now() })
      return { id, reply, error: message }
    }
  }

  /** A short status line for the page header. */
  status(): { readonly openTickets: number; readonly waiting: number; readonly backend: string } {
    const tickets = this.runtime.engine.list()
    return {
      openTickets: tickets.filter(item => item.status === 'open').length,
      waiting: tickets.filter(item => item.latestReport?.kind === 'ready'
        || item.latestReport?.kind === 'blocked' || item.latestReport?.kind === 'failed').length,
      backend: this.store.backend,
    }
  }
}
