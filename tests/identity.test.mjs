import test from 'node:test'
import assert from 'node:assert/strict'
import { registerAssistantPersona } from '../lib/core/identity.js'
import { DEFAULT_PERSONA } from '../lib/core/persona.js'

/**
 * A tiny stand-in for the host's prompt registry.
 *
 * The real service stores one section and calls its `text` function with the
 * assembly context on every model step; capturing that callback is enough to
 * assert which Sessions receive the identity.
 */
function fakeCtx({ withPrompt = true, workspaceRegistry } = {}) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') {
        if (!withPrompt) return undefined
        return {
          section(section) {
            registered.push(section)
            return () => { registered.pop() }
          },
        }
      }
      if (name === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
  }
  return { ctx, registered }
}

/** A settings double whose values the test can change between assertions. */
function fakeSettings(initial = {}) {
  const state = { sessionId: 'assistant-1', persona: undefined, displayName: '鲸宝', ...initial }
  return {
    state,
    assistantSessionId: () => state.sessionId,
    persona: () => state.persona,
    displayName: () => state.displayName,
  }
}

const core = {}

test('the identity section is registered once with a stable name and order', () => {
  const { ctx, registered } = fakeCtx()
  const dispose = registerAssistantPersona(ctx, core, fakeSettings(), {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'dsh-one-assistant-identity')
  assert.equal(typeof registered[0].order, 'number')
  assert.equal(registered[0].interpolate, false)
  dispose()
})

test('the assistant session receives its identity text', () => {
  const { ctx, registered } = fakeCtx()
  registerAssistantPersona(ctx, core, fakeSettings(), {})
  const text = registered[0].text({ agent: { id: 'assistant-1' } })
  assert.match(text, /# 你的身份/u)
  assert.match(text, /## 怎么工作/u)
  assert.match(text, /鲸宝/u)
})

test('an ordinary session receives no identity text', () => {
  const { ctx, registered } = fakeCtx()
  registerAssistantPersona(ctx, core, fakeSettings(), {})
  assert.equal(registered[0].text({ agent: { id: 'someone-else' } }), '')
  assert.equal(registered[0].text({}), '')
  assert.equal(registered[0].text(undefined), '')
})

test('a user override reaches the very next assembly', () => {
  const { ctx, registered } = fakeCtx()
  const settings = fakeSettings()
  registerAssistantPersona(ctx, core, settings, {})
  assert.match(registered[0].text({ agent: { id: 'assistant-1' } }), /## 怎么工作/u)

  settings.state.persona = '你是我的私人秘书。'
  const after = registered[0].text({ agent: { id: 'assistant-1' } })
  assert.match(after, /私人秘书/u)
  // The frame is preserved even when the user replaces the body.
  assert.match(after, /## 边界/u)
})

test('the display name is injected into the identity heading', () => {
  const { ctx, registered } = fakeCtx()
  const settings = fakeSettings({ displayName: '小助手' })
  registerAssistantPersona(ctx, core, settings, {})
  const text = registered[0].text({ agent: { id: 'assistant-1' } })
  assert.match(text, /「小助手」/u)
  // The default persona must not be duplicated into the heading.
  assert.equal(text.split('# 你的身份').length - 1, 1)
})

test('a host without systemPrompt degrades to a no-op', () => {
  const { ctx, registered } = fakeCtx({ withPrompt: false })
  const dispose = registerAssistantPersona(ctx, core, fakeSettings(), {})
  assert.equal(registered.length, 0)
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('the default persona is exported for the settings editor to show', () => {
  assert.equal(typeof DEFAULT_PERSONA, 'string')
  assert.ok(DEFAULT_PERSONA.length > 0)
})
