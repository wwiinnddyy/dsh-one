/**
 * Browser side of dsh-one — a self-contained personal-assistant page.
 *
 * This is NOT a DSH Session rendered by the host. The host runs a hidden
 * ordinary Session as the model engine, but everything the human sees — the
 * header, the transcript and the composer — is drawn here. Opening the
 * assistant therefore never asks which Workspace to use, because no Session is
 * ever opened in the UI.
 *
 * Uses the host's `main` panel slot exactly as the official dsh-superagent
 * prototype does: register one sidebar entry + one keyed main panel, then render
 * our own React tree over our own HTTP API.
 */

interface ReactElementLike {
  readonly type: unknown
  readonly props: unknown
}
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElementLike
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  useEffect(run: () => void | (() => void), deps?: readonly unknown[]): void
  useRef<T>(initial: T): { current: T }
}
interface SlotRegistryLike {
  inject(name: string, callback: () => () => void): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}
interface ClientContextLike {
  readonly slots?: SlotRegistryLike
  get?(name: string): unknown
  effect?(callback: () => (() => void) | void, label?: string): unknown
}
interface StyleTagLike { textContent: string }
interface ResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

declare const window: {
  __ModuleLoader__: {
    load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
}
declare const fetch: (input: string, init?: Record<string, unknown>) => Promise<ResponseLike>
declare const document: {
  head: { appendChild(node: StyleTagLike): void }
  querySelector(selector: string): unknown
  createElement(tag: string): StyleTagLike
  visibilityState?: string
}

let React: ReactLike

const PANEL_ID = 'dsh-one-assistant'

const CSS = [
  // The page fills the whole main column. Nothing here borrows the chat shell.
  '.one-app{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;',
  'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
  '.one-head{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}',
  '.one-avatar{width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;',
  'font-size:14px;font-weight:600;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
  '.one-head-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.one-head-name{font-size:14px;font-weight:600}',
  '.one-head-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.one-head-spacer{flex:1}',
  '.one-tabs{display:flex;gap:4px;flex:none}',
  '.one-tab{padding:5px 12px;border-radius:8px;border:.5px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.one-tab:hover{background:var(--dsw-alias-bg-layer-1)}',
  '.one-tab-active{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-weight:600}',
  '.one-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  '.one-chat-page{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  // Chat
  '.one-chat{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:22px 20px}',
  '.one-chat-inner{width:100%;max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:14px}',
  '.one-msg{display:flex;gap:10px;align-items:flex-start;max-width:100%}',
  '.one-msg-user{flex-direction:row-reverse}',
  '.one-msg-avatar{width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;',
  'font-size:11px;font-weight:600;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}',
  '.one-msg-user .one-msg-avatar{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}',
  '.one-bubble{padding:10px 13px;border-radius:12px;max-width:82%;white-space:pre-wrap;word-break:break-word;',
  'font-size:13px;line-height:1.65;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-msg-user .one-bubble{background:var(--dsw-alias-bg-layer-2)}',
  '.one-msg-system .one-bubble{color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.one-composer{flex:none;padding:12px 20px 16px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
  '.one-composer-inner{width:100%;max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end}',
  '.one-input{flex:1;min-height:44px;max-height:160px;resize:vertical;box-sizing:border-box;padding:11px 13px;border-radius:12px;',
  'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;line-height:1.5}',
  '.one-send{padding:10px 18px;border-radius:11px;border:.5px solid transparent;background:var(--dsw-alias-brand-primary);',
  'color:var(--dsw-alias-bg-base);font:inherit;font-size:13px;font-weight:600;cursor:pointer;flex:none}',
  '.one-send:disabled{opacity:.5;cursor:default}',
  '.one-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin:8px auto 0;max-width:760px}',
  // Workbench tab
  '.one-scroll{flex:1;min-height:0;overflow:auto;padding:20px}',
  '.one-scroll-inner{width:100%;max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:14px}',
  '.one-title{font-size:15px;font-weight:600;margin:0}',
  '.one-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}',
  '.one-card{padding:12px 14px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-card-v{font-size:22px;font-weight:600}',
  '.one-card-k{font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.one-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
  '.one-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1)}',
  '.one-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
  '.one-row-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-chip{font-size:10px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);flex:none}',
  '.one-chip-person{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary));border-color:currentColor}',
  '.one-chip-work{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));border-color:currentColor}',
  '.one-chip-idle,.one-chip-ended{color:var(--dsw-alias-label-secondary)}',
  '.one-btn{padding:5px 11px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.one-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
  '.one-btn:disabled{opacity:.5;cursor:default}',
  '.one-field{display:flex;flex-direction:column;gap:6px;font-size:12px}',
  '.one-textarea{min-height:140px;resize:vertical}',
  '.one-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.one-empty{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}',
].join('')

function ensureStyle(): void {
  if (document.querySelector('style[data-dsh-one]') !== null) return
  const style = document.createElement('style')
  style.textContent = CSS
  ;(style as unknown as { dataset: Record<string, string> }).dataset['dshOne'] = '1'
  document.head.appendChild(style)
}

async function jsonFetch(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const body = value as { error?: unknown }
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  }
  return value
}

interface ChatRow {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
  readonly at: number
}
interface Status {
  readonly openTickets: number
  readonly waiting: number
  readonly backend: string
}
interface Overview {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly assistantSessionId: string | null
  readonly backend: string
  readonly tickets: { readonly total: number; readonly open: number; readonly ended: number }
  readonly workspaces: readonly { readonly path: string; readonly label: string; readonly sessions: number }[]
  readonly sessions: readonly { readonly sessionId: string; readonly running: boolean }[]
}
interface TicketRow {
  readonly ticketId: string
  readonly title: string
  readonly stage: string
  readonly cwd?: string
  readonly status: string
  readonly latestReport?: string
  readonly question?: string
}
interface SettingsView {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly persona: string | null
  readonly notifyMuted: boolean
  readonly backend: string
}

function initial(name: string): string {
  return [...(name.trim() === '' ? '助手' : name)][0] ?? '助'
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    'person/delivery': '投递失败', 'person/answer': '等待回答', 'person/review': '等待验收',
    'person/blocked': '受阻', 'person/failed': '失败', 'working/queued': '排队中',
    idle: '空闲', working: '执行中', ended: '已结束',
  }
  return labels[stage] ?? stage
}

