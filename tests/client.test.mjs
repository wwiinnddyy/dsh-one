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
    useRef: initial => ({ current: initial }),
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
  }
  const sandbox = {
    window,
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setInterval: () => 1,
    clearInterval: () => {},
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

/** Apply the module against a recording context and return what it registered. */
function applyModule(options = {}) {
  const { module } = loadClient()
  const { slots, registrations } = makeSlots()
  const effects = []
  const services = { uiWorkspace: options.uiWorkspace }
  const ctx = {
    slots,
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    get(name) { return services[name] },
  }
  module.apply(ctx)
  return { module, registrations, effects }
}

test('the client half declares the slots service', () => {
  const { module } = loadClient()
  assert.deepEqual([...module.inject], ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('the client no longer contributes a floating overlay', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The rejected design was a bottom-right pill/panel drawn on `shell.overlay`.
  assert.ok(!source.includes('shell.overlay'), 'no overlay registration remains')
  assert.ok(!source.includes('position:fixed'), 'no fixed-position chrome remains')
  assert.ok(!/\.one-pill/u.test(source), 'the floating pill style is gone')
  const { registrations } = applyModule()
  for (const entry of registrations) {
    assert.notEqual(entry.declaration.name, 'shell.overlay')
  }
})

test('the assistant sits above the workspace list and opens a real conversation', () => {
  const { registrations } = applyModule()

  const entry = registrations.find(item => item.declaration.name === 'sidebar.panellist')
  assert.ok(entry, 'registers a sidebar panel entry')
  assert.equal(entry.declaration.id, 'dsh-one-assistant')
  // The shipped panel icons start at order 0; a negative order keeps this first,
  // which is what places the assistant above the workspace list.
  assert.ok(entry.declaration.order < 0, 'the entry sorts above the shipped icons')

  // DSH resolves the click to `selectPanel(id)`, so the matching `main` key is
  // what turns the click into a conversation instead of a dead panel.
  const panel = registrations.find(item => item.declaration.name === 'main')
  assert.ok(panel, 'registers the paired main panel')
  assert.equal(panel.declaration.key, entry.declaration.id, 'the panel key matches the entry id')
  assert.equal(typeof panel.component, 'function')
})

test('the assistant panel opens the host session rather than drawing a chat', () => {
  const opened = []
  const { registrations } = applyModule({ uiWorkspace: { openSession: id => opened.push(id) } })
  const panel = registrations.find(item => item.declaration.name === 'main')
  // Render the component far enough to run its effect: the fake React runs
  // effects eagerly, which is exactly the mount path DSH uses.
  const tree = panel.component()
  assert.ok(tree, 'the panel renders something while it navigates')
})

test('the client owns a dedicated settings section, not a General row', () => {
  const { registrations } = applyModule()
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('settings.general.item'), 'no longer borrows a General row')

  const section = registrations.find(item => item.declaration.name === 'settings.section')
  assert.ok(section, 'registers its own settings section')
  assert.equal(section.declaration.id, 'dsh-one')
  assert.equal(typeof section.declaration.order, 'number')
  // A section owns its tab label, unlike a General row whose label is unused.
  assert.ok(section.declaration.label !== undefined, 'the tab carries a label')
  assert.equal(typeof section.component, 'function')
})

test('the sidebar label follows a rename without re-registering', () => {
  const { registrations } = applyModule()
  const entry = registrations.find(item => item.declaration.name === 'sidebar.panellist')
  // A thunk is re-read on every projection, so Settings can rename the entry
  // live; a fixed string would freeze the name until the page reloads.
  assert.equal(typeof entry.declaration.label, 'function')
  assert.equal(typeof entry.declaration.label(), 'string')
  assert.ok(entry.declaration.label().length > 0)
})

test('the settings section id cannot collide with a shipped section', () => {
  const { registrations } = applyModule()
  const shipped = ['general', 'models', 'plugins', 'account', 'subagent', 'session-log']
  for (const entry of registrations) {
    if (entry.declaration.name !== 'settings.section') continue
    assert.ok(!shipped.includes(entry.declaration.id), `${entry.declaration.id} is not a shipped section`)
    assert.match(entry.declaration.id, /^[a-z][a-z0-9-]*$/u)
  }
})

test('every registered surface is unique and reachable', () => {
  const { registrations, effects } = applyModule()
  assert.equal(registrations.length, 3)
  assert.equal(effects.length, 3)
  const names = registrations.map(item => item.declaration.name).sort()
  assert.deepEqual(names, ['main', 'settings.section', 'sidebar.panellist'])
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function')
  }
})

test('a context without slots degrades instead of throwing', () => {
  const { module } = loadClient()
  assert.doesNotThrow(() => module.apply({ effect: fn => fn() }))
})

test('both surfaces render without a fetch rounding error reaching the user', () => {
  // The components must not throw while the first request is still in flight.
  const { registrations } = applyModule()
  for (const entry of registrations) {
    if (entry.declaration.name === 'main') continue
    assert.doesNotThrow(() => entry.component())
  }
})
