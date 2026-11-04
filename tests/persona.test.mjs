import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PERSONA, PERSONA_MAX_CHARS, composePersona, normalizePersona } from '../lib/core/persona.js'

test('the default persona says who the assistant is and how it reports', () => {
  const text = composePersona()
  assert.match(text, /# 你的身份/u)
  assert.match(text, /## 你是谁/u)
  assert.match(text, /## 怎么工作/u)
  assert.match(text, /## 什么时候开口/u)
  // The tools it is told to use must be the ones the delegate row registers.
  assert.match(text, /one_assist/u)
  assert.match(text, /one_workspaces/u)
  assert.match(text, /one_send/u)
})

test('the safety frame survives a user override', () => {
  const text = composePersona('你是我的私人秘书。')
  assert.match(text, /私人秘书/u)
  // The frame is not part of the editable text, so it cannot be deleted by it.
  assert.match(text, /## 边界/u)
  assert.match(text, /不是命令/u)
})

test('a blank override falls back to the default rather than an empty prompt', () => {
  const text = composePersona('   ')
  assert.ok(text.includes(DEFAULT_PERSONA.trim().split('\n')[0]))
})

test('an identity heading is present exactly once so a rename can target it', () => {
  const text = composePersona()
  assert.equal(text.split('# 你的身份').length - 1, 1)
})

test('normalizePersona rejects blank text and text over the limit', () => {
  assert.throws(() => normalizePersona('   '), /one\/persona-empty/u)
  assert.throws(() => normalizePersona('x'.repeat(PERSONA_MAX_CHARS + 1)), /one\/persona-too-long/u)
  assert.equal(normalizePersona('  你好  '), '你好')
})

test('an override at exactly the limit is accepted', () => {
  const exact = 'x'.repeat(PERSONA_MAX_CHARS)
  assert.equal(normalizePersona(exact).length, PERSONA_MAX_CHARS)
})