function stageTone(stage: string): string {
  if (stage.startsWith('person/')) return 'person'
  if (stage === 'working' || stage === 'working/queued') return 'work'
  if (stage === 'ended') return 'ended'
  return 'idle'
}

function timeOf(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The whole assistant page: one header, one tab strip, one body. */
function AssistantApp(): ReactElementLike {
  const [tab, setTab] = React.useState<'chat' | 'work' | 'settings'>('chat')
  const [overview, setOverview] = React.useState<Overview | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)

  const reloadOverview = async (): Promise<void> => {
    try {
      setOverview(await jsonFetch('/one/api/overview') as Overview)
    } catch (failure: unknown) {
      setError(String(failure))
    }
  }
  React.useEffect(() => {
    void reloadOverview()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void reloadOverview()
    }, 10_000)
    return () => clearInterval(timer)
  }, [])

  const name = overview?.displayName ?? '助手'
  const status: Status = {
    openTickets: overview?.tickets.open ?? 0,
    waiting: 0,
    backend: overview?.backend ?? '…',
  }

  const tabs = React.createElement('div', { className: 'one-tabs' }, [
    React.createElement('button', {
      key: 'chat', type: 'button', className: `one-tab${tab === 'chat' ? ' one-tab-active' : ''}`,
      onClick: () => setTab('chat'),
    }, '对话'),
    React.createElement('button', {
      key: 'work', type: 'button', className: `one-tab${tab === 'work' ? ' one-tab-active' : ''}`,
      onClick: () => setTab('work'),
    }, `工单 ${overview?.tickets.open ?? 0}`),
    React.createElement('button', {
      key: 'settings', type: 'button', className: `one-tab${tab === 'settings' ? ' one-tab-active' : ''}`,
      onClick: () => setTab('settings'),
    }, '设置'),
  ])

  const body = tab === 'chat'
    ? React.createElement(ChatView, { key: 'chat', name })
    : tab === 'work'
      ? React.createElement(WorkView, { key: 'work', reload: reloadOverview })
      : React.createElement(SettingsView, { key: 'settings', reload: reloadOverview })

  return React.createElement('div', { className: 'one-app' }, [
    React.createElement('div', { key: 'head', className: 'one-head' }, [
      React.createElement('div', { key: 'a', className: 'one-avatar' }, initial(name)),
      React.createElement('div', { key: 'm', className: 'one-head-main' }, [
        React.createElement('span', { key: 'n', className: 'one-head-name' }, name),
        React.createElement('span', { key: 's', className: 'one-head-sub' },
          `常驻助手 · ${status.openTickets} 个工单在推进 · 存储 ${status.backend}`),
      ]),
      React.createElement('div', { key: 'sp', className: 'one-head-spacer' }),
      tabs,
    ]),
    React.createElement('div', { key: 'body', className: 'one-body' }, body),
    ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
  ])
}

