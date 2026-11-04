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
}

interface AssistantView {
  readonly sessionId: string | null
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

    /** This plugin's own Settings tab. */
    function SettingsSection(): ReactElementLike {
      const [view, setView] = React.useState<SettingsView | undefined>(undefined)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState<string | undefined>(undefined)
      const [notice, setNotice] = React.useState<string | undefined>(undefined)
      const [personaDraft, setPersonaDraft] = React.useState('')

      React.useEffect(() => {
        let alive = true
        void readSettings().then(value => {
          if (!alive) return
          setView(value)
          setDraft(value.displayName)
          setPersonaDraft(value.persona ?? value.defaultPersona ?? '')
        }).catch((loadError: unknown) => {
          if (alive) setError(String(loadError))
        })
        return () => { alive = false }
      }, [])

      const apply = (next: SettingsView): void => {
        setView(next)
        setDraft(next.displayName)
        setPersonaDraft(next.persona ?? next.defaultPersona ?? '')
        setError(undefined)
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
        React.createElement('div', { key: 'mute', className: 'one-field' }, [
          React.createElement('label', { key: 'l' }, '汇报方式'),
          React.createElement('p', { key: 'd' },
            '助手只在三种时候开口：计划完成、需要你决定、执行失败。'
            + '其余进度只写进任务记录，不打扰你。'),
          React.createElement('p', { key: 'u' },
            view?.notifyMuted === true
              ? '当前：静默进度，仅保留「需要你决定」和「失败」提醒。'
              : '当前：计划完成时也会提醒。'),
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
