/**
 * Browser side of dsh-one.
 *
 * The assistant is a real conversation, not a floating widget. This half
 * contributes exactly two seats and no custom chat surface:
 *
 * 1. `sidebar.panellist` — an entry that sits above the workspace list, in the
 *    same list as the shipped Plugins / Schedules icons. DSH owns the row's
 *    click, and it does one thing: `layout.selectPanel(id)`. The matching
 *    `main` panel therefore follows the click and immediately hands control to
 *    the assistant's real DSH session, whose conversation DSH renders itself.
 * 2. `settings.section` — this plugin's own Settings tab, instead of a row
 *    inside somebody else's General page.
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

interface SidebarRightLike {
  openTab(kind: string, options?: Record<string, unknown>): void
}

interface SidebarRightTabsLike {
  register(definition: { readonly id: string; readonly kind: string; readonly title: (address: string) => string }): () => void
}

interface ClientContextLike {
  readonly slots?: SlotRegistryLike
  get?(name: string): unknown
  effect?(callback: () => (() => void) | void, label?: string): unknown
}

interface SettingsView {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly overridden: boolean
  readonly sessionId: string | null
  /** The assistant's own directory; `null` until it is first resolved. */
  readonly home?: string | null
  /** Whether progress narration is muted. */
  readonly notifyMuted?: boolean
  /** The user's behaviour-text override; `null` means the built-in default. */
  readonly persona?: string | null
  /** The built-in behaviour text, shown as the editor's placeholder. */
  readonly defaultPersona?: string
  /** Longest accepted override. */
  readonly personaMaxChars?: number
  readonly runsPaused?: boolean
  readonly quietFrom?: number | null
  readonly quietTo?: number | null
  readonly assistantRunMode?: string
}

interface AssistantView {
  readonly sessionId: string | null
}

interface RunStepLike {
  readonly index: number
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly latestReport?: string
  readonly attention?: string
}

interface RunLike {
  readonly runId: string
  readonly title: string
  readonly goal: string
  readonly status: string
  readonly mode: 'execute' | 'observed'
  readonly paused: boolean
  readonly cwd: string
  readonly progress: { readonly done: number; readonly total: number }
  readonly elapsedMs: number
  readonly attention?: { readonly reason: string }
  readonly verdict?: string
  readonly steps: readonly RunStepLike[]
  readonly updatedAt: number
  readonly terminalAt?: number
}

interface ActivityLike {
  readonly kind: string
  readonly level: string
  readonly title: string
  readonly at: number
  readonly detail?: string
  readonly taskId?: string
}

interface RunSummaryLike {
  readonly generatedAt: number
  readonly assistant: { readonly sessionId: string | null; readonly displayName: string }
  readonly pausedAll?: boolean
  readonly groups: readonly { readonly cwd: string; readonly label: string; readonly runs: readonly RunLike[] }[]
  readonly totals: { readonly active: number; readonly needsYou: number; readonly done: number; readonly failed: number; readonly paused: number }
}

interface RunsState {
  readonly summary?: RunSummaryLike
  readonly error?: string
  readonly loading: boolean
}

interface ResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

interface StyleTagLike {
  readonly dataset: Record<string, string>
  textContent: string
}

