/**
 * Browser side of dsh-one — a self-contained personal-assistant page.
 *
 * This is NOT a DSH Session rendered by the host. The host runs a hidden model
 * call and owns the transcript; everything the human sees — the header, the
 * transcript, the composer, the identity — is drawn here. Opening the assistant
 * never asks which Workspace to use, because no Session is ever opened in the UI.
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
interface StyleTagLike { textContent: string; dataset?: Record<string, string> }
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
declare const FileReader: new () => {
  result: string | ArrayBuffer | null
  onload: (() => void) | null
  readAsDataURL(file: unknown): void
}
declare const Image: new () => {
  width: number
  height: number
  onload: (() => void) | null
  src: string
}
declare const navigator: {
  clipboard?: { writeText(text: string): Promise<void> }
}

let React: ReactLike

const PANEL_ID = 'dsh-one-assistant'

/* ------------------------------------------------------------------ */
/* Identity: one source for the sidebar icon/label, header and messages */
/* ------------------------------------------------------------------ */

interface Identity { readonly name: string; readonly avatar: string | null }
let identity: Identity = { name: '助手', avatar: null }
const identityListeners = new Set<() => void>()

function setIdentity(next: Identity): void {
  identity = next
  syncSidebarLabel()
  for (const listener of [...identityListeners]) listener()
}

/**
 * The sidebar label is projected once by the host, so a rename is mirrored onto
 * the rendered row directly. The avatar itself is a React component and follows
 * `identityListeners`; only the host-owned text node needs this nudge.
 */
function syncSidebarLabel(): void {
  try {
    const doc = document as unknown as {
      querySelectorAll(selector: string): Iterable<{
        closest(selector: string): {
          querySelector(selector: string): { textContent: string } | null
          setAttribute(name: string, value: string): void
        } | null
      }>
    }
    for (const node of doc.querySelectorAll('[data-slot="sidebar.panellist"]')) {
      const button = node.closest('button')
      if (button === null) continue
      if (button.querySelector('.one-avatar') === null) continue
      button.setAttribute('aria-label', identity.name)
      const title = button.querySelector('[class*="panelTitle"]')
      if (title !== null) title.textContent = identity.name
    }
  } catch {
    // A host that renders a different sidebar shape keeps its own label.
  }
}

async function refreshIdentity(): Promise<void> {
  try {
    const value = await jsonFetch('/one/api/settings') as SettingsView
    setIdentity({ name: value.displayName, avatar: value.avatar ?? null })
  } catch {
    // Keep the last known identity; the page reports the error itself.
  }
}

