import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('the package keeps the verified DSH range and one runtime peer', () => {
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.4 <0.3.0-0')
  assert.deepEqual(Object.keys(pkg.peerDependencies), ['@deepseek-ai/schemastery'])
  assert.equal(pkg.dependencies.zod !== undefined, true)
})

test('the package exports the host row and its patch', () => {
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('the bundle patch mounts one core row in observe mode', () => {
  assert.match(patch, /id: dsh-one\n/u)
  assert.match(patch, /mode: observe\n/u)
  assert.doesNotMatch(patch, /dsh-one-ingress/u)
})

test('the build produced the host entry and its types', () => {
  assert.equal(existsSync(new URL('../lib/index.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/types/index.d.ts', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/core/engine.js', import.meta.url)), true)
})

test('no client-ui package is advertised before the client phase', () => {
  assert.equal(pkg.dsh.client, undefined)
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /dsh-client-ui-slots/u)
})
