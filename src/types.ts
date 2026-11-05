/**
 * The minimal DeepSeek Harness surface this plugin compiles against.
 *
 * Kept hand-written and dependency-free: the plugin must load on a profile that
 * cannot resolve DSH's own type packages at build time.
 */

/** Minimal Agent surface used by tools. */
export interface AgentLike {
  readonly id: string
  readonly session: {
    readonly id?: string
    readonly header: { readonly cwd?: string }
  }
}

export interface ToolRunContextLike {
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly timeoutMs?: number
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
}

/** Cordis context subset used by this plugin. */
export interface DshContextLike {
  effect(callback: () => (() => void) | void, label?: string): unknown
  get(name: string): unknown
  provide?(name: string, value: unknown): () => void
  on?(event: string, listener: (...args: any[]) => unknown): () => void
  inject?(names: string[], callback: (ctx: DshContextLike) => void): unknown
  readonly tools: { register(definition: ToolDefinitionLike): () => void }
}

export type OneMode = 'observe' | 'active'

/** Core row configuration. */
export interface OneConfig {
  /** User-facing assistant name. */
  readonly displayName: string
  /** Root for folders the assistant creates; empty derives `<dsh home>/super-mind`. */
  readonly assistantHomeRoot: string
  /** Agent-initiated actions: `observe` records only; `active` executes. */
  readonly mode: OneMode
  /** Workspace roots the assistant may touch; empty allows all. */
  readonly allowedWorkspaceRoots: readonly string[]
}