function useIdentity(): Identity {
  const [value, setValue] = React.useState<Identity>(identity)
  React.useEffect(() => {
    const listener = (): void => setValue({ ...identity })
    identityListeners.add(listener)
    if (identity.name === '助手') void refreshIdentity()
    return () => { identityListeners.delete(listener) }
  }, [])
  return value
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const CSS = [
  '.one-app{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);',
  'background:radial-gradient(1200px 500px at 50% -10%,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent),transparent 70%),var(--dsw-alias-bg-base)}',
  '.one-head{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;background:color-mix(in srgb,var(--dsw-alias-bg-base) 86%,transparent);backdrop-filter:blur(8px)}',
  '.one-avatar{border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:600;line-height:1;overflow:hidden;user-select:none}',
  '.one-avatar-img{width:100%;height:100%;object-fit:cover;display:block}',
  '.one-head-main{display:flex;flex-direction:column;gap:3px;min-width:0}',
  '.one-head-line{display:flex;align-items:center;gap:7px;min-width:0}',
  '.one-head-name{font-size:15px;font-weight:650;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-status-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary)) 15%,transparent)}',
  '.one-head-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-head-spacer{flex:1}',
  '.one-head-actions{display:flex;align-items:center;gap:6px;flex:none}',
  '.one-ghost{padding:6px 10px;border-radius:8px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
  '.one-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
  '.one-tabs{display:flex;gap:2px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);flex:none}',
  '.one-tab{padding:5px 12px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
  '.one-tab:hover{color:var(--dsw-alias-label-primary)}',
  '.one-tab-active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
  '.one-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  '.one-chat-page{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  // Chat
  '.one-chat{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:26px 22px 8px}',
  '.one-chat-inner{width:100%;max-width:780px;margin:0 auto;display:flex;flex-direction:column;gap:18px;flex:1;justify-content:flex-start}',
  '.one-chat-inner-top{justify-content:flex-start}',
  '.one-msg{display:flex;gap:11px;align-items:flex-start;max-width:100%;animation:one-in .18s ease-out}',
  '.one-msg-user{flex-direction:row-reverse}',
  '.one-msg-avatar{flex:none;margin-top:2px}',
  '.one-msg-body{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:82%}',
  '.one-msg-user .one-msg-body{align-items:flex-end}',
  '.one-bubble{padding:11px 14px;border-radius:15px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;',
  'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-top-left-radius:5px}',
  '.one-msg-user .one-bubble{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l1));border-top-left-radius:15px;border-top-right-radius:5px}',
  '.one-msg-system .one-bubble{color:var(--dsw-alias-state-error-primary);font-size:12px;background:transparent;border-style:dashed}',
  '.one-msg-meta{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary);padding:0 4px}',
  '.one-msg-user .one-msg-meta{flex-direction:row-reverse}',
  '.one-bubble p{margin:0 0 8px}',
  '.one-bubble p:last-child{margin-bottom:0}',
  '.one-bubble ul{margin:4px 0 8px;padding-left:20px}',
  '.one-bubble li{margin:2px 0}',
  '.one-bubble code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2)}',
  '.one-bubble pre{margin:8px 0;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);overflow:auto;white-space:pre}',
  '.one-bubble pre code{padding:0;background:transparent;font-size:12px;line-height:1.55}',
  '.one-copy{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer;padding:2px 5px;border-radius:5px;opacity:0;transition:opacity .15s}',
  '.one-msg:hover .one-copy{opacity:1}',
  '.one-copy:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
  '.one-typing{display:flex;align-items:center;gap:4px;padding:14px 16px}',
  '.one-typing span{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary);animation:one-bounce 1.2s infinite ease-in-out}',
  '.one-typing span:nth-child(2){animation-delay:.15s}',
  '.one-typing span:nth-child(3){animation-delay:.3s}',
  '.one-suggest{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0 10px 37px}',
  '.one-suggest button{padding:8px 13px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
  'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:all .15s}',
  '.one-suggest button:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
  // Composer
  '.one-composer{flex:none;padding:10px 22px 16px;background:linear-gradient(to top,var(--dsw-alias-bg-base) 70%,transparent)}',
  '.one-composer-inner{width:100%;max-width:780px;margin:0 auto;display:flex;gap:9px;align-items:flex-end;padding:9px;border-radius:16px;',
  'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 18px rgba(0,0,0,.10)}',
  '.one-composer-inner:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1))}',
  '.one-input{flex:1;min-height:40px;max-height:180px;resize:none;box-sizing:border-box;padding:9px 8px;border:none;background:transparent;',
  'color:inherit;font:inherit;font-size:13px;line-height:1.6;outline:none}',
  '.one-send{width:38px;height:38px;border-radius:11px;border:none;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);',
  'cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;transition:transform .12s,opacity .12s}',
  '.one-send:hover:not(:disabled){transform:translateY(-1px)}',
  '.one-send:disabled{opacity:.35;cursor:default}',
  '.one-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin:8px auto 0;max-width:780px;text-align:center}',
  // Workbench
  '.one-scroll{flex:1;min-height:0;overflow:auto;padding:22px}',
  '.one-scroll-inner{width:100%;max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:16px}',
  '.one-title{font-size:16px;font-weight:650;margin:0}',
  '.one-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
  '.one-card{padding:14px 16px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-card-v{font-size:24px;font-weight:650;line-height:1.2}',
  '.one-card-k{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}',
  '.one-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
  '.one-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
  '.one-row-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.one-chip{font-size:10px;padding:3px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);flex:none;font-weight:500}',
  '.one-chip-person{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary));border-color:currentColor}',
  '.one-chip-work{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));border-color:currentColor}',
  '.one-chip-idle,.one-chip-ended{color:var(--dsw-alias-label-secondary)}',
  '.one-empty-card{padding:26px 20px;border-radius:12px;border:.5px dashed var(--dsw-alias-border-l1);text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.8}',
  '.one-btn{padding:6px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.one-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
  '.one-btn:disabled{opacity:.5;cursor:default}',
  '.one-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:600}',
  '.one-btn-danger{color:var(--dsw-alias-state-error-primary)}',
  // Settings
  '.one-section{display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:13px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.one-section-head{display:flex;flex-direction:column;gap:3px}',
  '.one-section-title{font-size:13px;font-weight:650;margin:0}',
  '.one-section-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}',
  '.one-field{display:flex;flex-direction:column;gap:7px;font-size:12px}',
  '.one-field label{font-weight:550}',
  '.one-input-box{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l1);',
  'background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:13px;outline:none}',
  '.one-input-box:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,var(--dsw-alias-border-l1))}',
  '.one-textarea{min-height:150px;resize:vertical;line-height:1.6}',
  '.one-avatar-row{display:flex;align-items:center;gap:14px}',
  '.one-avatar-actions{display:flex;gap:8px;flex-wrap:wrap}',
  '.one-avatar-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
  '.one-actions{display:flex;gap:8px;align-items:center}',
  '.one-notice{font-size:11px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}',
  '.one-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '@keyframes one-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
  '@keyframes one-bounce{0%,80%,100%{transform:translateY(0);opacity:.45}40%{transform:translateY(-3px);opacity:1}}',
  '@media (prefers-reduced-motion:reduce){.one-msg{animation:none}.one-typing span{animation:none}}',
].join('')

function ensureStyle(): void {
  if (document.querySelector('style[data-dsh-one]') !== null) return
  const style = document.createElement('style')
  style.textContent = CSS
  style.dataset = { dshOne: '1' }
  document.head.appendChild(style)
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function jsonFetch(path: string, init?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(init ?? {}) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const body = value as { error?: unknown }
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  }
  return value
}

async function jsonPost(path: string, body: unknown): Promise<unknown> {
  return await jsonFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/* ------------------------------------------------------------------ */
/* Small views                                                         */
/* ------------------------------------------------------------------ */

interface SettingsView {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly avatar: string | null
  readonly persona: string | null
  readonly notifyMuted: boolean
  readonly backend: string
}
interface Overview {
  readonly displayName: string
  readonly defaultDisplayName: string
  readonly avatar: string | null
  readonly model: string
  readonly backend: string
  readonly tickets: { readonly total: number; readonly open: number; readonly ended: number }
  readonly workspaces: readonly { readonly path: string; readonly label: string; readonly sessions: number }[]
  readonly sessions: readonly { readonly sessionId: string; readonly running: boolean }[]
}
interface ChatRow {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
  readonly at: number
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

function initial(name: string): string {
  return [...(name.trim() === '' ? '助手' : name)][0] ?? '助'
}

/** Deterministic, low-saturation color for the initial fallback. */
function hueOf(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return hash
}

function Avatar(props: {
  readonly name: string
  readonly avatar?: string | null
  readonly size: number
  readonly variant?: 'assistant' | 'user'
  readonly key?: string
}): ReactElementLike {
  if (props.variant === 'user') {
    return React.createElement('div', {
      className: 'one-avatar',
      style: {
        width: `${props.size}px`, height: `${props.size}px`, fontSize: `${Math.round(props.size * 0.4)}px`,
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        border: '.5px solid var(--dsw-alias-border-l1)',
      },
    }, '我')
  }
  if (props.avatar !== undefined && props.avatar !== null && props.avatar !== '') {
    return React.createElement('div', {
      className: 'one-avatar',
      style: { width: `${props.size}px`, height: `${props.size}px`, background: 'var(--dsw-alias-bg-layer-2)' },
    }, React.createElement('img', { className: 'one-avatar-img', src: props.avatar, alt: props.name }))
  }
  const hue = hueOf(props.name)
  return React.createElement('div', {
    className: 'one-avatar',
    style: {
      width: `${props.size}px`, height: `${props.size}px`, fontSize: `${Math.round(props.size * 0.38)}px`,
      background: `hsl(${hue} 42% 40%)`, color: '#fff', letterSpacing: '0',
    },
  }, initial(props.name))
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
function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ */
/* Markdown-lite: bold, inline code, code fences, bullets              */
/* ------------------------------------------------------------------ */

function inline(text: string, key: string): ReactElementLike[] {
  const nodes: ReactElementLike[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/gu
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(React.createElement('span', { key: `${key}-t${index}` }, text.slice(last, start)))
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(React.createElement('strong', { key: `${key}-b${index}` }, token.slice(2, -2)))
    } else {
      nodes.push(React.createElement('code', { key: `${key}-c${index}` }, token.slice(1, -1)))
    }
    last = start + token.length
    index += 1
  }
  if (last < text.length) nodes.push(React.createElement('span', { key: `${key}-t${index}` }, text.slice(last)))
  return nodes
}

function renderMarkdown(text: string): ReactElementLike[] {
  const blocks: ReactElementLike[] = []
  const lines = text.split('\n')
  let paragraph: string[] = []
  let list: string[] = []
  let code: string[] | undefined
  let key = 0
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push(React.createElement('p', { key: `p${key++}` }, ...inline(paragraph.join('\n'), `p${key}`)))
    paragraph = []
  }
  const flushList = (): void => {
    if (list.length === 0) return
    blocks.push(React.createElement('ul', { key: `u${key++}` },
      list.map((item, index) => React.createElement('li', { key: `li${index}` }, ...inline(item, `li${index}`)))))
    list = []
  }
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (code === undefined) {
        flushParagraph()
        flushList()
        code = []
      } else {
        blocks.push(React.createElement('pre', { key: `pre${key++}` },
          React.createElement('code', null, code.join('\n'))))
        code = undefined
      }
      continue
    }
    if (code !== undefined) { code.push(line); continue }
    if (/^\s*[-*]\s+/u.test(line)) { flushParagraph(); list.push(line.replace(/^\s*[-*]\s+/u, '')); continue }
    if (line.trim() === '') { flushParagraph(); flushList(); continue }
    paragraph.push(line)
  }
  if (code !== undefined) blocks.push(React.createElement('pre', { key: `pre${key++}` }, React.createElement('code', null, code.join('\n'))))
  flushParagraph()
  flushList()
  return blocks.length === 0 ? [React.createElement('p', { key: 'empty' }, text)] : blocks
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

interface PollState<T> { readonly data?: T; readonly error?: string }
function usePoll<T>(path: string, intervalMs: number): PollState<T> {
  const [state, setState] = React.useState<PollState<T>>({})
  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const data = await jsonFetch(path) as T
        if (!cancelled) setState({ data })
      } catch (error: unknown) {
        if (!cancelled) setState(previous => ({ ...previous, error: String(error) }))
      }
    }
    void load()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load()
    }, intervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [path, intervalMs])
  return state
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function AssistantApp(): ReactElementLike {
  const [tab, setTab] = React.useState<'chat' | 'work' | 'settings'>('chat')
  const [chatKey, setChatKey] = React.useState(0)
  const overview = usePoll<Overview>('/one/api/overview', 8_000)
  const identityView = useIdentity()
  const data = overview.data
  const name = data?.displayName ?? identityView.name
  const avatar = data?.avatar ?? identityView.avatar
  const open = data?.tickets.open ?? 0

  const newChat = async (): Promise<void> => {
    await jsonPost('/one/api/chat/clear', {})
    setChatKey(previous => previous + 1)
  }

  const tabs = React.createElement('div', { className: 'one-tabs' }, [
    React.createElement('button', { key: 'c', type: 'button', className: `one-tab${tab === 'chat' ? ' one-tab-active' : ''}`, onClick: () => setTab('chat') }, '对话'),
    React.createElement('button', { key: 'w', type: 'button', className: `one-tab${tab === 'work' ? ' one-tab-active' : ''}`, onClick: () => setTab('work') }, `工单 ${open}`),
    React.createElement('button', { key: 's', type: 'button', className: `one-tab${tab === 'settings' ? ' one-tab-active' : ''}`, onClick: () => setTab('settings') }, '设置'),
  ])

  const body = tab === 'chat'
    ? React.createElement(ChatView, { key: `chat-${chatKey}`, name, avatar })
    : tab === 'work'
      ? React.createElement(WorkView, { key: 'work' })
      : React.createElement(SettingsView, { key: 'settings' })

  return React.createElement('div', { className: 'one-app' }, [
    React.createElement('div', { key: 'head', className: 'one-head' }, [
      Avatar({ key: 'a', name, avatar, size: 40 }),
      React.createElement('div', { key: 'm', className: 'one-head-main' }, [
        React.createElement('div', { key: 'l', className: 'one-head-line' }, [
          React.createElement('span', { key: 'n', className: 'one-head-name' }, name),
          React.createElement('span', { key: 'd', className: 'one-status-dot', title: '在线' }),
        ]),
        React.createElement('span', { key: 's', className: 'one-head-sub' },
          `${open === 0 ? '待命中' : `${open} 个工单在推进`} · ${data?.model ? data.model.split('/').pop() : '模型'}`),
      ]),
      React.createElement('div', { key: 'sp', className: 'one-head-spacer' }),
      React.createElement('div', { key: 'actions', className: 'one-head-actions' }, [
        React.createElement('button', {
          key: 'new', type: 'button', className: 'one-ghost', onClick: () => { void newChat() }, title: '清空当前对话，重新开始',
        }, '新对话'),
        tabs,
      ]),
    ]),
    React.createElement('div', { key: 'body', className: 'one-body' }, body),
  ])
}

