/** Copy the self-contained Mermaid UMD bundle into lib so the host can serve it lazily. */

import { copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const source = require.resolve('mermaid/dist/mermaid.min.js')
copyFileSync(source, new URL('../lib/mermaid.min.js', import.meta.url))
