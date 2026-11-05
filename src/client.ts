/**
 * Browser side of dsh-one.
 *
 * Two seats plus conversation chrome:
 *
 * 1. `sidebar.panellist` — an assistant entry that opens the real DSH session,
 *    and a workbench entry for the ticket/settings pages.
 * 2. `conversation.input.dock` / `conversation.session.header.actions` — a
 *    persistent identity strip that appears only in the assistant's own Session.
 *
 * Written against the DSH client module closure-factory protocol; React is
 * resolved through the platform module table.
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
interface LayoutLike {
  selectPanel?(id: string | null): void
}
interface UiWorkspaceLike {
  openSession(target: string): void
}
interface UiSessionLike {
  readonly sessionId?: string
}
interface ClientContextLike {
  readonly slots?: SlotRegistryLike
  get?(name: string): unknown
  effect?(callback: () => (() => void) | void, label?: string): unknown
}
interface StyleTagLike {
  textContent: string
}
interface ResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

let React: ReactLike

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

const CSS = [
  '.one-page{display:flex;flex-direction:column;gap:12px;padding:16px;max-width:880px}',
  '.one-title{font-size:16px;font-weight:600;margin:0}',
  '.one-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0}',
  '.one-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}',
  '.one-card{padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-card-v{font-size:20px;font-weight:600}',
  '.one-card-k{font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.one-tabs{display:flex;gap:6px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding-bottom:6px}',
  '.one-tab{padding:4px 10px;border-radius:7px;border:.5px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.one-tab-active{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
  '.one-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l1)}',
  '.one-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.one-row-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-chip{font-size:10px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);flex:none}',
  '.one-chip-person{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary));border-color:currentColor}',
  '.one-chip-work{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));border-color:currentColor}',
  '.one-chip-idle{color:var(--dsw-alias-label-secondary)}',
  '.one-chip-ended{color:var(--dsw-alias-label-secondary);opacity:.7}',
  '.one-btn{padding:4px 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.one-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
  '.one-btn:disabled{opacity:.5;cursor:default}',
  '.one-input,.one-textarea{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px}',
  '.one-textarea{min-height:120px;resize:vertical}',
  '.one-field{display:flex;flex-direction:column;gap:5px;font-size:12px}',
  '.one-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.one-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}',
  // Conversation identity strip: only in the assistant Session.
  '.one-identity-bar{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:7px 10px;border-radius:10px;',
  'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-avatar{width:18px;height:18px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;',
  'font-size:10px;font-weight:600;line-height:1;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
  '.one-identity-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}',
  '.one-identity-role{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.one-identity-status{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-chip-assistant{opacity:.85;font-weight:600}',
  '@media (prefers-reduced-motion: reduce){.one-dot-active{animation:none}}',
].join('')

function ensureStyle(): void {
  if (document.querySelector('style[data-dsh-one]') !== null) return
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
}

interface FetchError extends Error { status?: number }

async function jsonFetch(path: string, init?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(init ?? {}) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error: FetchError = new Error(
      typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
        ? (value as { error: string }).error
        : `HTTP ${response.status}`,
    )
    error.status = response.status
    throw error
  }
  return value
}

interface PollState<T> {
  readonly data?: T
  readonly error?: string
  readonly loading: boolean
}
function usePoll<T>(path: string, intervalMs: number): PollState<T> {
  const [state, setState] = React.useState<PollState<T>>({ loading: true })
  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const data = await jsonFetch(path) as T
        if (!cancelled) setState({ data, loading: false })
      } catch (error: unknown) {
        if (!cancelled) setState({ error: String(error), loading: false })
      }
    }
    void load()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load()
    }, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [path, intervalMs])
  return state
}

interface OverviewLike {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly assistantSessionId: string | null
  readonly backend: string
  readonly tickets: { readonly total: number; readonly open: number; readonly ended: number; readonly byStage: Record<string, number> }
  readonly sessions: readonly { readonly sessionId: string; readonly role?: string; readonly cwd?: string; readonly running: boolean }[]
  readonly workspaces: readonly { readonly path: string; readonly label: string; readonly sessions: number }[]
}
interface TicketRow {
  readonly ticketId: string
  readonly title: string
  readonly goal: string
  readonly cwd?: string
  readonly status: string
  readonly stage: string
  readonly latestReport?: string
  readonly question?: string
  readonly updatedAt: number
}
interface SettingsView {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly overridden: boolean
  readonly persona: string | null
  readonly notifyMuted: boolean
  readonly backend: string
}

function assistantInitial(name: string): string {
  return [...(name.trim() === '' ? '助手' : name)][0] ?? '助'
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    'person/delivery': '投递失败',
    'person/answer': '等待回答',
    'person/review': '等待验收',
    'person/blocked': '受阻',
    'person/failed': '失败',
    'working/queued': '排队中',
    idle: '空闲',
    working: '执行中',
    ended: '已结束',
  }
  return labels[stage] ?? stage
}

function stageTone(stage: string): string {
  if (stage.startsWith('person/')) return 'person'
  if (stage === 'working' || stage === 'working/queued') return 'work'
  if (stage === 'ended') return 'ended'
  return 'idle'
}

/** The sidebar entry's main panel: create or open the assistant conversation. */
function AssistantLauncher(props: { readonly ctxRef: ClientContextLike }): ReactElementLike {
  const [error, setError] = React.useState<string | undefined>(undefined)
  const started = React.useRef(false)
  React.useEffect(() => {
    if (started.current) return
    started.current = true
    const open = async (): Promise<void> => {
      try {
        const value = await jsonFetch('/one/api/assistant?create=1') as { sessionId: string }
        const uiWorkspace = props.ctxRef.get?.('uiWorkspace') as UiWorkspaceLike | undefined
        if (uiWorkspace === undefined) {
          setError('当前环境没有会话导航服务')
          return
        }
        uiWorkspace.openSession(value.sessionId)
      } catch (openError: unknown) {
        setError(String(openError))
      }
    }
    void open()
  }, [])
  if (error !== undefined) {
    return React.createElement('div', { className: 'one-page' }, [
      React.createElement('h3', { key: 't', className: 'one-title' }, '无法打开助手会话'),
      React.createElement('div', { key: 'e', className: 'one-error' }, error),
    ])
  }
  return React.createElement('div', { className: 'one-page' }, [
    React.createElement('p', { key: 'p', className: 'one-hint' }, '正在打开助手会话…'),
  ])
}

