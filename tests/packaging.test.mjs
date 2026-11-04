import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('package declares the verified DSH range and real runtime peers only', () => {
  assert.equal(typeof pkg.engines.dsh, 'string')
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.4 <0.3.0-0')
  assert.deepEqual(Object.keys(pkg.peerDependencies), ['@deepseek-ai/schemastery'])
  assert.equal(pkg.peerDependenciesMeta, undefined)
  assert.equal(pkg.dependencies.zod !== undefined, true)
})

test('all three rows and the client face are exported', () => {
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['./delegate'].default, './lib/delegate.js')
  assert.equal(pkg.exports['./ingress'].default, './lib/ingress.js')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'), true)
})

test('the bundle patch mounts three rows and leaves ingress disabled', () => {
  assert.match(patch, /id: dsh-one\n/u)
  assert.match(patch, /id: dsh-one-delegate\n/u)
  assert.match(patch, /id: dsh-one-ingress\n/u)
  const ingressIndex = patch.indexOf('id: dsh-one-ingress')
  const disabledIndex = patch.indexOf('disabled: true', ingressIndex)
  assert.notEqual(disabledIndex, -1)
})

test('DSH Go manifest respects panel and strip limits', () => {
  const panel = pkg.dshGo.contributes.panels[0]
  const title = typeof panel.title === 'string' ? panel.title : panel.title.en
  assert.ok(title.length <= 16)
  const strip = pkg.dshGo.contributes['composer.strip'][0]
  assert.equal(strip.panel, 'one')
  const staticText = strip.text ?? 'One 0/0'
  assert.ok(staticText.length <= 24)
})

test('locale and icon files exist', () => {
  for (const file of ['locale/en.json', 'locale/zh.json', 'icon.svg']) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, file)
  }
  const locale = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.equal(typeof locale.meta.title, 'string')
  assert.equal(typeof locale.meta.description, 'string')
})

test('the client bundle registers under the package id and imports only React', () => {
  assert.match(client, /__ModuleLoader__\.load/u)
  assert.match(client, new RegExp(pkg.name.replace('/', '\\/'), 'u'))
  assert.doesNotMatch(client, /@deepseek-ai\//u)
})
