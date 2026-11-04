import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv } from './harness.mjs'

/**
 * The bug this file pins down, in the words of the real data:
 *
 * A Session created before the home directory existed carries some other `cwd`
 * (on this machine `C:\Users\lincu\.dsh\profiles\desktop`). The old check
 * compared the persisted record against the Host's own value, so both sides
 * agreed on `profiles\desktop` and the stale blank Session was handed back. The
 * user pressed the entry and got what looked like a brand-new chat, which is
 * exactly the report "it does nothing".
 *
 * Correct behaviour: reusable only when the Session lives in the home we would
 * create today, compared as paths rather than as raw strings.
 */

/**
 * Build an environment with one Session in the Host's listing, then decide
 * whether the assistant may reuse it.
 *
 * The persisted record is written through the same table the core opens, which
 * is what `assistantSessionReusable` reads; writing it anywhere else would test
 * nothing but the fixture.
 */
async function verdict({ listedCwd, recordCwd, home }) {
  const env = await createEnv({
    delegate: false,
    sessions: [{
      sessionId: 'assistant-1',
      updatedAt: 1,
      running: false,
      blank: false,
      agentAvailable: true,
      ...(listedCwd === undefined ? {} : { cwd: listedCwd }),
    }],
  })
  try {
    const sessions = env.storageDomain.tables.get('sessions')
    if (recordCwd !== undefined) {
      await sessions.put('assistant-1', {
        sessionId: 'assistant-1',
        title: '鲸宝',
        cwd: recordCwd,
        status: 'active',
        trusted: true,
        createdAt: 1,
        updatedAt: 1,
        lastSeenAt: 1,
      })
    }
    return await env.core.assistantSessionReusable('assistant-1', home)
  } finally {
    await env.dispose()
  }
}

test('a session left in the profile directory is not reusable', async () => {
  // The exact shape found on disk before the fix.
  const reusable = await verdict({
    listedCwd: 'C:\\Users\\lincu\\.dsh\\profiles\\desktop',
    recordCwd: 'C:\\Users\\lincu\\.dsh\\profiles\\desktop',
    home: 'C:\\Users\\lincu\\.dsh\\super-mind',
  })
  assert.equal(reusable, false)
})

test('a session already in the assistant home is reusable', async () => {
  const reusable = await verdict({
    listedCwd: 'C:\\Users\\lincu\\.dsh\\super-mind',
    recordCwd: 'C:\\Users\\lincu\\.dsh\\super-mind',
    home: 'C:\\Users\\lincu\\.dsh\\super-mind',
  })
  assert.equal(reusable, true)
})

test('path comparison ignores separators, trailing slash, and drive case', async () => {
  const reusable = await verdict({
    listedCwd: 'C:/Users/lincu/.dsh/super-mind/',
    recordCwd: 'c:\\users\\lincu\\.dsh\\super-mind',
    home: 'C:\\Users\\lincu\\.dsh\\super-mind',
  })
  assert.equal(reusable, true)
})

test('a session the host lists without a cwd is not reusable', async () => {
  const reusable = await verdict({
    listedCwd: undefined,
    recordCwd: 'C:\\Users\\lincu\\.dsh\\super-mind',
    home: 'C:\\Users\\lincu\\.dsh\\super-mind',
  })
  assert.equal(reusable, false)
})

test('a session with no persisted record is not reusable', async () => {
  const reusable = await verdict({
    listedCwd: 'C:\\Users\\lincu\\.dsh\\super-mind',
    recordCwd: undefined,
    home: 'C:\\Users\\lincu\\.dsh\\super-mind',
  })
  assert.equal(reusable, false)
})

test('a session whose record and listing disagree is not reusable', async () => {
  const reusable = await verdict({
    listedCwd: 'C:\\Users\\lincu\\.dsh\\super-mind',
    recordCwd: 'C:\\Users\\lincu\\.dsh\\profiles\\desktop',
    home: 'C:\\Users\\lincu\\.dsh\\super-mind',
  })
  assert.equal(reusable, false)
})