/** The persistent identity strip above the assistant composer. */
function IdentityBar(props: { readonly session?: { readonly sessionId?: string } }): ReactElementLike | null {
  const state = usePoll<OverviewLike>('/one/api/overview', 5_000)
  const overview = state.data
  const sessionId = props.session?.sessionId
  if (overview === undefined || overview.assistantSessionId === null || sessionId !== overview.assistantSessionId) {
    return null
  }
  const active = overview.tickets.open
  const status = active === 0 ? '待命 · 告诉我目标，我会拆成工单并跟进' : `后台 ${active} 个工单进行中`
  return React.createElement('div', { className: 'one-identity-bar', role: 'status' }, [
    React.createElement('span', { key: 'a', className: 'one-avatar', 'aria-hidden': 'true' }, assistantInitial(overview.displayName)),
    React.createElement('span', { key: 'n', className: 'one-identity-name' }, overview.displayName),
    React.createElement('span', { key: 'r', className: 'one-identity-role' }, '常驻助手'),
    React.createElement('span', { key: 's', className: 'one-identity-status' }, status),
  ])
}

/** The header chip that marks the assistant conversation. */
function AssistantChip(props: { readonly session?: { readonly sessionId?: string } }): ReactElementLike | null {
  const state = usePoll<OverviewLike>('/one/api/overview', 5_000)
  const overview = state.data
  const sessionId = props.session?.sessionId
  if (overview === undefined || overview.assistantSessionId === null || sessionId !== overview.assistantSessionId) {
    return null
  }
  return React.createElement('span', { className: 'one-chip one-chip-assistant' }, '助手')
}