/** The conversation: our own transcript and our own composer. */
function ChatView(props: { readonly name: string }): ReactElementLike {
  const [rows, setRows] = React.useState<readonly ChatRow[]>([])
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const scroll = React.useRef<unknown>(undefined)

  const load = async (): Promise<void> => {
    try {
      const value = await jsonFetch('/one/api/chat') as { items: readonly ChatRow[] }
      setRows(value.items)
    } catch (failure: unknown) {
      setError(String(failure))
    }
  }
  React.useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load()
    }, 2_000)
    return () => clearInterval(timer)
  }, [])
  React.useEffect(() => {
    const node = scroll.current as { scrollTop?: number; scrollHeight?: number } | undefined
    if (node !== undefined && typeof node.scrollTop === 'number') node.scrollTop = node.scrollHeight ?? 0
  }, [rows.length])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError(undefined)
    setDraft('')
    // Optimistic user row: the page never waits on the Session to show your words.
    setRows(previous => [...previous, { id: `local-${Date.now()}`, role: 'user', text, at: Date.now() }])
    try {
      await jsonFetch('/one/api/chat?send=' + encodeURIComponent(text))
      await load()
    } catch (failure: unknown) {
      setError(String(failure))
      setDraft(text)
    } finally {
      setBusy(false)
    }
  }

  return React.createElement('div', { className: 'one-app one-chat-page' },
    React.createElement('div', { className: 'one-chat', ref: scroll as unknown as Record<string, unknown> },
      React.createElement('div', { className: 'one-chat-inner' }, [
        ...rows.map(row => React.createElement('div', {
          key: row.id,
          className: `one-msg one-msg-${row.role}`,
        }, [
          React.createElement('div', { key: 'a', className: 'one-msg-avatar' },
            row.role === 'user' ? '我' : row.role === 'system' ? '!' : initial(props.name)),
          React.createElement('div', { key: 'b', className: 'one-bubble' }, row.text),
        ])),
        ...(rows.length === 0
          ? [React.createElement('p', { key: 'empty', className: 'one-empty' }, '正在就绪…')]
          : []),
      ])),
    React.createElement('div', { className: 'one-composer' }, [
      React.createElement('div', { className: 'one-composer-inner' }, [
        React.createElement('textarea', {
          className: 'one-input',
          value: draft,
          placeholder: '直接说你想做什么，我会自己去推进…',
          onChange: (event: { target?: { value?: string } }) => setDraft(event.target?.value ?? ''),
          onKeyDown: (event: { key?: string; shiftKey?: boolean; preventDefault?: () => void }) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault?.()
              void send()
            }
          },
        }),
        React.createElement('button', {
          className: 'one-send', type: 'button', disabled: busy, onClick: () => { void send() },
        }, busy ? '发送中' : '发送'),
      ]),
      React.createElement('p', { className: 'one-hint' }, 'Enter 发送 · Shift+Enter 换行 · 不需要选择工作区'),
    ]),
    ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
  )
}

/** Workbench tab: tickets, sessions, workspaces. Read and stop only. */
function WorkView(props: { readonly reload: () => Promise<void> }): ReactElementLike {
  const [rows, setRows] = React.useState<readonly TicketRow[]>([])
  const [error, setError] = React.useState<string | undefined>(undefined)
  const load = async (): Promise<void> => {
    try {
      const value = await jsonFetch('/one/api/tickets') as { items: readonly TicketRow[] }
      setRows(value.items)
    } catch (failure: unknown) {
      setError(String(failure))
    }
  }
  React.useEffect(() => { void load() }, [])
  const stop = async (ticketId: string): Promise<void> => {
    try {
      await jsonFetch('/one/api/tickets/stop?ticketId=' + encodeURIComponent(ticketId))
      await load()
      await props.reload()
    } catch (failure: unknown) {
      setError(String(failure))
    }
  }
  return React.createElement('div', { className: 'one-scroll' },
    React.createElement('div', { className: 'one-scroll-inner' }, [
      React.createElement('h3', { key: 't', className: 'one-title' }, '工单'),
      React.createElement('ul', { key: 'l', className: 'one-list' }, rows.length === 0
        ? [React.createElement('li', { key: 'e', className: 'one-empty' }, '还没有工单。在「对话」里告诉我目标就会出现在这里。')]
        : rows.map(row => React.createElement('li', { key: row.ticketId, className: 'one-row' }, [
          React.createElement('span', { key: 'c', className: `one-chip one-chip-${stageTone(row.stage)}` }, stageLabel(row.stage)),
          React.createElement('span', { key: 'm', className: 'one-row-main' }, [
            React.createElement('span', { key: 't', className: 'one-row-title' }, row.title),
            React.createElement('span', { key: 'x', className: 'one-row-meta' },
              [row.cwd ?? '', row.latestReport ?? row.question ?? ''].filter(Boolean).join(' · ') || row.ticketId),
          ]),
          ...(row.status === 'open'
            ? [React.createElement('button', {
              key: 's', type: 'button', className: 'one-btn', onClick: () => { void stop(row.ticketId) },
            }, '停止')]
            : []),
        ]))),
      ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
    ]))
}