declare const window: {
  __ModuleLoader__: {
    load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
}

declare const fetch: (input: string, init?: Record<string, unknown>) => Promise<ResponseLike>

declare const document: {
  querySelector(selector: string): unknown
  createElement(tag: string): StyleTagLike
  readonly head: { appendChild(node: unknown): void }
  readonly visibilityState?: string
}

const NAME_FALLBACK = '鲸宝'
const PANEL_ID = 'dsh-one-assistant'
const STYLE_ID = 'dsh-one-css'
const NAME_MAX_CHARS = 24

function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-one-css="${STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.oneCss = STYLE_ID
  style.textContent = [
    '.one-page{display:flex;flex-direction:column;gap:20px;max-width:560px;padding:8px 0}',
    '.one-page h3{margin:0;font-size:14px;line-height:20px}',
    '.one-page p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
    '.one-field{display:flex;flex-direction:column;gap:8px}',
    '.one-field>label{font-size:13px;font-weight:600}',
    '.one-row{display:flex;align-items:center;gap:8px}',
    '.one-input{flex:1;min-width:0;padding:6px 10px;border-radius:8px;font:inherit;color:inherit;',
    'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,transparent)}',
    '.one-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font:inherit;',
    'font-family:var(--dsw-alias-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;',
    'color:inherit;resize:vertical;border:.5px solid var(--dsw-alias-border-l1);',
    'background:var(--dsw-alias-bg-base,transparent)}',
    '.one-button{padding:6px 12px;border-radius:8px;font:inherit;color:inherit;cursor:pointer;',
    'border:.5px solid var(--dsw-alias-border-l1);background:transparent}',
    '.one-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
    '.one-button:disabled{opacity:.5;cursor:default}',
    '.one-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
    '.one-hint{color:var(--dsw-alias-label-secondary);font-size:12px}',
    '.one-dock{display:flex;flex-direction:column;gap:6px;margin:0 0 6px;padding:8px 10px;border-radius:10px;',
    'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
    '.one-dock-bar{display:flex;align-items:center;gap:8px;min-width:0}',
    // The assistant's persistent identity. It is the one thing that makes the
    // assistant's conversation visibly not an ordinary chat, so it must not
    // depend on a run existing.
    '.one-identity{display:flex;align-items:center;gap:6px;flex:none;min-width:0}',
    '.one-avatar{width:18px;height:18px;border-radius:50%;flex:none;display:flex;align-items:center;',
    'justify-content:center;font-size:10px;font-weight:600;line-height:1;',
    'background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
    '.one-identity-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}',
    '.one-identity-role{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
    '.one-dock-idle{border-style:dashed}',
    '.one-badge-idle{opacity:.75;font-weight:600}',
    '.one-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}',
    '.one-dot-active{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));',
    'animation:one-pulse 1.8s ease-in-out infinite}',
    '.one-dot-attention{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}',
    '.one-dot-error{background:var(--dsw-alias-state-error-primary)}',
    '.one-dot-done,.one-dot-paused{background:var(--dsw-alias-label-secondary)}',
    '.one-dock-text{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.one-dock-text-strong{color:inherit}',
    '.one-dock-actions{display:flex;align-items:center;gap:6px;flex:none}',
    '.one-dock-button{padding:2px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;',
    'color:inherit;font:inherit;font-size:12px;cursor:pointer}',
    '.one-dock-button:hover:not(:disabled){background:var(--dsw-alias-bg-base,transparent)}',
    '.one-dock-button:disabled{opacity:.5;cursor:default}',
    '.one-dock-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
    '.one-run{display:flex;flex-direction:column;gap:3px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l1)}',
    '.one-run-head{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px}',
    '.one-run-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.one-run-meta{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
    '.one-run-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
    '.one-step{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l1)}',
    '.one-step-done{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}',
    '.one-step-active{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));',
    'animation:one-pulse 1.8s ease-in-out infinite}',
    '.one-step-attention{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}',
    '.one-step-error{background:var(--dsw-alias-state-error-primary)}',
    '.one-dock-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
    '.one-badge-attention{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary));border-color:currentColor}',
    '.one-runs-panel{max-width:none;gap:12px}',
    '.one-runs-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.one-runs-title{font-size:13px;font-weight:600}',
    '.one-runs-actions{display:flex;gap:6px}',
    '.one-group{display:flex;flex-direction:column;gap:6px}',
    '.one-group-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.one-group-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
    '.one-run-card{display:flex;flex-direction:column;gap:5px;padding:8px;border-radius:8px;',
    'border:.5px solid var(--dsw-alias-border-l1)}',
    '.one-run-card-head{display:flex;align-items:center;gap:8px;min-width:0}',
    '.one-run-attention{font-size:12px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}',
    '.one-run-actions{display:flex;gap:6px}',
    '.one-activity{display:flex;flex-direction:column;gap:4px;margin:4px 0 0;padding:0;list-style:none}',
    '.one-activity-item{display:flex;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
    '.one-activity-time{flex:none;font-variant-numeric:tabular-nums}',
    '.one-activity-title{color:inherit}',
    '.one-activity-detail{opacity:.8}',
    '.one-activity-error .one-activity-title{color:var(--dsw-alias-state-error-primary)}',
    '.one-activity-attention .one-activity-title{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}',
    '.one-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}',
    '.one-check{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;cursor:pointer}',
    '.one-time{flex:none;width:104px}',
    '@keyframes one-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
    '@media (prefers-reduced-motion: reduce){.one-dot-active,.one-step-active{animation:none}}',
  ].join('')
  document.head.appendChild(style)
}

async function jsonFetch(url: string, init?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(init ?? {}) })
  const value = await response.json()
  if (!response.ok) {
    const carried = typeof value === 'object' && value !== null
      ? (value as { error?: unknown }).error
      : undefined
    throw new Error(typeof carried === 'string' ? carried : `HTTP ${response.status}`)
  }
  return value
}

const readSettings = async (): Promise<SettingsView> => await jsonFetch('/one/api/settings') as SettingsView

/**
 * Resolve the assistant's own session, creating it on first use. The host owns
 * the id, so the conversation is a normal DSH session from the very first turn.
 */
async function ensureAssistant(): Promise<string> {
  const value = await jsonFetch('/one/api/assistant', { method: 'POST' }) as AssistantView
  if (typeof value.sessionId !== 'string' || value.sessionId === '') {
    throw new Error('助手会话没有返回会话 id')
  }
  return value.sessionId
}

/*
 * One shared run snapshot for the dock, the header badge and the side panel.
 * Polling stops when the last surface unmounts and while the page is hidden.
 */
let runsState: RunsState = { loading: true }
const runsListeners = new Set<(state: RunsState) => void>()
let runsTimer: ReturnType<typeof setInterval> | undefined
let runsInflight: Promise<void> | undefined
/** Set by `apply`; the first successful poll registers the right-side tab. */
let panelRegistrar: (() => void) | undefined

function runsNotify(next: Partial<RunsState>): void {
  runsState = { ...runsState, ...next }
  for (const listener of [...runsListeners]) listener(runsState)
}

async function runsRefresh(): Promise<void> {
  if (runsInflight !== undefined) return runsInflight
  runsInflight = (async () => {
    try {
      const summary = await jsonFetch('/one/api/runs') as RunSummaryLike
      runsNotify({ summary, error: undefined, loading: false })
      panelRegistrar?.()
    } catch (error: unknown) {
      runsNotify({ error: String(error), loading: false })
    } finally {
      runsInflight = undefined
    }
  })()
  return runsInflight
}

function runsSubscribe(listener: (state: RunsState) => void): () => void {
  runsListeners.add(listener)
  if (runsTimer === undefined) {
    void runsRefresh()
    runsTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void runsRefresh()
    }, 5_000)
  }
  return () => {
    runsListeners.delete(listener)
    if (runsListeners.size === 0 && runsTimer !== undefined) {
      clearInterval(runsTimer)
      runsTimer = undefined
    }
  }
}

const TERMINAL_RUNS = ['done', 'failed', 'cancelled', 'exhausted']

function visibleRuns(runs: readonly RunLike[]): RunLike[] {
  const cutoff = Date.now() - 10 * 60_000
  return runs.filter(run => !TERMINAL_RUNS.includes(run.status) || run.updatedAt > cutoff)
}

function runDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function runTone(run: RunLike): string {
  if (run.status === 'needs-you') return 'attention'
  if (run.status === 'failed' || run.status === 'exhausted') return 'error'
  if (run.status === 'done') return 'done'
  if (run.paused) return 'paused'
  return 'active'
}

