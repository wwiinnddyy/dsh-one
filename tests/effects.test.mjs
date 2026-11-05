import test from 'node:test'
import assert from 'node:assert/strict'
import { EffectsQueue } from '../lib/app/effects.js'
import { MemoryEffectStore } from '../lib/app/store.js'

function makeQueue(options = {}) {
  let now = 10_000
  const store = new MemoryEffectStore()
  const queue = new EffectsQueue(store, {
    now: () => now,
    retryBaseMs: 100,
    maxAttempts: 2,
    ...options,
  })
  return { queue, store, tick(ms = 1) { now += ms } }
}

test('a waiting kind/key is replaced instead of duplicated', () => {
  const { queue, store } = makeQueue()
  queue.enqueue('relay', 'ticket-1', { text: 'first' })
  queue.enqueue('relay', 'ticket-1', { text: 'second' })
  const rows = store.list()
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].payload, { text: 'second' })
})

test('drain runs a handler once and marks the effect done', async () => {
  const { queue, store } = makeQueue()
  const seen = []
  queue.register('reply', payload => { seen.push(payload) })
  queue.enqueue('reply', 'k1', 'hello')
  const result = await queue.drain()
  assert.equal(result.processed, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(seen, ['hello'])
  assert.equal(store.list()[0].status, 'done')
})

test('a failing handler retries with exponential backoff before giving up', async () => {
  const { queue, store, tick } = makeQueue()
  let attempts = 0
  queue.register('launch', () => {
    attempts += 1
    if (attempts < 2) throw new Error('slot busy')
  })
  queue.enqueue('launch', 'k1', {})
  const first = await queue.drain()
  assert.equal(first.failed, 1)
  const pending = store.list()[0]
  assert.equal(pending.status, 'pending')
  assert.equal(pending.attempts, 1)
  assert.equal(pending.dueAt, 10_100)

  // Not due yet: nothing runs.
  const early = await queue.drain()
  assert.equal(early.processed, 0)

  tick(100)
  const second = await queue.drain()
  assert.equal(second.processed, 1)
  assert.equal(store.list()[0].status, 'done')
  assert.equal(attempts, 2)
})

test('after maxAttempts the effect is failed, not retried forever', async () => {
  const { queue, store, tick } = makeQueue()
  queue.register('notice', () => { throw new Error('always broken') })
  queue.enqueue('notice', 'k1', {})
  await queue.drain()
  tick(100)
  await queue.drain()
  assert.equal(store.list()[0].status, 'failed')
})

test('a missing handler fails the effect with a clear error', async () => {
  const { queue, store } = makeQueue()
  queue.enqueue('assessment', 'k1', {})
  await queue.drain()
  assert.equal(store.list()[0].status, 'failed')
  assert.match(store.list()[0].error, /no handler/u)
})

test('effects run in enqueue order', async () => {
  const { queue, tick } = makeQueue()
  const seen = []
  queue.register('relay', payload => { seen.push(payload) })
  queue.enqueue('relay', 'a', 'first')
  tick(1)
  queue.enqueue('relay', 'b', 'second')
  await queue.drain()
  assert.deepEqual(seen, ['first', 'second'])
})
