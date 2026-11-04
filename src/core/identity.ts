/**
 * Inject the assistant's identity into its own Session, and only that Session.
 *
 * A Session created with a `cwd` is still an ordinary blank conversation: DSH
 * gives it a system prompt built from the harness defaults plus whatever plugins
 * contribute, and none of those know the Session is supposed to be an assistant.
 * That is why opening it felt identical to a new chat.
 *
 * Two facts make a targeted injection possible, both taken from the working
 * `ds-bot` plugin rather than guessed:
 *
 * 1. `systemPrompt.section()` accepts a render function that receives the
 *    assembly context, which carries the rendering Agent (`context.agent.id`).
 * 2. Registering the section on the Agent's own context scope means it applies
 *    to that Agent only, not to every Session in the process.
 *
 * So the assistant's Session gets an identity; a user's ordinary chat does not.
 */

import type { DshContextLike, OneConfig } from '../types.js'
import type { OneCore } from './registry.js'
import type { OneSettings } from './settings.js'
import { composePersona } from './persona.js'

/** Host surface for the prompt registry, narrowed to what this module uses. */
interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly interpolate?: boolean
    readonly text: string | ((context?: { readonly agent?: { readonly id?: unknown } }) => string)
  }): () => void
}

/** Host surface for the workspace registry, narrowed to what this module uses. */
interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ readonly id: string } | undefined>
  create(path: string, name: string): Promise<{ readonly id: string }>
}

/**
 * Prompt order for the identity section.
 *
 * `ds-bot` uses 640 for its identity text. The assistant is the Session's
 * primary purpose rather than a team member's persona, so it sits just before
 * that: late enough to follow the harness rules, early enough to precede
 * per-feature context.
 */
const IDENTITY_ORDER = 620

/**
 * Register the identity section.
 *
 * Returns a disposer and never throws: a host without `systemPrompt` (an older
 * build) must keep the rest of the plugin working, only without the identity.
 */
export function registerAssistantPersona(
  ctx: DshContextLike,
  core: OneCore,
  settings: OneSettings,
  config: OneConfig,
): () => void {
  const prompt = ctx.get?.('systemPrompt') as SystemPromptLike | undefined
  if (prompt === undefined || typeof prompt.section !== 'function') return () => {}

  // Read the settings on every assembly rather than closing over values, so an
  // edit in the settings tab reaches the very next turn, and a restart needs no
  // warm-up: the persisted session id is the single source of truth.
  const textFor = (agentId: string | undefined): string => {
    if (agentId === undefined) return ''
    const assistantId = settings.assistantSessionId()
    if (assistantId === undefined || assistantId !== agentId) return ''
    const persona = composePersona(settings.persona())
    const name = settings.displayName()
    return persona.replace('# 你的身份', `# 你的身份\n你的名字是「${name}」。`)
  }

  const dispose = prompt.section({
    name: 'dsh-one-assistant-identity',
    order: IDENTITY_ORDER,
    interpolate: false,
    text: (assembly) => {
      const raw = assembly?.agent?.id
      const id = typeof raw === 'string' ? raw : undefined
      return textFor(id)
    },
  })
  void config
  return dispose
}

/**
 * Resolve the assistant's home as a real DSH Workspace.
 *
 * A `cwd` alone puts the Session in a folder the client groups under an
 * inferred Workspace. Registering the path as an actual Workspace is firmer: the
 * client then resolves a real Workspace id, which is what keeps the "choose a
 * workspace" prompt away even after a restart reorders its own session list.
 */
export async function ensureAssistantWorkspace(
  ctx: DshContextLike,
  path: string,
  name: string,
): Promise<string | undefined> {
  const registry = ctx.get?.('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (registry === undefined) return undefined
  try {
    const known = await registry.resolveByPath(path)
    if (known !== undefined) return known.id
    const created = await registry.create(path, name)
    return created.id
  } catch {
    // A registry failure must not block session creation; the `cwd` fallback
    // still opens the assistant, only without a pre-registered Workspace.
    return undefined
  }
}