/** The workbench: overview, tickets, settings. */
function Workbench(props: { readonly ctxRef: ClientContextLike }): ReactElementLike {
  const [tab, setTab] = React.useState<'overview' | 'tickets' | 'settings'>('overview')
  const overview = usePoll<OverviewLike>('/one/api/overview', 5_000)
  const tickets = usePoll<{ items: readonly TicketRow[] }>('/one/api/tickets', 5_000)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const data = overview.data
  const rows = tickets.data?.items ?? []

  const stop = async (ticketId: string): Promise<void> => {
    setNotice(undefined)
    try {
      await jsonFetch('/one/api/tickets/stop?ticketId=' + encodeURIComponent(ticketId))
    } catch (error: unknown) {
      setNotice(String(error))
    }
  }

  const tabs = React.createElement('div', { key: 'tabs', className: 'one-tabs' }, [
    React.createElement('button', {
      key: 'o', type: 'button', className: `one-tab${tab === 'overview' ? ' one-tab-active' : ''}`,
      onClick: () => setTab('overview'),
    }, '概览'),
    React.createElement('button', {
      key: 't', type: 'button', className: `one-tab${tab === 'tickets' ? ' one-tab-active' : ''}`,
      onClick: () => setTab('tickets'),
    }, `工单 ${rows.length}`),
    React.createElement('button', {
      key: 's', type: 'button', className: `one-tab${tab === 'settings' ? ' one-tab-active' : ''}`,
      onClick: () => setTab('settings'),
    }, '设置'),
  ])

  const body = tab === 'settings'
    ? [React.createElement(SettingsForm, { key: 'settings' })]
    : tab === 'tickets'
      ? [React.createElement('ul', { key: 'list', className: 'one-list' }, rows.length === 0
        ? [React.createElement('li', { key: 'empty', className: 'one-hint' }, '还没有工单。在助手对话里告诉我目标就会出现在这里。')]
        : rows.map(row => React.createElement('li', { key: row.ticketId, className: 'one-row' }, [
          React.createElement('span', { key: 'chip', className: `one-chip one-chip-${stageTone(row.stage)}` }, stageLabel(row.stage)),
          React.createElement('span', { key: 'main', className: 'one-row-main' }, [
            React.createElement('span', { key: 't', className: 'one-row-title' }, row.title),
            React.createElement('span', { key: 'm', className: 'one-row-meta' },
              [row.cwd ?? '', row.latestReport ?? row.question ?? ''].filter(Boolean).join(' · ') || row.ticketId),
          ]),
          ...(row.status === 'open'
            ? [React.createElement('button', {
              key: 'stop', type: 'button', className: 'one-btn', onClick: () => { void stop(row.ticketId) },
            }, '停止')]
            : []),
        ])))]
      : [React.createElement('div', { key: 'cards', className: 'one-cards' }, [
        React.createElement('div', { key: 'open', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.tickets.open ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '进行中工单'),
        ]),
        React.createElement('div', { key: 'done', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.tickets.ended ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '已结束工单'),
        ]),
        React.createElement('div', { key: 'ws', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.workspaces.length ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '工作区'),
        ]),
        React.createElement('div', { key: 's', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.sessions.length ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '会话'),
        ]),
      ]), React.createElement('p', { key: 'hint', className: 'one-hint' },
        `${data?.displayName ?? '助手'} · 存储 ${data?.backend ?? '未知'} · 用 one_work 派活，用 /one status 查看`)]

  return React.createElement('div', { className: 'one-page' }, [
    React.createElement('h3', { key: 'title', className: 'one-title' }, '工作台'),
    React.createElement('p', { key: 'sub', className: 'one-sub' }, '工单、会话与工作区；这里只读或停止，不替你发消息。'),
    tabs,
    ...body,
    ...(notice === undefined ? [] : [React.createElement('div', { key: 'n', className: 'one-error' }, notice)]),
    ...(overview.error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, overview.error)]),
  ])
}

