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
 * The model is a real tool-using agent here: the `one_*` tools registered by
 * this plugin are published on every model call, tool-call deltas are collected
 * from the stream, executed in-process, and fed back as tool-result messages
 * until the model produces its final answer. No DSH Session is created or
 * opened — the page owns the transcript and only borrows `ctx.llm`.
 */

import type { AgentLike, DshContextLike, OneConfig, ToolSchemaLike } from '../types.js'
import type { ChatRecord, ChatToolCall, Store } from './store.js'
import type { OneRuntime } from './runtime.js'
import type { ToolCallOutcome } from './tool-registry.js'
import { ASSISTANT_ACTOR_ID } from './tool-registry.js'
import { newId } from '../core/ids.js'
import { personaFor } from './persona.js'

const WELCOME = '你好，我是你的常驻助手。直接告诉我你想做什么，我会自己拆成工单、挑合适的会话去推进，需要你决定时再回来找你。'
const RECALL_WINDOW_MS = 5_000
/** A model turn that keeps asking for tools must not loop forever. */
const MAX_MODEL_STEPS = 8
const TOOL_RESULT_MAX_CHARS = 4_000

interface LlmChunk {
  readonly type?: string
  readonly index?: number
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly argumentsDelta?: string
  readonly block?: {
    readonly type?: string
    readonly id?: string
    readonly name?: string
    readonly arguments?: string
    readonly text?: string
  }
  readonly reason?: Record<string, unknown>
  readonly [key: string]: unknown
}

interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly at: number
}

interface PendingToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

