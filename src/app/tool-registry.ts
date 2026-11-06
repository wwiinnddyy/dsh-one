/**
 * The in-plugin tool registry used by the assistant's own conversation.
 *
 * The assistant page is not a DSH Session, so it has no Agent whose scope can
 * execute tools through `ctx.tools.execute`. The two `one_*` tools are ordinary
 * in-process definitions; keeping their exact objects here lets the chat engine
 * publish the model-facing schemas and execute a call with the same definition
 * the Host registered, without inventing a second implementation.
 */

import type { AgentLike, ToolDefinitionLike, ToolSchemaLike } from '../types.js'

/** Stable actor id for the assistant page when it has no hidden DSH Session. */
export const ASSISTANT_ACTOR_ID = 'dsh-one-assistant'

export interface ToolCallRequest {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface ToolCallOutcome {
  readonly id: string
  readonly name: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinitionLike>()

  register(definition: ToolDefinitionLike): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name)
    }
  }

  /** Exactly the model-facing fields, in registration order. */
  schemas(): ToolSchemaLike[] {
    return [...this.definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }

  has(name: string): boolean {
    return this.definitions.has(name)
  }

  /** Execute one model tool call and turn every failure into a result the model can read. */
  async execute(call: ToolCallRequest, agent: AgentLike | undefined, signal: AbortSignal): Promise<ToolCallOutcome> {
    const definition = this.definitions.get(call.name)
    if (definition === undefined) {
      return { id: call.id, name: call.name, ok: false, error: `未知工具：${call.name}` }
    }
    let args: unknown = {}
    if (call.arguments.trim() !== '') {
      try {
        args = JSON.parse(call.arguments)
      } catch (error: unknown) {
        return {
          id: call.id,
          name: call.name,
          ok: false,
          error: `工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    try {
      const value = await definition.execute(args, { ...(agent === undefined ? {} : { agent }), signal })
      return { id: call.id, name: call.name, ok: true, value }
    } catch (error: unknown) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