function runStatusLabel(run: RunLike): string {
  if (run.mode === 'observed') return '未执行（observe）'
  if (run.paused) return '已暂停'
  if (run.status === 'needs-you') return '需要你'
  if (run.status === 'done') return '已完成'
  if (run.status === 'failed') return '失败'
  if (run.status === 'exhausted') return '已超时'
  if (run.status === 'cancelled') return '已取消'
  return `${run.progress.done}/${run.progress.total}`
}

function stepTone(status: string): string {
  if (status === 'done') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'error'
  if (status === 'blocked' || status === 'ready') return 'attention'
  if (status === 'assigned' || status === 'running') return 'active'
  return ''
}

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function minuteToTime(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isInteger(value) || value < 0 || value >= 1440) return ''
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function timeToMinute(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hours = Number.parseInt(match[1] ?? '', 10)
  const minutes = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined
  }
  return hours * 60 + minutes
}

async function controlRun(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  await jsonFetch('/one/api/run/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, action }),
  })
  await runsRefresh()
}

window.__ModuleLoader__.load({
  id: 'dsh-one',
  factory(require) {
    const React = require('react') as ReactLike

    /** The chat glyph, inline so the entry needs no asset pipeline. */
    function glyph(size: number): ReactElementLike {
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      }, React.createElement('path', {
        d: 'M2.6 4.1c0-.8.7-1.5 1.5-1.5h7.8c.8 0 1.5.7 1.5 1.5v4.6c0 .8-.7 1.5-1.5 1.5H6.9L3.6 12.9c-.4.3-1 0-1-.5V4.1Z',
        stroke: 'currentColor',
        'stroke-width': '1.2',
        'stroke-linejoin': 'round',
      }))
    }

    /**
     * The `main` panel paired with the sidebar entry.
     *
     * DSH shows this panel the moment the sidebar row is clicked, and this
     * component immediately replaces it: it resolves the assistant's session and
     * calls `openSession`, which navigates to the ordinary conversation view and
     * clears the panel selection. So the body below is only ever the brief
     * "opening" state; the user lands on a real chat.
     */
    function AssistantPanel(props: { readonly ctxRef: ClientContextLike }): ReactElementLike {
      const [error, setError] = React.useState<string | undefined>(undefined)
      const started = React.useRef(false)
      React.useEffect(() => {
        if (started.current) return
        started.current = true
        const uiWorkspace = props.ctxRef.get?.('uiWorkspace') as UiWorkspaceLike | undefined
        if (uiWorkspace === undefined) {
          setError('当前环境没有会话导航服务')
          return
        }
        let cancelled = false
        void (async () => {
          try {
            const sessionId = await ensureAssistant()
            if (cancelled) return
            uiWorkspace.openSession(sessionId)
          } catch (openError: unknown) {
            if (!cancelled) setError(String(openError))
          }
        })()
        return () => { cancelled = true }
      }, [])
      if (error !== undefined) {
        return React.createElement('div', { className: 'one-page' }, [
          React.createElement('h3', { key: 't' }, '无法打开助手会话'),
          React.createElement('div', { key: 'e', className: 'one-error' }, error),
          React.createElement('p', { key: 'h' }, '可以在「设置 → 助手」里查看状态，或检查插件是否正常加载。'),
        ])
      }
      return React.createElement('div', { className: 'one-page' }, [
        React.createElement('p', { key: 'p' }, '正在打开助手会话…'),
      ])
    }

    function useRuns(): RunsState {
      const [state, setState] = React.useState<RunsState>(runsState)
      React.useEffect(() => runsSubscribe(setState), [])
      return state
    }

    /**
     * The assistant's in-chat status strip.
     *
     * It lives above the composer of the assistant's own Session only. It is
     * always present — even with no background work — because the assistant
     * conversation must be visibly its own surface, not an ordinary chat that
     * happens to answer. When runs exist the strip becomes the progress
     * summary; details stay expandable so it does not become a second feed.
     */
    function RunsDock(props: {
      readonly ctxRef: ClientContextLike
      readonly session?: { readonly sessionId?: string }
    }): ReactElementLike | null {
      const state = useRuns()
      const [expanded, setExpanded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState<string | undefined>(undefined)
      const summary = state.summary
      const sessionId = props.session?.sessionId
      if (summary === undefined || summary.assistant.sessionId === null || sessionId !== summary.assistant.sessionId) {
        return null
      }
      const displayName = summary.assistant.displayName.trim() === '' ? '助手' : summary.assistant.displayName
      const initial = [...displayName][0] ?? '助'
      const identity = (key: string): ReactElementLike => React.createElement('span', { key, className: 'one-identity' }, [
        React.createElement('span', { key: 'avatar', className: 'one-avatar', 'aria-hidden': 'true' }, initial),
        React.createElement('span', { key: 'name', className: 'one-identity-name' }, displayName),
        React.createElement('span', { key: 'role', className: 'one-identity-role' }, '常驻助手'),
      ])
      const openPanel = (): void => {
        panelRegistrar?.()
        const sidebarRight = props.ctxRef.get?.('sidebarRight') as SidebarRightLike | undefined
        sidebarRight?.openTab('dsh-one-runs')
      }
      const runs = visibleRuns(summary.groups.flatMap(group => group.runs))
      if (runs.length === 0) {
        return React.createElement('div', {
          className: 'one-dock one-dock-idle',
          role: 'status',
          'aria-live': 'polite',
        }, [
          React.createElement('div', { key: 'bar', className: 'one-dock-bar' }, [
            identity('identity'),
            React.createElement('span', { key: 'text', className: 'one-dock-text' },
              '待命 · 告诉我目标，我会拆成任务并持续推进'),
            React.createElement('span', { key: 'actions', className: 'one-dock-actions' }, [
              React.createElement('button', {
                key: 'panel',
                type: 'button',
                className: 'one-dock-button',
                onClick: openPanel,
              }, '后台'),
            ]),
          ]),
          ...(state.error === undefined ? [] : [React.createElement('div', { key: 'error', className: 'one-dock-error' }, state.error)]),
        ])
      }
      const needsYou = runs.filter(run => run.status === 'needs-you').length
      const active = runs.filter(run => run.status === 'active' && !run.paused).length
      const paused = runs.filter(run => run.paused).length
      const failed = runs.filter(run => run.status === 'failed' || run.status === 'exhausted').length
      const done = runs.filter(run => run.status === 'done').length
      const doneSteps = runs.reduce((sum, run) => sum + run.progress.done, 0)
      const totalSteps = runs.reduce((sum, run) => sum + run.progress.total, 0)
      const primary = runs[0] as RunLike
      const tone = needsYou > 0 ? 'attention' : failed > 0 ? 'error' : active > 0 ? 'active' : primary.paused ? 'paused' : 'done'
      const text = needsYou > 0
        ? `需要你决定 · ${needsYou} 个目标`
        : active > 0
          ? `后台推进中 · ${doneSteps}/${totalSteps} · ${runDuration(primary.elapsedMs)}`
          : paused > 0
            ? `已暂停 · ${paused} 个目标`
            : failed > 0
              ? `有目标失败 · ${failed}`
              : `最近完成 · ${done}`

      const act = async (run: RunLike, action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
        setBusy(true)
        setError(undefined)
        try {
          await controlRun(run.runId, action)
        } catch (controlError: unknown) {
          setError(String(controlError))
        } finally {
          setBusy(false)
        }
      }

      const primaryAction = primary.paused ? 'resume' : primary.status === 'active' || primary.status === 'needs-you' ? 'pause' : undefined
      const actions = [
        ...(primaryAction === undefined ? [] : [React.createElement('button', {
          key: 'p',
          type: 'button',
          className: 'one-dock-button',
          disabled: busy,
          'aria-label': primaryAction === 'pause' ? '暂停这个目标' : '继续这个目标',
          onClick: () => { void act(primary, primaryAction) },
        }, primaryAction === 'pause' ? '暂停' : '继续')]),
        React.createElement('button', {
          key: 'e',
          type: 'button',
          className: 'one-dock-button',
          'aria-expanded': expanded,
          onClick: () => setExpanded(!expanded),
        }, expanded ? '收起' : '展开'),
      ]

      return React.createElement('div', {
        className: 'one-dock',
        role: 'status',
        'aria-live': needsYou > 0 ? 'assertive' : 'polite',
      }, [
        React.createElement('div', { key: 'bar', className: 'one-dock-bar' }, [
          identity('identity'),
          React.createElement('span', { key: 'dot', className: `one-dot one-dot-${tone}`, 'aria-hidden': 'true' }),
          React.createElement('span', {
            key: 'text',
            className: `one-dock-text${needsYou > 0 ? ' one-dock-text-strong' : ''}`,
          }, text),
          React.createElement('span', { key: 'actions', className: 'one-dock-actions' }, actions),
        ]),
        ...(expanded ? [React.createElement('ul', { key: 'list', className: 'one-dock-list' },
          runs.slice(0, 6).map(run => React.createElement('li', { key: run.runId, className: 'one-run' }, [
            React.createElement('div', { key: 'head', className: 'one-run-head' }, [
              React.createElement('span', {
                key: 'dot',
                className: `one-dot one-dot-${runTone(run)}`,
                'aria-hidden': 'true',
              }),
              React.createElement('span', { key: 'title', className: 'one-run-title', title: run.goal }, run.title),
              React.createElement('span', { key: 'meta', className: 'one-run-meta' }, runStatusLabel(run)),
              React.createElement('button', {
                key: 'pause',
                type: 'button',
                className: 'one-dock-button',
                disabled: busy || TERMINAL_RUNS.includes(run.status),
                onClick: () => { void act(run, run.paused ? 'resume' : 'pause') },
              }, run.paused ? '继续' : '暂停'),
              React.createElement('button', {
                key: 'cancel',
                type: 'button',
                className: 'one-dock-button',
                disabled: busy || TERMINAL_RUNS.includes(run.status),
                'aria-label': `取消 ${run.title}`,
                onClick: () => { void act(run, 'cancel') },
              }, '取消'),
            ]),
            React.createElement('div', { key: 'steps', className: 'one-run-steps' },
              run.steps.map(step => React.createElement('span', {
                key: step.taskId,
                className: `one-step ${stepTone(step.status) === '' ? '' : `one-step-${stepTone(step.status)}`}`.trim(),
                title: `${step.title} · ${step.status}${step.latestReport === undefined ? '' : ` · ${step.latestReport}`}`,
              }))),
          ]))),
        ] : []),
        ...(error === undefined && state.error === undefined
          ? []
          : [React.createElement('div', { key: 'error', className: 'one-dock-error' }, error ?? state.error)]),
      ])
    }

    /** The header badge that opens the background panel. */
    function RunsBadge(props: {
      readonly ctxRef: ClientContextLike
      readonly session?: { readonly sessionId?: string }
    }): ReactElementLike | null {
      const state = useRuns()
      const summary = state.summary
      const uiSession = props.ctxRef.get?.('uiSession') as UiSessionLike | undefined
      const sidebarRight = props.ctxRef.get?.('sidebarRight') as SidebarRightLike | undefined
      if (summary === undefined || summary.assistant.sessionId === null) return null
      const sessionId = props.session?.sessionId
        ?? (props as { readonly sessionId?: string }).sessionId
        ?? uiSession?.sessionId
      // Some header hosts pass no session identity; show the global background
      // chip there rather than hiding the only entry to the panel.
      if (sessionId !== undefined && sessionId !== summary.assistant.sessionId) return null
      const displayName = summary.assistant.displayName.trim() === '' ? '助手' : summary.assistant.displayName
      const runs = visibleRuns(summary.groups.flatMap(group => group.runs))
      if (runs.length === 0) {
        // The header chip is the second half of the assistant's always-on
        // identity: even a quiet assistant conversation is labeled as such.
        return React.createElement('button', {
          type: 'button',
          className: 'one-dock-button one-badge-idle',
          disabled: sidebarRight === undefined,
          'aria-label': `${displayName} 是常驻助手，打开后台面板`,
          onClick: () => {
            panelRegistrar?.()
            sidebarRight?.openTab('dsh-one-runs')
          },
        }, '助手')
      }
      const needsYou = runs.filter(run => run.status === 'needs-you').length
      const active = runs.filter(run => run.status === 'active' && !run.paused).length
      return React.createElement('button', {
        type: 'button',
        className: `one-dock-button${needsYou > 0 ? ' one-badge-attention' : ''}`,
        disabled: sidebarRight === undefined,
        'aria-label': needsYou > 0 ? `后台有 ${needsYou} 个目标需要你决定` : `后台有 ${active} 个目标在推进`,
        onClick: () => {
          panelRegistrar?.()
          sidebarRight?.openTab('dsh-one-runs')
        },
      }, needsYou > 0 ? `需要你 ${needsYou}` : `后台 ${active}`)
    }

    /** The right-side "background" panel: read and control, never a second chat. */
    function RunsPanel(props: { readonly ctxRef: ClientContextLike }): ReactElementLike {
      const state = useRuns()
      const [notice, setNotice] = React.useState<string | undefined>(undefined)
      const summary = state.summary
      if (summary === undefined) {
        return React.createElement('div', { className: 'one-page one-runs-panel' }, [
          React.createElement('div', { key: 'title', className: 'one-runs-title' }, '后台'),
          React.createElement('p', { key: 'p' },
            state.error === undefined ? '正在读取后台任务…' : `无法读取后台任务：${state.error}`),
        ])
      }
      const runs = summary.groups.flatMap(group => group.runs)
      const toggleAll = async (): Promise<void> => {
        setNotice(undefined)
        try {
          await jsonFetch('/one/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runsPaused: !(summary.pausedAll === true) }),
          })
          await runsRefresh()
        } catch (error: unknown) {
          setNotice(String(error))
        }
      }
      const openConversation = (): void => {
        const uiWorkspace = props.ctxRef.get?.('uiWorkspace') as UiWorkspaceLike | undefined
        if (summary.assistant.sessionId !== null) uiWorkspace?.openSession(summary.assistant.sessionId)
      }
      return React.createElement('div', { className: 'one-page one-runs-panel' }, [
        React.createElement('div', { key: 'head', className: 'one-runs-head' }, [
          React.createElement('div', { key: 't', className: 'one-runs-title' }, '后台'),
          React.createElement('div', { key: 'a', className: 'one-runs-actions' }, [
            React.createElement('button', {
              key: 'pause',
              type: 'button',
              className: 'one-dock-button',
              onClick: () => { void toggleAll() },
            }, summary.pausedAll === true ? '恢复全部' : '全部暂停'),
            React.createElement('button', {
              key: 'open',
              type: 'button',
              className: 'one-dock-button',
              disabled: summary.assistant.sessionId === null,
              onClick: openConversation,
            }, '打开对话'),
          ]),
        ]),
        React.createElement('p', { key: 'hint', className: 'one-hint' },
          `${summary.assistant.displayName} 在后台推进；只在需要你决定、完成或失败时开口。`),
        ...(runs.length === 0
          ? [React.createElement('p', { key: 'empty', className: 'one-empty' },
            '还没有后台任务。在对话里告诉我目标，我会拆成任务并持续跟进。')]
          : summary.groups.map(group => React.createElement('section', { key: group.cwd, className: 'one-group' }, [
            React.createElement('h4', { key: 't', className: 'one-group-title', title: group.cwd }, group.label),
            React.createElement('ul', { key: 'l', className: 'one-group-list' },
              group.runs.map(run => React.createElement(RunCard, {
                key: run.runId,
                run,
                pausedAll: summary.pausedAll === true,
                onChanged: () => { void runsRefresh() },
              }))),
          ]))),
        ...(notice === undefined ? [] : [React.createElement('div', { key: 'n', className: 'one-error' }, notice)]),
      ])
    }

    function RunCard(props: {
      readonly run: RunLike
      readonly pausedAll: boolean
      readonly onChanged: () => void
    }): ReactElementLike {
      const [expanded, setExpanded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState<string | undefined>(undefined)
      const run = props.run
      const terminal = TERMINAL_RUNS.includes(run.status)
      const act = async (action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
        setBusy(true)
        setError(undefined)
        try {
          await controlRun(run.runId, action)
          props.onChanged()
        } catch (controlError: unknown) {
          setError(String(controlError))
        } finally {
          setBusy(false)
        }
      }
      return React.createElement('li', { className: 'one-run-card' }, [
        React.createElement('div', { key: 'head', className: 'one-run-card-head' }, [
          React.createElement('span', { key: 'dot', className: `one-dot one-dot-${runTone(run)}`, 'aria-hidden': 'true' }),
          React.createElement('span', { key: 'title', className: 'one-run-title', title: run.goal }, run.title),
          React.createElement('span', { key: 'status', className: 'one-run-meta' }, runStatusLabel(run)),
        ]),
        React.createElement('div', { key: 'meta', className: 'one-run-meta' },
          `${run.cwd} · ${run.progress.done}/${run.progress.total} · ${runDuration(run.elapsedMs)}`),
        ...(run.attention === undefined
          ? []
          : [React.createElement('div', { key: 'att', className: 'one-run-attention' }, run.attention.reason)]),
        React.createElement('div', { key: 'steps', className: 'one-run-steps' },
          run.steps.map(step => React.createElement('span', {
            key: step.taskId,
            className: `one-step ${stepTone(step.status) === '' ? '' : `one-step-${stepTone(step.status)}`}`.trim(),
            title: `${step.title} · ${step.status}${step.latestReport === undefined ? '' : ` · ${step.latestReport}`}`,
          }))),
        React.createElement('div', { key: 'actions', className: 'one-run-actions' }, [
          React.createElement('button', {
            key: 'pause',
            type: 'button',
            className: 'one-dock-button',
            disabled: busy || terminal || props.pausedAll,
            onClick: () => { void act(run.paused ? 'resume' : 'pause') },
          }, run.paused ? '继续' : '暂停'),
          React.createElement('button', {
            key: 'cancel',
            type: 'button',
            className: 'one-dock-button',
            disabled: busy || terminal,
            onClick: () => { void act('cancel') },
          }, '取消'),
          React.createElement('button', {
            key: 'activity',
            type: 'button',
            className: 'one-dock-button',
            'aria-expanded': expanded,
            onClick: () => setExpanded(!expanded),
          }, expanded ? '收起活动' : '活动'),
        ]),
        ...(expanded ? [React.createElement(RunActivity, { key: 'activity', runId: run.runId })] : []),
        ...(error === undefined ? [] : [React.createElement('div', { key: 'error', className: 'one-error' }, error)]),
      ])
    }

    function RunActivity(props: { readonly runId: string }): ReactElementLike {
      const [items, setItems] = React.useState<readonly ActivityLike[] | undefined>(undefined)
      const [error, setError] = React.useState<string | undefined>(undefined)
      React.useEffect(() => {
        let alive = true
        void jsonFetch(`/one/api/run?id=${encodeURIComponent(props.runId)}`).then((value: unknown) => {
          if (!alive) return
          const record = value as { activities?: readonly ActivityLike[] }
          setItems(record.activities ?? [])
        }).catch((loadError: unknown) => {
          if (alive) setError(String(loadError))
        })
        return () => { alive = false }
      }, [props.runId])
      if (error !== undefined) return React.createElement('div', { className: 'one-error' }, error)
      if (items === undefined) return React.createElement('p', { className: 'one-hint' }, '正在读取活动…')
      if (items.length === 0) return React.createElement('p', { className: 'one-hint' }, '还没有活动记录。')
      return React.createElement('ul', { className: 'one-activity' },
        items.slice(0, 20).map(item => React.createElement('li', {
          key: `${item.at}:${item.title}`,
          className: `one-activity-item one-activity-${item.level}`,
        }, [
          React.createElement('span', { key: 't', className: 'one-activity-time' }, clock(item.at)),
          React.createElement('span', { key: 'x', className: 'one-activity-title' }, item.title),
          ...(item.detail === undefined
            ? []
            : [React.createElement('span', { key: 'd', className: 'one-activity-detail' }, item.detail)]),
        ])))
    }

    /** This plugin's own Settings tab. */
    function SettingsSection(): ReactElementLike {
      const [view, setView] = React.useState<SettingsView | undefined>(undefined)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState<string | undefined>(undefined)
      const [notice, setNotice] = React.useState<string | undefined>(undefined)
      const [personaDraft, setPersonaDraft] = React.useState('')
      const [muteDraft, setMuteDraft] = React.useState(false)
      const [pausedDraft, setPausedDraft] = React.useState(false)
      const [quietFromDraft, setQuietFromDraft] = React.useState('')
      const [quietToDraft, setQuietToDraft] = React.useState('')

      const apply = (next: SettingsView): void => {
        setView(next)
        setDraft(next.displayName)
        setPersonaDraft(next.persona ?? next.defaultPersona ?? '')
        setMuteDraft(next.notifyMuted === true)
        setPausedDraft(next.runsPaused === true)
        setQuietFromDraft(minuteToTime(next.quietFrom))
        setQuietToDraft(minuteToTime(next.quietTo))
        setError(undefined)
      }

      React.useEffect(() => {
        let alive = true
        void readSettings().then(value => {
          if (!alive) return
          apply(value)
        }).catch((loadError: unknown) => {
          if (alive) setError(String(loadError))
        })
        return () => { alive = false }
      }, [])

      const saveFlags = async (body: Record<string, unknown>, noticeText: string): Promise<void> => {
        setBusy(true)
        setNotice(undefined)
        try {
          apply(await jsonFetch('/one/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }) as SettingsView)
          setNotice(noticeText)
        } catch (saveError: unknown) {
          setError(String(saveError))
        } finally {
          setBusy(false)
        }
      }

      const saveQuiet = async (): Promise<void> => {
        const from = timeToMinute(quietFromDraft)
        const to = timeToMinute(quietToDraft)
        if ((from === undefined) !== (to === undefined)) {
          setError('安静时段需要同时填写开始和结束，或都清空')
          return
        }
        await saveFlags(
          { quietFrom: from ?? null, quietTo: to ?? null },
          from === undefined ? '已关闭安静时段' : '安静时段已保存',
        )
      }

      const clearQuiet = async (): Promise<void> => {
        setQuietFromDraft('')
        setQuietToDraft('')
        await saveFlags({ quietFrom: null, quietTo: null }, '已关闭安静时段')
      }

      const savePersona = async (): Promise<void> => {
        setBusy(true)
        setNotice(undefined)
        try {
          apply(await jsonFetch('/one/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ persona: personaDraft }),
          }) as SettingsView)
          setNotice('提示词已保存，下一句对话生效')
        } catch (saveError: unknown) {
          setError(String(saveError))
        } finally {
          setBusy(false)
        }
      }

      const resetPersona = async (): Promise<void> => {
        setBusy(true)
        setNotice(undefined)
        try {
          apply(await jsonFetch('/one/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ resetPersona: true }),
          }) as SettingsView)
          setNotice('已恢复默认提示词')
        } catch (resetError: unknown) {
          setError(String(resetError))
        } finally {
          setBusy(false)
        }
      }

      const save = async (): Promise<void> => {
        setBusy(true)
        setNotice(undefined)
        try {
          apply(await jsonFetch('/one/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName: draft }),
          }) as SettingsView)
          setNotice('已保存')
        } catch (saveError: unknown) {
          setError(String(saveError))
        } finally {
          setBusy(false)
        }
      }

      const reset = async (): Promise<void> => {
        setBusy(true)
        setNotice(undefined)
        try {
          apply(await jsonFetch('/one/api/settings', { method: 'DELETE' }) as SettingsView)
          setNotice('已恢复默认名称')
        } catch (resetError: unknown) {
          setError(String(resetError))
        } finally {
          setBusy(false)
        }
      }

      const unchanged = view !== undefined && draft.trim() === view.displayName
      const fallback = view?.defaultDisplayName ?? NAME_FALLBACK
      const hasSession = typeof view?.sessionId === 'string' && view.sessionId !== ''

      return React.createElement('div', { className: 'one-page' }, [
        React.createElement('div', { key: 'name', className: 'one-field' }, [
          React.createElement('label', { key: 'l', htmlFor: 'dsh-one-name' }, '名字'),
          React.createElement('p', { key: 'd' },
            `显示在左侧入口上。默认：${fallback}${view?.overridden === true ? '（当前为自定义）' : ''}`),
          React.createElement('div', { key: 'r', className: 'one-row' }, [
            React.createElement('input', {
              key: 'i',
              id: 'dsh-one-name',
              className: 'one-input',
              value: draft,
              maxLength: NAME_MAX_CHARS,
              placeholder: fallback,
              disabled: busy || view === undefined,
              onChange: (event: { target?: { value?: string } }) => {
                setDraft(event.target?.value ?? '')
                setNotice(undefined)
              },
              onKeyDown: (event: { key?: string }) => {
                if (event.key === 'Enter' && !unchanged && draft.trim() !== '') void save()
              },
            }),
            React.createElement('button', {
              key: 's',
              type: 'button',
              className: 'one-button',
              disabled: busy || unchanged || draft.trim() === '',
              onClick: () => { void save() },
            }, busy ? '保存中…' : '保存'),
            React.createElement('button', {
              key: 'x',
              type: 'button',
              className: 'one-button',
              disabled: busy || view?.overridden !== true,
              onClick: () => { void reset() },
            }, '恢复默认'),
          ]),
        ]),
        React.createElement('div', { key: 'sess', className: 'one-field' }, [
          React.createElement('label', { key: 'l' }, '助手会话'),
          React.createElement('p', { key: 'd' },
            '助手运行在一个独立的真实会话里，因此它拥有自己的上下文与历史记录，'
            + '并且可以像任何会话一样跨工作区工作。'),
          React.createElement('p', { key: 'u' },
            hasSession ? '助手会话已创建，可直接从左侧入口打开。' : '助手会话会在你第一次点开入口时自动创建。'),
        ]),
        React.createElement('div', { key: 'persona', className: 'one-field' }, [
          React.createElement('label', { key: 'l', htmlFor: 'dsh-one-persona' }, '助手提示词'),
          React.createElement('p', { key: 'd' },
            '决定助手怎么工作、什么时候开口。保存后下一句话就生效，不用重开会话。'
            + '身份与安全边界固定保留，不在这段文字里。'),
          React.createElement('textarea', {
            key: 't',
            id: 'dsh-one-persona',
            className: 'one-textarea',
            rows: 14,
            value: personaDraft,
            maxLength: view?.personaMaxChars ?? 8000,
            placeholder: view?.defaultPersona ?? '',
            disabled: busy || view === undefined,
            onChange: (event: { target?: { value?: string } }) => {
              setPersonaDraft(event.target?.value ?? '')
              setNotice(undefined)
            },
          }),
          React.createElement('div', { key: 'r', className: 'one-row' }, [
            React.createElement('button', {
              key: 's',
              type: 'button',
              className: 'one-button',
              disabled: busy || personaDraft.trim() === '',
              onClick: () => { void savePersona() },
            }, busy ? '保存中…' : '保存提示词'),
            React.createElement('button', {
              key: 'x',
              type: 'button',
              className: 'one-button',
              disabled: busy || view?.persona == null,
              onClick: () => { void resetPersona() },
            }, '恢复默认提示词'),
          ]),
        ]),
        React.createElement('div', { key: 'home', className: 'one-field' }, [
          React.createElement('label', { key: 'l' }, '助手工作区'),
          React.createElement('p', { key: 'd' },
            '助手有自己固定的目录，所以点开它就是一次普通对话，不会让你挑工作区。'),
          React.createElement('p', { key: 'u' }, view?.home ?? '首次打开时自动创建。'),
        ]),
        React.createElement('div', { key: 'notify', className: 'one-field' }, [
          React.createElement('label', { key: 'l' }, '汇报与节奏'),
          React.createElement('p', { key: 'd' },
            '助手只在三种时候开口：计划完成、需要你决定、执行失败。'
            + '其余进度只写进任务记录，不打扰你。'),
          React.createElement('label', { key: 'mute', className: 'one-check' }, [
            React.createElement('input', {
              key: 'i',
              type: 'checkbox',
              checked: muteDraft,
              disabled: busy || view === undefined,
              onChange: (event: { target?: { checked?: boolean } }) => {
                const next = event.target?.checked === true
                setMuteDraft(next)
                void saveFlags({ notifyMuted: next }, next
                  ? '已静默进度，保留「需要你」和「失败」'
                  : '完成时也会提醒')
              },
            }),
            React.createElement('span', { key: 't' }, '静默进度（仍保留「需要你决定」和「失败」）'),
          ]),
          React.createElement('label', { key: 'paused', className: 'one-check' }, [
            React.createElement('input', {
              key: 'i',
              type: 'checkbox',
              checked: pausedDraft,
              disabled: busy || view === undefined,
              onChange: (event: { target?: { checked?: boolean } }) => {
                const next = event.target?.checked === true
                setPausedDraft(next)
                void saveFlags({ runsPaused: next }, next ? '已暂停全部后台推进' : '已恢复后台推进')
              },
            }),
            React.createElement('span', { key: 't' }, '全部暂停后台推进（不取消正在运行的任务）'),
          ]),
          React.createElement('div', { key: 'quiet', className: 'one-row' }, [
            React.createElement('input', {
              key: 'f',
              className: 'one-input one-time',
              type: 'time',
              value: quietFromDraft,
              disabled: busy || view === undefined,
              onChange: (event: { target?: { value?: string } }) => { setQuietFromDraft(event.target?.value ?? '') },
            }),
            React.createElement('span', { key: 's', className: 'one-hint' }, '至'),
            React.createElement('input', {
              key: 't',
              className: 'one-input one-time',
              type: 'time',
              value: quietToDraft,
              disabled: busy || view === undefined,
              onChange: (event: { target?: { value?: string } }) => { setQuietToDraft(event.target?.value ?? '') },
            }),
            React.createElement('button', {
              key: 'save',
              type: 'button',
              className: 'one-button',
              disabled: busy || view === undefined,
              onClick: () => { void saveQuiet() },
            }, '保存安静时段'),
            React.createElement('button', {
              key: 'clear',
              type: 'button',
              className: 'one-button',
              disabled: busy || view === undefined,
              onClick: () => { void clearQuiet() },
            }, '清除'),
          ]),
          React.createElement('p', { key: 'mode', className: 'one-hint' },
            view?.assistantRunMode === 'execute'
              ? '运行模式：助手目标会执行。'
              : view?.assistantRunMode === 'observe'
                ? '运行模式：只记录计划（observe），不派发任务。'
                : '运行模式：任务运行时未加载。'),
        ]),
        ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
        ...(notice === undefined ? [] : [React.createElement('div', { key: 'n', className: 'one-hint' }, notice)]),
      ])
    }

    const inject = ['slots']

    /**
     * The entry's nav label.
     *
     * `sidebar.panellist` accepts a thunk and re-reads it on every projection,
     * so the sidebar follows a rename without re-registering the slot. The
     * cached value keeps the synchronous thunk from flickering while the next
     * read is in flight.
     */
    let labelCache = NAME_FALLBACK
    let labelPending: Promise<void> | undefined
    function labelThunk(): string {
      if (labelPending === undefined) {
        labelPending = readSettings().then(value => {
          if (typeof value.displayName === 'string' && value.displayName !== '') {
            labelCache = value.displayName
          }
        }).catch(() => {
          // A failed read leaves the last known label in place.
        }).finally(() => { labelPending = undefined })
      }
      return labelCache
    }

    function apply(ctx: ClientContextLike): void {
      ensureStyle()
      const slots = ctx.slots
      if (slots === undefined) return
      const ctxRef = ctx

      // The above-workspaces entry. `sidebar.panellist` sorts by `order` and the
      // shipped icons start at 0, so a negative order keeps the assistant first.
      ctx.effect?.(() => {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: -100,
          label: labelThunk,
        }, (props: { size?: number }) => glyph(props?.size ?? 16)))
      }, 'dsh-one: sidebar entry')

      // Its paired central panel. DSH dispatches `selectPanel(id)` on click and
      // renders this key, which then navigates to the real conversation.
      ctx.effect?.(() => {
        slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => AssistantPanel({ ctxRef })))
      }, 'dsh-one: assistant panel')

      // The assistant's in-chat status strip. It renders only in that Session.
      ctx.effect?.(() => {
        slots.inject('conversation.input.dock', () => slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-one-runs',
          order: 10,
        }, (props: { session?: { sessionId?: string } }) => RunsDock({ ctxRef, session: props?.session })))
      }, 'dsh-one: run dock')

      // The badge is a status chip; its click is enabled only when a right panel
      // service is present, so it can register before that service arrives.
      ctx.effect?.(() => {
        slots.inject('conversation.session.header.actions', () => slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-one-runs',
          order: 20,
        }, (props: { session?: { sessionId?: string } }) => RunsBadge({ ctxRef, session: props?.session })))
      }, 'dsh-one: run badge')

      // The right-sidebar plugin may apply after this one, so register its tab
      // on the first successful poll (or the first badge click) instead of at
      // apply time. `panelRegistrar` is called by `runsRefresh`.
      let panelRegistered = false
      const ensurePanel = (): void => {
        if (panelRegistered) return
        const tabs = ctx.get?.('sidebarRightTabs') as SidebarRightTabsLike | undefined
        if (tabs === undefined) return
        panelRegistered = true
        ctx.effect?.(() => {
          const disposeType = tabs.register({
            id: 'dsh-one-runs',
            kind: 'dsh-one-runs',
            title: () => '后台',
          })
          const disposeBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'dsh-one-runs',
          }, () => RunsPanel({ ctxRef })))
          return () => {
            panelRegistered = false
            if (typeof disposeBody === 'function') (disposeBody as () => void)()
            disposeType()
          }
        }, 'dsh-one: runs panel')
      }
      panelRegistrar = ensurePanel
      ensurePanel()

      // A dedicated Settings tab, not a row on somebody else's page.
      ctx.effect?.(() => {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'dsh-one',
          order: 60,
          label: '助手',
        }, () => SettingsSection()))
      }, 'dsh-one: settings section')
    }

    return { inject, apply }
  },
})