/** Settings form shared by the workbench and the DSH Settings tab. */
function SettingsForm(): ReactElementLike {
  const state = usePoll<SettingsView>('/one/api/settings', 10_000)
  const [name, setName] = React.useState('')
  const [persona, setPersona] = React.useState('')
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const loaded = state.data
  React.useEffect(() => {
    if (loaded !== undefined) {
      setName(loaded.displayName)
      setPersona(loaded.persona ?? '')
    }
  }, [loaded?.displayName, loaded?.persona])
  const save = async (): Promise<void> => {
    setNotice(undefined)
    try {
      const query = 'displayName=' + encodeURIComponent(name)
        + '&persona=' + encodeURIComponent(persona.trim())
      await jsonFetch('/one/api/settings?' + query)
      setNotice('已保存')
    } catch (error: unknown) {
      setNotice(String(error))
    }
  }
  const reset = async (): Promise<void> => {
    await jsonFetch('/one/api/settings?resetName=1&resetPersona=1')
    setNotice('已恢复默认')
  }
  return React.createElement('div', { className: 'one-page' }, [
    React.createElement('div', { key: 'name', className: 'one-field' }, [
      React.createElement('label', { key: 'l' }, `助手名字（默认 ${loaded?.defaultDisplayName ?? '鲸宝'}）`),
      React.createElement('input', { key: 'i', className: 'one-input', value: name, onChange: (event: { target?: { value?: string } }) => setName(event.target?.value ?? '') }),
    ]),
    React.createElement('div', { key: 'persona', className: 'one-field' }, [
      React.createElement('label', { key: 'l' }, '行为文本（留空使用内置）'),
      React.createElement('textarea', { key: 't', className: 'one-textarea', value: persona, onChange: (event: { target?: { value?: string } }) => setPersona(event.target?.value ?? '') }),
    ]),
    React.createElement('div', { key: 'actions', className: 'one-tabs' }, [
      React.createElement('button', { key: 'save', type: 'button', className: 'one-btn', onClick: () => { void save() } }, '保存'),
      React.createElement('button', { key: 'reset', type: 'button', className: 'one-btn', onClick: () => { void reset() } }, '恢复默认'),
    ]),
    ...(notice === undefined ? [] : [React.createElement('div', { key: 'n', className: 'one-hint' }, notice)]),
    ...(state.error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, state.error)]),
  ])
}

function SettingsSection(): ReactElementLike {
  return React.createElement('div', { className: 'one-page' }, [
    React.createElement('h3', { key: 't', className: 'one-title' }, '助手'),
    React.createElement(SettingsForm, { key: 'form' }),
  ])
}

function glyph(size: number): ReactElementLike {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    'aria-hidden': 'true',
  }, [
    React.createElement('path', {
      key: 'p',
      d: 'M3 4.2C3 3 4 2 5.2 2h5.6C12 2 13 3 13 4.2v4.1c0 1.2-1 2.2-2.2 2.2H8.4L5.6 13v-2.5H5.2C4 10.5 3 9.5 3 8.3V4.2Z',
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
      const ctxRef = ctx

      ctx.effect?.(() => {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: 'dsh-one-assistant', order: -100, label: '助手',
        }, (props: { size?: number }) => glyph(props?.size ?? 16)))
      }, 'dsh-one: assistant entry')

      ctx.effect?.(() => {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: 'dsh-one-workbench', order: -99, label: '工作台',
        }, (props: { size?: number }) => glyph(props?.size ?? 16)))
      }, 'dsh-one: workbench entry')

      ctx.effect?.(() => {
        slots.inject('main', () => slots.register({
          name: 'main', key: 'dsh-one-assistant',
        }, () => AssistantLauncher({ ctxRef })))
      }, 'dsh-one: assistant panel')

      ctx.effect?.(() => {
        slots.inject('main', () => slots.register({
          name: 'main', key: 'dsh-one-workbench',
        }, () => Workbench({ ctxRef })))
      }, 'dsh-one: workbench panel')

      // Persistent conversation identity: only the assistant Session matches.
      ctx.effect?.(() => {
        slots.inject('conversation.input.dock', () => slots.register({
          name: 'conversation.input.dock', id: 'dsh-one-identity', order: 10,
        }, (props: { session?: { sessionId?: string } }) => IdentityBar({ session: props?.session })))
      }, 'dsh-one: identity dock')

      ctx.effect?.(() => {
        slots.inject('conversation.session.header.actions', () => slots.register({
          name: 'conversation.session.header.actions', id: 'dsh-one-assistant-chip', order: 20,
        }, (props: { session?: { sessionId?: string } }) => AssistantChip({ session: props?.session })))
      }, 'dsh-one: assistant chip')

      ctx.effect?.(() => {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section', id: 'dsh-one', order: 60, label: '助手',
        }, () => SettingsSection()))
      }, 'dsh-one: settings section')
    }

    return { inject, apply }
  },
})
