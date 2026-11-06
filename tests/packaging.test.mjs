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

test('the bundle patch mounts the core row in active mode', () => {
  assert.match(patch, /id: dsh-one\n/u)
  assert.match(patch, /mode: active\n/u)
  assert.doesNotMatch(patch, /dsh-one-ingress/u)
})

test('the build produced the host entry, the client bundle and types', () => {
  assert.equal(existsSync(new URL('../lib/index.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/types/index.d.ts', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/core/engine.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/client.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/mermaid.min.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../lib/types/client.d.ts', import.meta.url)), true)
})

test('the client manifest lists only packages this DSH release ships', () => {
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), false)
})
