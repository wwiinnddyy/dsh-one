/**
 * Browser side of dsh-one: one floating panel that reads `/one/api/overview`.
 * Written against the DSH client module closure-factory protocol; React is
 * resolved through the platform module table.
 */

interface ReactElementLike {
  readonly type: unknown
  readonly props: unknown
}

interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElementLike
  useState<T>(initial: T): [T, (next: T) => void]
  useEffect(run: () => void | (() => void), deps?: readonly unknown[]): void
}

interface SlotRegistryLike {
  inject(name: string, callback: () => () => void): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ClientContextLike {
  readonly slots?: SlotRegistryLike
  effect?(callback: () => (() => void) | void, label?: string): unknown
}

interface OverviewItem {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly detail?: string
  readonly updatedAt: number
}

interface Overview {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly attention: readonly OverviewItem[]
  readonly running: readonly OverviewItem[]
  readonly history: readonly OverviewItem[]
  readonly health: {
    readonly storage: string
    readonly core: string
    readonly delegate: string
    readonly ingress: string
    readonly policyVersion?: string
    readonly leases: number
    readonly workers: number
    readonly maxWorkers: number
    readonly lastError?: string
  }
}

declare const window: {
  __ModuleLoader__: {
    load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
}

interface StyleTagLike {
  readonly dataset: Record<string, string>
  textContent: string
}

interface DocumentLike {
  querySelector(selector: string): unknown
  createElement(tag: string): StyleTagLike
  readonly head: { appendChild(node: unknown): void }
}

declare const document: DocumentLike

window.__ModuleLoader__.load({
  id: '@wwiinnddyy/dsh-one',
  factory(require) {
    const React = require('react') as ReactLike

    function ensureStyle(): void {
      const id = 'dsh-one-panel-css'
      if (typeof document === 'undefined' || document.querySelector(`style[data-one-css="${id}"]`) !== null) return
      const style = document.createElement('style')
      style.dataset.oneCss = id
      style.textContent = [
        '.one-pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:1px solid var(--dsh-border,#8884);',
        'background:var(--dsh-bg,#111);color:inherit;border-radius:10px;padding:8px 12px;font:600 12px/1.2 system-ui;',
        'cursor:pointer;box-shadow:0 6px 24px #0004}',
        '.one-panel{position:fixed;right:16px;bottom:60px;z-index:2147483000;width:min(420px,calc(100vw - 32px));',
        'max-height:min(70vh,560px);overflow:auto;border:1px solid var(--dsh-border,#8884);border-radius:12px;',
        'background:var(--dsh-bg,#111);color:inherit;font:13px/1.45 system-ui;box-shadow:0 12px 40px #0006}',
        '.one-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--dsh-border,#8884)}',
        '.one-head h3{margin:0;font-size:13px}',
        '.one-body{padding:10px 12px}',
        '.one-sec{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin:10px 0 6px}',
        '.one-row{display:flex;gap:8px;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--dsh-border,#8882)}',
        '.one-row:last-child{border-bottom:0}',
        '.one-row b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.one-row span{opacity:.7;white-space:nowrap}',
        '.one-health{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px;opacity:.8}',
        '.one-empty{opacity:.7;padding:8px 0}',
        '.one-err{color:#e66;padding:8px 0}',
        '.one-set{display:flex;flex-direction:column;gap:8px;padding:2px 0}',
        '.one-set label{font-weight:600}',
        '.one-set p{margin:0;font-size:12px;opacity:.7}',
        '.one-set-row{display:flex;gap:8px;align-items:center}',
        '.one-set input{flex:1;min-width:0;padding:6px 8px;border-radius:8px;',
        'border:1px solid var(--dsh-border,#8884);background:var(--dsh-bg,#111);color:inherit;font:inherit}',
        '.one-set button{padding:6px 10px;border-radius:8px;border:1px solid var(--dsh-border,#8884);',
        'background:transparent;color:inherit;font:inherit;cursor:pointer}',
        '.one-set button:disabled{opacity:.5;cursor:default}',
      ].join('')
      document.head.appendChild(style)
    }

    function itemRow(item: OverviewItem): ReactElementLike {
      return React.createElement('div', { key: item.id, className: 'one-row' }, [
        React.createElement('b', { key: 't', title: item.detail ?? item.title }, item.title),
        React.createElement('span', { key: 's' }, item.status),
      ])
    }

    function section(title: string, items: readonly OverviewItem[]): ReactElementLike {
      return React.createElement('div', { key: title }, [
        React.createElement('div', { key: 'h', className: 'one-sec' }, `${title} · ${items.length}`),
        ...(items.length === 0
          ? [React.createElement('div', { key: 'e', className: 'one-empty' }, 'None')]
          : items.slice(0, 12).map(itemRow)),
      ])
    }

    interface SettingsView {
      readonly displayName: string
      readonly defaultDisplayName: string
      readonly overridden: boolean
    }

    /** One-shot settings read; the settings row owns its own refresh. */
    async function readSettings(): Promise<SettingsView> {
      const response = await fetch('/one/api/settings', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as SettingsView
    }

    async function writeSettings(method: 'PUT' | 'DELETE', displayName?: string): Promise<SettingsView> {
      const response = await fetch('/one/api/settings', {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(method === 'PUT'
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) }
          : {}),
      })
      const value = await response.json() as SettingsView & { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      return value
    }

    /**
     * The General-settings row. The row owns its copy, current value, and write
     * path, because the settings shell projects no props into it.
     */
    function NameRow(): ReactElementLike {
      const [view, setView] = React.useState<SettingsView | undefined>(undefined)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState<string | undefined>(undefined)
      React.useEffect(() => {
        let alive = true
        void readSettings().then(value => {
          if (!alive) return
          setView(value)
          setDraft(value.displayName)
        }).catch((loadError: unknown) => {
          if (alive) setError(String(loadError))
        })
        return () => { alive = false }
      }, [])
      const apply = (next: SettingsView): void => {
        setView(next)
        setDraft(next.displayName)
        setError(undefined)
      }
      const save = async (): Promise<void> => {
        setBusy(true)
        try {
          apply(await writeSettings('PUT', draft))
        } catch (saveError: unknown) {
          setError(String(saveError))
        } finally {
          setBusy(false)
        }
      }
      const reset = async (): Promise<void> => {
        setBusy(true)
        try {
          apply(await writeSettings('DELETE'))
        } catch (resetError: unknown) {
          setError(String(resetError))
        } finally {
          setBusy(false)
        }
      }
      const unchanged = view !== undefined && draft.trim() === view.displayName
      return React.createElement('div', { className: 'one-set' }, [
        React.createElement('label', { key: 'l', htmlFor: 'dsh-one-name-input' }, '助手名称'),
        React.createElement('p', { key: 'd' },
          view === undefined
            ? '读取中…'
            : `显示在面板、命令和 DSH Go 上。默认：${view.defaultDisplayName}${view.overridden ? '（已自定义）' : ''}`),
        React.createElement('div', { key: 'r', className: 'one-set-row' }, [
          React.createElement('input', {
            key: 'i',
            id: 'dsh-one-name-input',
            value: draft,
            maxLength: 24,
            placeholder: view?.defaultDisplayName ?? '',
            disabled: busy,
            onChange: (event: { target?: { value?: string } }) => setDraft(event.target?.value ?? ''),
            onKeyDown: (event: { key?: string }) => {
              if (event.key === 'Enter' && !unchanged && draft.trim() !== '') void save()
            },
          }),
          React.createElement('button', {
            key: 's',
            type: 'button',
            disabled: busy || unchanged || draft.trim() === '',
            onClick: () => { void save() },
          }, '保存'),
          React.createElement('button', {
            key: 'x',
            type: 'button',
            disabled: busy || view?.overridden !== true,
            onClick: () => { void reset() },
          }, '恢复默认'),
        ]),
        ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-err' }, error)]),
      ])
    }

    function OnePanel(): ReactElementLike {
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState<Overview | undefined>(undefined)
      const [error, setError] = React.useState<string | undefined>(undefined)
      React.useEffect(() => {
        let alive = true
        const load = async (): Promise<void> => {
          try {
            const response = await fetch('/one/api/overview', { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const value = await response.json() as Overview
            if (alive) {
              setData(value)
              setError(undefined)
            }
          } catch (loadError) {
            if (alive) setError(String(loadError))
          }
        }
        void load()
        const timer = setInterval(() => { void load() }, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      const attention = data?.attention.length ?? 0
      const running = data?.running.length ?? 0
      const name = data?.displayName ?? 'One'
      const pill = React.createElement('button', {
        key: 'pill',
        className: 'one-pill',
        onClick: () => setOpen(!open),
        title: name,
      }, `${name} ${attention}/${running}`)
      if (!open) return pill
      const body = React.createElement('div', { key: 'body', className: 'one-body' }, [
        ...(error === undefined ? [] : [React.createElement('div', { key: 'err', className: 'one-err' }, error)]),
        section('Needs attention', data?.attention ?? []),
        section('Running', data?.running ?? []),
        section('History', data?.history ?? []),
        ...(data === undefined ? [] : [
          React.createElement('div', { key: 'health', className: 'one-sec' }, 'Health'),
          React.createElement('div', { key: 'h2', className: 'one-health' }, [
            React.createElement('div', { key: 's' }, `storage ${data.health.storage}`),
            React.createElement('div', { key: 'c' }, `core ${data.health.core}`),
            React.createElement('div', { key: 'd' }, `delegate ${data.health.delegate}`),
            React.createElement('div', { key: 'i' }, `ingress ${data.health.ingress}`),
            React.createElement('div', { key: 'w' }, `workers ${data.health.workers}/${data.health.maxWorkers}`),
            React.createElement('div', { key: 'l' }, `leases ${data.health.leases}`),
            React.createElement('div', { key: 'p' }, `policy ${data.health.policyVersion ?? '—'}`),
            React.createElement('div', { key: 'e' }, data.health.lastError ?? 'no error'),
          ]),
        ]),
      ])
      return React.createElement('div', { key: 'panel', className: 'one-panel' }, [
        React.createElement('div', { key: 'head', className: 'one-head' }, [
          React.createElement('h3', { key: 't' }, name),
          React.createElement('button', { key: 'c', onClick: () => setOpen(false) }, 'Close'),
        ]),
        body,
      ])
    }

    const inject = ['slots']

    function apply(ctx: ClientContextLike): void {
      ensureStyle()
      const slots = ctx.slots
      if (slots === undefined) return
      ctx.effect?.(() => {
        // `shell.overlay` is a root-scoped list slot; a registrant supplies an
        // id and order, and the panel draws its own chrome.
        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'dsh-one-panel',
          order: 90,
        }, OnePanel))
      }, 'dsh-one: client overlay')
      ctx.effect?.(() => {
        // Rows in General Settings: one owner-declared row, so `id` is ours and
        // must not shadow a shipped row.
        slots.inject('settings.general.item', () => slots.register({
          name: 'settings.general.item',
          id: 'dsh-one-name',
          order: 60,
        }, NameRow))
      }, 'dsh-one: settings row')
    }

    return { inject, apply }
  },
})