function ChatView(props: { readonly name: string; readonly avatar: string | null }): ReactElementLike {
  const [rows, setRows] = React.useState<readonly ChatRow[]>([])
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [copied, setCopied] = React.useState<string | undefined>(undefined)
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
  }, [rows.length, busy])

  const sendText = async (text: string): Promise<void> => {
    const clean = text.trim()
    if (clean === '' || busy) return
    setBusy(true)
    setError(undefined)
    setDraft('')
    setRows(previous => [...previous, { id: `local-${Date.now()}`, role: 'user', text: clean, at: Date.now() }])
    try {
      await jsonFetch('/one/api/chat?send=' + encodeURIComponent(clean))
      await load()
    } catch (failure: unknown) {
      setError(String(failure))
      setDraft(clean)
    } finally {
      setBusy(false)
    }
  }
  const copy = async (row: ChatRow): Promise<void> => {
    try {
      await (navigator as unknown as { clipboard?: { writeText(text: string): Promise<void> } }).clipboard?.writeText(row.text)
      setCopied(row.id)
      setTimeout(() => setCopied(undefined), 1200)
    } catch {
      // Clipboard permission is best-effort.
    }
  }

  const showSuggestions = rows.length <= 1 && !busy
  return React.createElement('div', { className: 'one-chat-page' },
    React.createElement('div', { className: 'one-chat', ref: scroll as unknown as Record<string, unknown> },
      React.createElement('div', { className: `one-chat-inner${rows.length <= 1 ? ' one-chat-inner-top' : ''}` }, [
        ...rows.map(row => React.createElement('div', {
          key: row.id, className: `one-msg one-msg-${row.role}`,
        }, [
          row.role === 'user'
            ? Avatar({ key: 'a', name: '我', size: 26, variant: 'user' })
            : Avatar({ key: 'a', name: props.name, avatar: props.avatar, size: 26 }),
          React.createElement('div', { key: 'b', className: 'one-msg-body' }, [
            React.createElement('div', { key: 'x', className: 'one-bubble' },
              ...(row.role === 'assistant' ? renderMarkdown(row.text) : [row.text])),
            React.createElement('div', { key: 'm', className: 'one-msg-meta' }, [
              React.createElement('span', { key: 't' }, clock(row.at)),
              ...(row.role === 'assistant'
                ? [React.createElement('button', {
                  key: 'c', type: 'button', className: 'one-copy',
                  onClick: () => { void copy(row) },
                }, copied === row.id ? '已复制' : '复制')]
                : []),
            ]),
          ]),
        ])),
        ...(showSuggestions ? [React.createElement('div', { key: 'sg', className: 'one-suggest' }, [
          ['看看我的工作区', '帮我整理今天要做的事', '检查最近的改动并给我结论'].map((text, index) =>
            React.createElement('button', {
              key: `s${index}`, type: 'button',
              onClick: () => { void sendText(text) },
            }, text)),
        ])] : []),
        ...(busy ? [React.createElement('div', { key: 'typing', className: 'one-msg one-msg-assistant' }, [
          Avatar({ key: 'a', name: props.name, avatar: props.avatar, size: 26 }),
          React.createElement('div', { key: 'b', className: 'one-msg-body' },
            React.createElement('div', { className: 'one-bubble one-typing' }, [
              React.createElement('span', { key: '1' }), React.createElement('span', { key: '2' }), React.createElement('span', { key: '3' }),
            ])),
        ])] : []),
      ])),
    React.createElement('div', { className: 'one-composer' }, [
      React.createElement('div', { className: 'one-composer-inner' }, [
        React.createElement('textarea', {
          className: 'one-input',
          value: draft,
          rows: 1,
          placeholder: '直接说你想做什么，我会自己去推进…',
          onChange: (event: { target?: { value?: string } }) => setDraft(event.target?.value ?? ''),
          onKeyDown: (event: { key?: string; shiftKey?: boolean; preventDefault?: () => void }) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault?.(); void sendText(draft) }
          },
        }),
        React.createElement('button', {
          className: 'one-send', type: 'button', disabled: busy || draft.trim() === '',
          title: '发送', onClick: () => { void sendText(draft) },
        }, React.createElement('svg', { width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none' },
          React.createElement('path', { d: 'M8 13V3M3.5 7.5 8 3l4.5 4.5', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }))),
      ]),
      React.createElement('p', { className: 'one-hint' }, 'Enter 发送 · Shift+Enter 换行 · 不需要选择工作区'),
    ]),
    ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
  )
}