interface ModelTurn {
  readonly text: string
  readonly toolCalls: readonly PendingToolCall[]
  readonly content: readonly Record<string, unknown>[]
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

function jsonText(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…` : text
  } catch {
    return String(value)
  }
}

function parseLegacyToolCall(payload: string | undefined): ChatToolCall | undefined {
  if (payload === undefined) return undefined
  try {
    const value = JSON.parse(payload) as Record<string, unknown>
    if (typeof value['name'] !== 'string' || value['name'] === '') return undefined
    const args = typeof value['arguments'] === 'object' && value['arguments'] !== null ? value['arguments'] : {}
    return {
      id: `legacy-${value['name']}`,
      name: value['name'],
      arguments: JSON.stringify(args),
      status: 'error',
      error: '旧版本只显示了工具调用文本，并未真正执行；请重新发送这条消息。',
    }
  } catch {
    return undefined
  }
}

/** Older builds rendered pseudo tool calls as assistant text; present them as cards instead. */
function normalizeLegacyChat(row: ChatRecord): ChatRecord {
  if (row.role !== 'assistant' || (row.toolCalls?.length ?? 0) > 0) return row
  const trimmed = row.text.trim()
  const details = /^<details\b[^>]*>\s*<summary>\s*工具调用\s*<\/summary>\s*```(?:json)?\s*([\s\S]*?)```\s*<\/details>$/iu.exec(trimmed)
  if (details !== null) {
    const call = parseLegacyToolCall(details[1])
    if (call !== undefined) return { ...row, text: '', toolCalls: [call] }
  }
  const marker = trimmed.lastIndexOf('{"name"')
  if (marker > 0) {
    const call = parseLegacyToolCall(trimmed.slice(marker))
    if (call !== undefined) return { ...row, text: trimmed.slice(0, marker).trim(), toolCalls: [call] }
  }
  return row
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
    return this.store.listChat(limit).map(normalizeLegacyChat)
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
    const writtenIds = new Set<string>()
    const writeRow = async (
      id: string,
      text: string,
      status: ChatRecord['status'],
      toolCalls?: readonly ChatToolCall[],
    ): Promise<void> => {
      if (this.recalled.has(item.id)) return
      writtenIds.add(id)
      await this.store.putChat({
        id,
        role: 'assistant',
        text,
        at: this.now(),
        status,
        replyTo: item.id,
        ...(toolCalls === undefined ? {} : { toolCalls }),
      })
    }
    // Writes must stay ordered: a slow partial-stream write must never land
    // after the final answer and overwrite it.
    let writeQueue: Promise<void> = Promise.resolve()
    const persist = (
      id: string,
      text: string,
      status: ChatRecord['status'],
      toolCalls?: readonly ChatToolCall[],
    ): Promise<void> => {
      const next = writeQueue.then(() => writeRow(id, text, status, toolCalls))
      writeQueue = next.catch(() => {})
      return next
    }
    try {
      const llm = this.ctx.get('llm') as LlmLike | undefined
      if (llm === undefined || typeof llm.stream !== 'function') {
        await persist(newId('chat'), '当前环境没有可用的模型服务，我已记下你的消息。配置好模型后再试一次。', 'failed')
        await this.setUserStatus(item.id, 'failed')
        return
      }
      const route = this.modelRoute()
      if (route.provider === '' || route.model === '') {
        await persist(newId('chat'), '还没有选定模型。请在设置里为助手指定一个模型后重试。', 'failed')
        await this.setUserStatus(item.id, 'failed')
        return
      }
      await this.setUserStatus(item.id, 'read')
      const history = this.messages(item.id)
      const tools = this.runtime.toolRegistry.schemas()
      const agent = this.toolAgent()
      for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
        const rowId = newId('chat')
        let lastFlush = 0
        const turn = await this.streamTurn(llm, route, history, tools, controller.signal, partial => {
          const at = Date.now()
          if (at - lastFlush < 60) return
          lastFlush = at
          void persist(rowId, partial, 'sending')
        })
        if (this.recalled.has(item.id)) { controller.abort(); return }
        if (turn.toolCalls.length === 0) {
          const answer = turn.text.trim() === '' ? '（模型没有返回内容）' : turn.text
          await persist(rowId, answer, 'replied')
          await this.setUserStatus(item.id, 'replied')
          return
        }

        let calls: ChatToolCall[] = turn.toolCalls.map(call => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'running',
        }))
        await persist(rowId, turn.text, 'sending', calls)
        history.push({
          id: newId('msg'),
          role: 'assistant',
          content: turn.content,
          source: { kind: 'plugin', plugin: 'dsh-one', provider: route.provider, model: route.model },
        })
        for (const call of turn.toolCalls) {
          const outcome = await this.runtime.toolRegistry.execute(call, agent, controller.signal)
          if (this.recalled.has(item.id)) { controller.abort(); return }
          calls = calls.map(entry => entry.id === call.id
            ? {
              ...entry,
              status: outcome.ok ? 'ok' as const : 'error' as const,
              ...(outcome.ok ? { result: jsonText(outcome.value) } : { error: outcome.error ?? '工具调用失败' }),
            }
            : entry)
          await persist(rowId, turn.text, 'sending', calls)
          history.push(this.toolResultMessage(call, outcome))
        }
        await persist(rowId, turn.text, 'replied', calls)
      }
      await persist(newId('chat'), '工具调用步数过多，本轮已停止。请把任务拆得更小一些再试。', 'failed')
      await this.setUserStatus(item.id, 'failed')
    } catch (error: unknown) {
      if (controller.signal.aborted || this.recalled.has(item.id)) {
        // The recall path already deleted the rows; make sure nothing lingers.
        for (const id of writtenIds) await this.store.deleteChat(id)
        await this.store.deleteChat(item.id)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      await persist(newId('chat'), `这次没能生成回复：${message}`, 'failed')
      await this.setUserStatus(item.id, 'failed')
    } finally {
      // Keep the marker only as long as a late write could still race the recall.
      const id = item.id
      setTimeout(() => this.recalled.delete(id), 500).unref?.()
      this.active = undefined
    }
  }

  /** Stream one model turn and assemble its text and tool-call blocks. */
  private async streamTurn(
    llm: LlmLike,
    route: { readonly provider: string; readonly model: string },
    history: Record<string, unknown>[],
    tools: readonly ToolSchemaLike[],
    signal: AbortSignal,
    onProgress: (text: string) => void,
  ): Promise<ModelTurn> {
    const textByIndex = new Map<number, string>()
    const callsByIndex = new Map<number, PendingToolCall>()
    const appendText = (index: number, text: string): void => {
      textByIndex.set(index, (textByIndex.get(index) ?? '') + text)
    }
    const ensureCall = (index: number, id: string, name: string): PendingToolCall => {
      const existing = callsByIndex.get(index)
      if (existing !== undefined) {
        if (name !== '' && existing.name === '') callsByIndex.set(index, { ...existing, name })
        return callsByIndex.get(index) as PendingToolCall
      }
      const created: PendingToolCall = { id: id === '' ? `call-${index}` : id, name, arguments: '' }
      callsByIndex.set(index, created)
      return created
    }
    const partialText = (): string => [...textByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('')

    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system: personaFor(this.runtime.assistantName(), this.runtime.settings.persona()),
      messages: history,
      ...(tools.length === 0 ? {} : { tools }),
      maxTokens: 4_096,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.commandTimeoutMs * 4)]),
    })) {
      const envelope = record(chunk)
      if (envelope === undefined) continue
      const type = envelope['type']
      if (type === 'finish') {
        const reason = record(envelope['reason'])
        if (reason?.['kind'] === 'error') {
          const failure = record(reason['failure'])
          throw new Error(typeof failure?.['message'] === 'string' ? failure['message'] : 'model stream failed')
        }
        continue
      }
      if (type === 'text-delta' && typeof envelope['text'] === 'string') {
        const index = typeof envelope['index'] === 'number' ? envelope['index'] : 0
        appendText(index, envelope['text'])
        onProgress(partialText())
        continue
      }
      if (type === 'tool-call-delta') {
        const index = typeof envelope['index'] === 'number' ? envelope['index'] : callsByIndex.size
        const id = typeof envelope['id'] === 'string' ? envelope['id'] : ''
        const name = typeof envelope['name'] === 'string' ? envelope['name'] : ''
        const call = ensureCall(index, id, name)
        const delta = typeof envelope['argumentsDelta'] === 'string' ? envelope['argumentsDelta'] : ''
        callsByIndex.set(index, { ...call, arguments: call.arguments + delta })
        continue
      }
      if (type === 'block-end') {
        const block = record(envelope['block'])
        const index = typeof envelope['index'] === 'number' ? envelope['index'] : 0
        if (block?.['type'] === 'text' && typeof block['text'] === 'string' && (textByIndex.get(index) ?? '') === '') {
          textByIndex.set(index, block['text'])
        }
        if (block?.['type'] === 'tool-call') {
          const id = typeof block['id'] === 'string' ? block['id'] : ''
          const name = typeof block['name'] === 'string' ? block['name'] : ''
          const call = ensureCall(index, id, name)
          callsByIndex.set(index, {
            ...call,
            arguments: typeof block['arguments'] === 'string' && call.arguments === ''
              ? block['arguments']
              : call.arguments,
          })
        }
      }
    }

    const indices = [...new Set([...textByIndex.keys(), ...callsByIndex.keys()])].sort((left, right) => left - right)
    const content: Record<string, unknown>[] = []
    let text = ''
    for (const index of indices) {
      const piece = textByIndex.get(index) ?? ''
      if (piece !== '') {
        text += piece
        content.push({ type: 'text', text: piece })
      }
      const call = callsByIndex.get(index)
      if (call !== undefined) {
        content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
      }
    }
    return { text, toolCalls: [...callsByIndex.values()], content }
  }

  /** A synthetic Agent identity for the plugin's own tools. */
  private toolAgent(): AgentLike {
    const id = this.runtime.assistantSessionId() ?? ASSISTANT_ACTOR_ID
    return { id, session: { id, header: {} } }
  }

  private toolResultMessage(call: PendingToolCall, outcome: ToolCallOutcome): Record<string, unknown> {
    return {
      id: newId('msg'),
      role: 'tool',
      toolCallId: call.id,
      content: [{
        type: 'text',
        text: outcome.ok ? (jsonText(outcome.value) || '（工具没有返回内容）') : `工具调用失败：${outcome.error ?? '未知错误'}`,
      }],
      source: { kind: 'tool', callId: call.id },
      ...(outcome.ok ? {} : { isError: true }),
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
    const rows = this.store.listChat(60).filter(row => row.id !== userMessageId).map(normalizeLegacyChat)
    const history: Record<string, unknown>[] = []
    for (const row of rows) {
      if (row.status === 'sending' || row.status === 'waiting' || row.status === 'failed') continue
      if (row.role === 'assistant') {
        const content: Record<string, unknown>[] = []
        if (row.text !== '') content.push({ type: 'text', text: row.text })
        for (const call of row.toolCalls ?? []) {
          content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
        }
        if (content.length === 0) continue
        history.push({
          id: newId('msg'),
          role: 'assistant',
          content,
          // dsh-llm inspects `message.source.replayState` on assistant turns.
          source: { kind: 'plugin', plugin: 'dsh-one', provider: '', model: '' },
        })
        for (const call of row.toolCalls ?? []) {
          history.push({
            id: newId('msg'),
            role: 'tool',
            toolCallId: call.id,
            content: [{
              type: 'text',
              text: call.status === 'ok'
                ? (call.result === undefined || call.result === '' ? '（工具没有返回内容）' : call.result)
                : `工具调用失败：${call.error ?? '未完成'}`,
            }],
            source: { kind: 'tool', callId: call.id },
            ...(call.status === 'error' ? { isError: true } : {}),
          })
        }
        continue
      }
      history.push({
        id: newId('msg'),
        role: 'user',
        content: [{ type: 'text', text: row.text }],
        source: { kind: 'user' },
      })
    }
    const user = this.store.getChat(userMessageId)
    if (user !== undefined) {
      history.push({ id: newId('msg'), role: 'user', content: [{ type: 'text', text: user.text }], source: { kind: 'user' } })
    }
    return history
  }
}
