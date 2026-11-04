import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * Load the built browser half into a fake client runtime. The module is a
 * classic script registering itself on `window.__ModuleLoader__`, so this
 * exercises the real artifact rather than the TypeScript source.
 */
function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered
  const styles = []
  const elements = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  const document = {
    head: { appendChild: element => styles.push(element) },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => {
      const element = { tag, dataset: {}, textContent: '' }
      elements.push(element)
      return element
    },
  }
  const window = {
    __ModuleLoader__: { load: entry => { registered = entry } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setInterval: () => 1,
    clearInterval: () => {},
  }
  const sandbox = {
    window,
    document,
    fetch: window.fetch,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(registered, 'the client registers itself on the module loader')
  assert.equal(registered.id, '@wwiinnddyy/dsh-one')
  const factory = registered.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { module: factory, React, styles }
}

/** Minimal slot ledger that records injections and registrations. */
function makeSlots() {
  const registrations = []
  const slots = {
    register(declaration, component) {
      registrations.push({ declaration, component })
      return () => {}
    },
    inject(name, fn) {
      assert.ok(typeof name === 'string' && name !== '')
      return fn()
    },
  }
  return { slots, registrations }
}

test('the client half declares the slots service and registers both surfaces', () => {
  const { module } = loadClient()
  assert.deepEqual([...module.inject], ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('the client registers the overlay panel and one settings row', () => {
  const { module } = loadClient()
  const { slots, registrations } = makeSlots()
  const effects = []
  const ctx = {
    slots,
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
  }
  module.apply(ctx)
  assert.equal(effects.length, 2)

  const overlay = registrations.find(entry => entry.declaration.name === 'shell.overlay')
  assert.ok(overlay, 'registers into shell.overlay')
  assert.equal(overlay.declaration.id, 'dsh-one-panel')
  assert.equal(typeof overlay.declaration.order, 'number')

  const row = registrations.find(entry => entry.declaration.name === 'settings.general.item')
  assert.ok(row, 'registers into settings.general.item')
  assert.equal(row.declaration.id, 'dsh-one-name')
  assert.equal(typeof row.declaration.order, 'number')
  // A General row receives no props from the shell, so it must not declare any.
  assert.equal(row.declaration.props, undefined)
  assert.equal(typeof row.component, 'function')
})

test('the generated settings row id cannot collide with a shipped row', () => {
  const { module } = loadClient()
  const { slots, registrations } = makeSlots()
  module.apply({ slots, effect: fn => fn() })
  // Shipped ids observed in the settings shell; ours must stay distinct.
  const shipped = [
    'permission', 'language', 'appearance', 'font-size', 'transcript-view',
    'developer-tools', 'shortcuts', 'link-opening', 'composer-enter',
    'performance-usage', 'session-log-deepseek', 'current-version',
  ]
  for (const entry of registrations) {
    if (entry.declaration.name !== 'settings.general.item') continue
    assert.ok(!shipped.includes(entry.declaration.id), `${entry.declaration.id} is not a shipped id`)
    assert.match(entry.declaration.id, /^[a-z][a-z0-9-]*$/u)
  }
})

test('a context without slots degrades instead of throwing', () => {
  const { module } = loadClient()
  assert.doesNotThrow(() => module.apply({ effect: fn => fn() }))
})
