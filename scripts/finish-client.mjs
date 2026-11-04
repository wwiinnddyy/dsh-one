/** Strip the module marker tsc appends so the client artifact stays a classic script. */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const client = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const text = readFileSync(client, 'utf8')
writeFileSync(client, text.replace(/\nexport \{\};\s*$/u, '\n'))
