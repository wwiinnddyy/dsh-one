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
    createElement: tag => ({ tag, textContent: '' }),
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
  const services = {}
  const ctx = {
    slots,
    effect(fn) { return fn() },
    get(name) { return services[name] },
  }
  module.apply(ctx)
  return { registrations }
}

test('the client declares only the slots service', () => {
  const { module } = loadClient()
  assert.deepEqual([...module.inject], ['slots'])
})

test('the client registers two sidebar entries and two main panels', () => {
  const { registrations } = applyModule()
  const sidebar = registrations.filter(item => item.declaration.name === 'sidebar.panellist')
  assert.deepEqual(sidebar.map(item => item.declaration.id).sort(), ['dsh-one-assistant', 'dsh-one-workbench'])
  assert.ok(sidebar.every(item => item.declaration.order < 0))
  const main = registrations.filter(item => item.declaration.name === 'main')
  assert.deepEqual(main.map(item => item.declaration.key).sort(), ['dsh-one-assistant', 'dsh-one-workbench'])
})

test('the assistant conversation has a persistent identity seat', () => {
  const { registrations } = applyModule()
  const dock = registrations.find(item => item.declaration.name === 'conversation.input.dock')
  assert.ok(dock)
  assert.equal(dock.declaration.id, 'dsh-one-identity')
  const chip = registrations.find(item => item.declaration.name === 'conversation.session.header.actions')
  assert.ok(chip)
  assert.equal(chip.declaration.id, 'dsh-one-assistant-chip')
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
  const { registrations } = applyModule()
  assert.ok(!registrations.some(item => item.declaration.name === 'shell.overlay'))
})

test('every registered surface renders without throwing', () => {
  const { registrations } = applyModule()
  for (const entry of registrations) {
    assert.doesNotThrow(() => entry.component({ session: { sessionId: 'other' }, size: 16 }))
  }
})
