/** Offline fake host used by the dsh-one test suite. */

import { apply } from '../lib/index.js'

export function makeTable(seed = []) {
  const records = new Map(seed)
  return {
    records,
    get(key) { return records.get(key) },
    entries() { return [...records.entries()][Symbol.iterator]() },
    get size() { return records.size },
    async put(key, value) { records.set(key, value) },
    async delete(key) { return records.delete(key) },
  }
}

export function makeStorageDomain(seed = {}) {
  const names = ['tickets', 'goals', 'effects', 'sessions', 'settings', 'audit']
  const tables = new Map(names.map(name => [name, makeTable(seed[name] ?? [])]))
  return {
    tables,
    opened: 0,
    domain: undefined,
    async open(spec) {
      if (spec.name !== 'dsh_one_v3') throw new Error(`unexpected domain ${spec.name}`)
      this.opened += 1
      this.domain = {
        table(name) {
          const table = tables.get(name)
          if (table === undefined) throw new Error(`missing table ${name}`)
          return table
        },
        async close() { return undefined },
      }
      return this.domain
    },
    get(name) { return this.opened > 0 && tables.has(name) ? this.domain : undefined },
  }
}

export function makeAgent(id, cwd) {
  return { id, session: { id, header: { cwd } } }
}

export function makeController({ sessions = [], promptImpl, createImpl } = {}) {
  const calls = { list: 0, create: [], prompt: [] }
  const state = { sessions: [...sessions] }
  return {
    calls,
    state,
    async list() {
      calls.list += 1
      return { items: [...state.sessions] }
    },
    async create(request) {
      calls.create.push(request)
      if (createImpl !== undefined) return createImpl(request)
      const sessionId = request.sessionId ?? `session-${calls.create.length}`
      if (!state.sessions.some(item => item.sessionId === sessionId)) {
        state.sessions.push({
          sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          agentAvailable: true,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        })
      }
      return { sessionId }
    },
    async prompt(request) {
      calls.prompt.push(request)
      if (promptImpl !== undefined) return promptImpl(request)
      return {}
    },
    cancel() { return { accepted: true } },
  }
}

export function makeWorkspaceRegistry() {
  const created = []
  return {
    created,
    async resolveByPath() { return undefined },
    async create(path, name) { created.push({ path, name }); return { id: `ws-${created.length}` } },
  }
}

export function makeCtx({ controller, storageDomain, workspaceRegistry, systemPrompt } = {}) {
  const tools = new Map()
  const commands = new Map()
  const services = new Map()
  const listeners = new Map()
  const effects = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'storageDomain') return storageDomain
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        const index = bucket.indexOf(listener)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
  }
  const emitSession = (sessionId, event) => {
    for (const listener of listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
  }
  const dispose = async () => {
    for (const item of [...effects].reverse()) {
      if (typeof item === 'function') await item()
    }
  }
  return { ctx, tools, commands, services, effects, emitSession, dispose }
}

export async function createEnv(options = {}) {
  const controller = options.controller ?? makeController({ sessions: options.sessions ?? [] })
  const storageDomain = options.storageDomain ?? makeStorageDomain(options.seed)
  const workspaceRegistry = options.workspaceRegistry ?? makeWorkspaceRegistry()
  const systemPrompt = options.systemPrompt
  const host = makeCtx({ controller, storageDomain, workspaceRegistry, systemPrompt })
  await apply(host.ctx, options.config ?? {})
  return {
    ...host,
    controller,
    storageDomain,
    workspaceRegistry,
    runtime: host.services.get('oneEngine').runtime,
  }
}
