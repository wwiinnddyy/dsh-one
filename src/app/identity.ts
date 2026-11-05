/**
 * Inject the assistant's identity into its own Session, and only that Session.
 *
 * `systemPrompt.section()` receives the rendering agent id. Comparing it with
 * the persisted assistant session id is what keeps a user's ordinary chat free
 * of any assistant text.
 */

import type { DshContextLike } from '../types.js'
import type { OneRuntime } from './runtime.js'
import { personaFor } from './persona.js'

interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly interpolate?: boolean
    readonly text: string | ((context?: { readonly agent?: { readonly id?: unknown } }) => string)
  }): () => void
}

const IDENTITY_ORDER = 620

export function registerAssistantPersona(ctx: DshContextLike, runtime: OneRuntime): () => void {
  const prompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (prompt === undefined || typeof prompt.section !== 'function') return () => {}
  const textFor = (agentId: string | undefined): string => {
    if (agentId === undefined) return ''
    const assistantId = runtime.assistantSessionId()
    if (assistantId === undefined || assistantId !== agentId) return ''
    return personaFor(runtime.assistantName(), runtime.settings.persona())
  }
  return prompt.section({
    name: 'dsh-one-assistant-identity',
    order: IDENTITY_ORDER,
    interpolate: false,
    text: assembly => {
      const raw = assembly?.agent?.id
      return textFor(typeof raw === 'string' ? raw : undefined)
    },
  })
}
