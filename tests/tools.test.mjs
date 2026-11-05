import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnv } from './harness.mjs'

/** Walk a JSON schema and record every `type` that is not a single string. */
function collectTypeArrays(node, path, failures) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectTypeArrays(item, `${path}[${index}]`, failures))
    return
  }
  if ('type' in node && typeof node.type !== 'string') failures.push(`${path}.type`)
  for (const [key, value] of Object.entries(node)) {
    collectTypeArrays(value, `${path}.${key}`, failures)
  }
}

test('tool schemas use only the schema subset the host accepts', async () => {
  const env = await createEnv()
  try {
    const failures = []
    for (const tool of env.tools.values()) {
      collectTypeArrays(tool.parameters, `${tool.name}.parameters`, failures)
      collectTypeArrays(tool.output.schema, `${tool.name}.output`, failures)
    }
    // The host rejects `type: ['object', 'null']`; a type must be one string.
    assert.deepEqual(failures, [])
  } finally {
    await env.dispose()
  }
})
