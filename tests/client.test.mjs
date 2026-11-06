import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered
  const styles = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: initial => ({ current: initial }),
  }
  const document = {
    head: { appendChild: element => styles.push(element) },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => ({ tag, textContent: '', dataset: {} }),
    visibilityState: 'visible',
  }
  const window = { __ModuleLoader__: { load: entry => { registered = entry } } }
  const sandbox = {
    window,
    document,
    React,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(registered, 'the client registers itself on the module loader')
  assert.equal(registered.id, 'dsh-one')
  const factory = registered.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { module: factory, React, styles }
}

function makeSlots() {
  const registrations = []
  const slots = {
    register(declaration, component) {
      registrations.push({ declaration, component })
      return () => {}
    },
    inject(name, fn) { return fn() },
  }
  return { slots, registrations }
}

function applyModule() {
  const { module } = loadClient()
  const { slots, registrations } = makeSlots()
  const ctx = {
    slots,
    effect(fn) { return fn() },
    get() { return undefined },
  }
  module.apply(ctx)
  return { registrations }
}

test('the client declares only the slots service', () => {
  const { module } = loadClient()
  assert.deepEqual([...module.inject], ['slots'])
})

test('there is exactly one sidebar entry and one self-contained main page', () => {
  const { registrations } = applyModule()
  const sidebar = registrations.filter(item => item.declaration.name === 'sidebar.panellist')
  assert.equal(sidebar.length, 1)
  assert.equal(sidebar[0].declaration.id, 'dsh-one-assistant')
  assert.ok(sidebar[0].declaration.order < 0)
  // The label is a thunk, so a rename reaches the sidebar without re-registering.
  assert.equal(typeof sidebar[0].declaration.label, 'function')
  assert.equal(typeof sidebar[0].declaration.label(), 'string')
  const main = registrations.filter(item => item.declaration.name === 'main')
  assert.equal(main.length, 1)
  assert.equal(main[0].declaration.key, 'dsh-one-assistant')
})

test('the assistant page never opens a DSH Session or asks for a Workspace', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('openSession'), 'no Session navigation')
  assert.ok(!source.includes('uiWorkspace'), 'no Workspace picker dependency')
  assert.ok(!source.includes('AssistantLauncher'), 'no redirecting launcher')
})

test('the page draws its own transcript and composer', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('one-chat'), 'own transcript')
  assert.ok(source.includes('one-composer'), 'own composer')
  assert.ok(source.includes('/one/api/chat'), 'own chat API')
  assert.ok(!source.includes('conversation.input.dock'), 'does not borrow the chat shell')
})

test('the client keeps its own settings tab', () => {
  const { registrations } = applyModule()
  const section = registrations.find(item => item.declaration.name === 'settings.section')
  assert.ok(section)
  assert.equal(section.declaration.id, 'dsh-one')
  assert.equal(typeof section.component, 'function')
})

test('the client does not register a floating overlay', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('shell.overlay'))
  assert.ok(!source.includes('position:fixed'))
})

test('hook-bearing components are mounted through React.createElement, never called as plain functions', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // A function component that calls useState/useEffect must be rendered by
  // React. Calling it directly would attribute its hooks to the call-site
  // component and throw "Rendered more hooks than during the previous render"
  // as soon as the row list grows.
  assert.match(source, /React\.createElement\(StreamingBubble,/u)
  assert.doesNotMatch(source, /StreamingBubble\(\{/u)
  assert.match(source, /React\.createElement\(ToolCallList,/u)
  assert.doesNotMatch(source, /ToolCallList\(\{/u)
})

test('the chat bubble renders tool calls and their result cards', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /one-tools/u)
  assert.match(source, /one-tool-status/u)
  assert.match(source, /toolCalls/u)
})

test('every registered surface renders without throwing', () => {
  const { registrations } = applyModule()
  for (const entry of registrations) {
    assert.doesNotThrow(() => entry.component({ session: { sessionId: 'other' }, size: 16 }))
  }
})