function WorkView(): ReactElementLike {
  const [rows, setRows] = React.useState<readonly TicketRow[]>([])
  const [error, setError] = React.useState<string | undefined>(undefined)
  const overview = usePoll<Overview>('/one/api/overview', 5_000)
  const load = async (): Promise<void> => {
    try { setRows(((await jsonFetch('/one/api/tickets')) as { items: readonly TicketRow[] }).items) }
    catch (failure: unknown) { setError(String(failure)) }
  }
  React.useEffect(() => { void load() }, [])
  const stop = async (ticketId: string): Promise<void> => {
    try { await jsonFetch('/one/api/tickets/stop?ticketId=' + encodeURIComponent(ticketId)); await load() }
    catch (failure: unknown) { setError(String(failure)) }
  }
  const data = overview.data
  return React.createElement('div', { className: 'one-scroll' },
    React.createElement('div', { className: 'one-scroll-inner' }, [
      React.createElement('div', { key: 'cards', className: 'one-cards' }, [
        React.createElement('div', { key: 'o', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.tickets.open ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '进行中工单'),
        ]),
        React.createElement('div', { key: 'e', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.tickets.ended ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '已结束'),
        ]),
        React.createElement('div', { key: 'w', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.workspaces.length ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '工作区'),
        ]),
        React.createElement('div', { key: 's', className: 'one-card' }, [
          React.createElement('div', { key: 'v', className: 'one-card-v' }, String(data?.sessions.length ?? 0)),
          React.createElement('div', { key: 'k', className: 'one-card-k' }, '会话'),
        ]),
      ]),
      React.createElement('h3', { key: 't', className: 'one-title' }, '工单'),
      React.createElement('ul', { key: 'l', className: 'one-list' }, rows.length === 0
        ? [React.createElement('li', { key: 'empty', className: 'one-empty-card' },
          '还没有工单。\n在「对话」里告诉我目标，我会拆成工单派给合适的会话。')]
        : rows.map(row => React.createElement('li', { key: row.ticketId, className: 'one-row' }, [
          React.createElement('span', { key: 'c', className: `one-chip one-chip-${stageTone(row.stage)}` }, stageLabel(row.stage)),
          React.createElement('span', { key: 'm', className: 'one-row-main' }, [
            React.createElement('span', { key: 't', className: 'one-row-title' }, row.title),
            React.createElement('span', { key: 'x', className: 'one-row-meta' },
              [row.cwd ?? '', row.latestReport ?? row.question ?? ''].filter(Boolean).join(' · ') || row.ticketId),
          ]),
          ...(row.status === 'open'
            ? [React.createElement('button', { key: 's', type: 'button', className: 'one-btn one-btn-danger', onClick: () => { void stop(row.ticketId) } }, '停止')]
            : []),
        ]))),
      ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
    ]))
}

