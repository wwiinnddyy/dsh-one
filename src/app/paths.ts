/** Path helpers shared by the workspace and executor adapters. */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Whether `target` is inside `root` (case-insensitive on Windows). */
export function pathWithin(root: string, target: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
  const normalizedTarget = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target)
  const diff = relative(normalizedRoot, normalizedTarget)
  if (diff === '') return true
  if (isAbsolute(diff)) return false
  return !diff.split(sep).includes('..')
}

/** Case- and separator-insensitive key for one directory. */
export function workspaceKey(path: string): string {
  const slashed = path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-zA-Z]:\//u.test(slashed) ? slashed.toLowerCase() : slashed
}

/** A short human label for one workspace path. */
export function workspaceLabel(path: string): string {
  const slashed = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const parts = slashed.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