/** Settings tab: name and behaviour text. */
function SettingsView(props: { readonly reload: () => Promise<void> }): ReactElementLike {
  const [view, setView] = React.useState<SettingsView | undefined>(undefined)
  const [name, setName] = React.useState('')
  const [persona, setPersona] = React.useState('')
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  React.useEffect(() => {
    void jsonFetch('/one/api/settings').then(value => {
      const data = value as SettingsView
      setView(data)
      setName(data.displayName)
      setPersona(data.persona ?? '')
    }).catch(failure => setNotice(String(failure)))
  }, [])
  const save = async (): Promise<void> => {
    try {
      await jsonFetch('/one/api/settings?displayName=' + encodeURIComponent(name)
        + '&persona=' + encodeURIComponent(persona.trim()))
      setNotice('已保存')
      await props.reload()
    } catch (failure: unknown) {
      setNotice(String(failure))
    }
  }
  const reset = async (): Promise<void> => {
    await jsonFetch('/one/api/settings?resetName=1&resetPersona=1')
    setNotice('已恢复默认')
    await props.reload()
  }
  return React.createElement('div', { className: 'one-scroll' },
    React.createElement('div', { className: 'one-scroll-inner' }, [
      React.createElement('h3', { key: 't', className: 'one-title' }, '设置'),
      React.createElement('div', { key: 'n', className: 'one-field' }, [
        React.createElement('label', { key: 'l' }, `助手名字（默认 ${view?.defaultDisplayName ?? '助手'}）`),
        React.createElement('input', {
          key: 'i', className: 'one-input', value: name,
          onChange: (event: { target?: { value?: string } }) => setName(event.target?.value ?? ''),
        }),
      ]),
      React.createElement('div', { key: 'p', className: 'one-field' }, [
        React.createElement('label', { key: 'l' }, '行为文本（留空使用内置）'),
        React.createElement('textarea', {
          key: 't', className: 'one-input one-textarea', value: persona,
          onChange: (event: { target?: { value?: string } }) => setPersona(event.target?.value ?? ''),
        }),
      ]),
      React.createElement('div', { key: 'a', className: 'one-tabs' }, [
        React.createElement('button', { key: 's', type: 'button', className: 'one-btn', onClick: () => { void save() } }, '保存'),
        React.createElement('button', { key: 'r', type: 'button', className: 'one-btn', onClick: () => { void reset() } }, '恢复默认'),
      ]),
      ...(notice === undefined ? [] : [React.createElement('div', { key: 'x', className: 'one-hint' }, notice)]),
    ]))
}

function glyph(size: number): ReactElementLike {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
  }, [
    React.createElement('path', {
      key: 'p', d: 'M3 4.2C3 3 4 2 5.2 2h5.6C12 2 13 3 13 4.2v4.1c0 1.2-1 2.2-2.2 2.2H8.4L5.6 13v-2.5H5.2C4 10.5 3 9.5 3 8.3V4.2Z',
      stroke: 'currentColor', strokeWidth: '1.3', strokeLinejoin: 'round',
    }),
    React.createElement('circle', { key: 'a', cx: '6.2', cy: '6.1', r: '.8', fill: 'currentColor' }),
    React.createElement('circle', { key: 'b', cx: '9.8', cy: '6.1', r: '.8', fill: 'currentColor' }),
  ])
}

window.__ModuleLoader__.load({
  id: 'dsh-one',
  factory(require) {
    React = require('react') as ReactLike
    const inject = ['slots']

    function apply(ctx: ClientContextLike): void {
      ensureStyle()
      const slots = ctx.slots
      if (slots === undefined) return

      ctx.effect?.(() => {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: -100, label: '助手',
        }, (props: { size?: number }) => glyph(props?.size ?? 16)))
      }, 'dsh-one: assistant entry')

      ctx.effect?.(() => {
        slots.inject('main', () => slots.register({
          name: 'main', key: PANEL_ID,
        }, () => AssistantApp()))
      }, 'dsh-one: assistant page')

      ctx.effect?.(() => {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section', id: 'dsh-one', order: 60, label: '助手',
        }, () => SettingsView({ reload: async () => undefined })))
      }, 'dsh-one: settings section')
    }

    return { inject, apply }
  },
})