function SettingsView(): ReactElementLike {
  const [view, setView] = React.useState<SettingsView | undefined>(undefined)
  const [name, setName] = React.useState('')
  const [persona, setPersona] = React.useState('')
  const [avatar, setAvatar] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const file = React.useRef<unknown>(undefined)

  const load = async (): Promise<void> => {
    const data = await jsonFetch('/one/api/settings') as SettingsView
    setView(data)
    setName(data.displayName)
    setPersona(data.persona ?? '')
    setAvatar(data.avatar ?? null)
  }
  React.useEffect(() => { void load().catch(failure => setError(String(failure))) }, [])

  const pick = (): void => {
    const node = file.current as { click?: () => void } | undefined
    node?.click?.()
  }
  const onFile = (event: { target?: { files?: { [index: number]: unknown } } }): void => {
    const selected = event.target?.files?.[0]
    if (selected === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      const source = String(reader.result ?? '')
      const image = new Image()
      image.onload = () => {
        const canvas = (document as unknown as { createElement(tag: string): { width: number; height: number; getContext(type: string): { drawImage(image: unknown, ...args: number[]): void } | null; toDataURL(type: string, quality?: number): string } }).createElement('canvas')
        const edge = Math.min(image.width, image.height)
        canvas.width = 128
        canvas.height = 128
        const context = canvas.getContext('2d')
        if (context === null) return
        context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, 128, 128)
        setAvatar(canvas.toDataURL('image/png', 0.9))
      }
      image.src = source
    }
    reader.readAsDataURL(selected)
  }

  const save = async (): Promise<void> => {
    setNotice(undefined)
    setError(undefined)
    try {
      await jsonFetch('/one/api/settings?displayName=' + encodeURIComponent(name)
        + '&persona=' + encodeURIComponent(persona.trim()))
      await jsonPost('/one/api/settings/avatar', { avatar })
      await refreshIdentity()
      await load()
      setNotice('已保存')
    } catch (failure: unknown) {
      setError(String(failure))
    }
  }
  const reset = async (): Promise<void> => {
    try {
      await jsonFetch('/one/api/settings?resetName=1&resetPersona=1')
      await jsonPost('/one/api/settings/avatar', { avatar: null })
      await refreshIdentity()
      await load()
      setNotice('已恢复默认')
    } catch (failure: unknown) { setError(String(failure)) }
  }
  const removeAvatar = async (): Promise<void> => {
    setAvatar(null)
    await jsonPost('/one/api/settings/avatar', { avatar: null })
    await refreshIdentity()
    setNotice('头像已恢复为名字首字')
  }

  return React.createElement('div', { className: 'one-scroll' },
    React.createElement('div', { className: 'one-scroll-inner' }, [
      React.createElement('h3', { key: 't', className: 'one-title' }, '设置'),
      React.createElement('div', { key: 'id', className: 'one-section' }, [
        React.createElement('div', { key: 'h', className: 'one-section-head' }, [
          React.createElement('h4', { key: 't', className: 'one-section-title' }, '身份'),
          React.createElement('p', { key: 's', className: 'one-section-sub' }, '名字和头像会同步到左侧入口、页面标题与每条助手消息。'),
        ]),
        React.createElement('div', { key: 'a', className: 'one-avatar-row' }, [
          Avatar({ name: name || view?.defaultDisplayName || '助手', avatar, size: 64 }),
          React.createElement('div', { key: 'acts', className: 'one-avatar-actions' }, [
            React.createElement('button', { key: 'u', type: 'button', className: 'one-btn', onClick: pick }, '上传图片'),
            React.createElement('button', { key: 'r', type: 'button', className: 'one-btn', onClick: () => { void removeAvatar() } }, '恢复首字'),
            React.createElement('input', {
              key: 'f', ref: file, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
              style: { display: 'none' }, onChange: onFile,
            }),
          ]),
        ]),
        React.createElement('p', { key: 'n', className: 'one-avatar-note' }, '支持 PNG / JPEG / WebP / GIF，自动裁成方形并压到 128px。'),
        React.createElement('div', { key: 'name', className: 'one-field' }, [
          React.createElement('label', { key: 'l' }, `名字（默认 ${view?.defaultDisplayName ?? '助手'}）`),
          React.createElement('input', {
            key: 'i', className: 'one-input-box', value: name,
            onChange: (event: { target?: { value?: string } }) => setName(event.target?.value ?? ''),
          }),
        ]),
      ]),
      React.createElement('div', { key: 'persona', className: 'one-section' }, [
        React.createElement('div', { key: 'h', className: 'one-section-head' }, [
          React.createElement('h4', { key: 't', className: 'one-section-title' }, '行为文本'),
          React.createElement('p', { key: 's', className: 'one-section-sub' }, '留空使用内置文本。这段文字会作为助手的系统提示词。'),
        ]),
        React.createElement('textarea', {
          key: 't', className: 'one-input-box one-textarea', value: persona,
          onChange: (event: { target?: { value?: string } }) => setPersona(event.target?.value ?? ''),
        }),
      ]),
      React.createElement('div', { key: 'acts', className: 'one-actions' }, [
        React.createElement('button', { key: 's', type: 'button', className: 'one-btn one-btn-primary', onClick: () => { void save() } }, '保存'),
        React.createElement('button', { key: 'r', type: 'button', className: 'one-btn', onClick: () => { void reset() } }, '恢复默认'),
        ...(notice === undefined ? [] : [React.createElement('span', { key: 'n', className: 'one-notice' }, notice)]),
      ]),
      ...(error === undefined ? [] : [React.createElement('div', { key: 'e', className: 'one-error' }, error)]),
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

/** Sidebar icon: the same identity avatar, so the entry is never generic. */
function SidebarGlyph(props: { readonly size?: number }): ReactElementLike {
  const id = useIdentity()
  const size = Math.max(16, props.size ?? 16)
  return React.createElement('div', {
    className: 'one-avatar',
    style: {
      width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(9, Math.round(size * 0.6))}px`,
      background: id.avatar === null ? `hsl(${hueOf(id.name)} 42% 40%)` : 'var(--dsw-alias-bg-layer-2)',
      color: '#fff',
    },
  },
  id.avatar === null
    ? React.createElement('span', { style: { lineHeight: '1' } }, initial(id.name))
    : React.createElement('img', { className: 'one-avatar-img', src: id.avatar, alt: id.name }))
}

window.__ModuleLoader__.load({
  id: 'dsh-one',
  factory(require) {
    React = require('react') as ReactLike
    const inject = ['slots']

    function apply(ctx: ClientContextLike): void {
      ensureStyle()
      void refreshIdentity()
      const slots = ctx.slots
      if (slots === undefined) return

      ctx.effect?.(() => {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: -100,
          label: () => identity.name,
        }, (props: { size?: number }) => SidebarGlyph({ size: props?.size })))
      }, 'dsh-one: assistant entry')

      ctx.effect?.(() => {
        slots.inject('main', () => slots.register({
          name: 'main', key: PANEL_ID,
        }, () => AssistantApp()))
      }, 'dsh-one: assistant page')

      ctx.effect?.(() => {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section', id: 'dsh-one', order: 60, label: '助手',
        }, () => SettingsView()))
      }, 'dsh-one: settings section')
    }

    return { inject, apply }
  },
})
