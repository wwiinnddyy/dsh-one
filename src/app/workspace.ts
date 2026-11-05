/**
 * Workspace creation.
 *
 * The assistant may choose a folder and turn it into a Workspace, then put a
 * worker Session there. Two guards apply: the path must be inside
 * `allowedWorkspaceRoots`, and the DSH Workspace registry is updated when the
 * host exposes one (so the client groups the new Session correctly).
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DshContextLike, OneConfig, WorkspaceRegistryLike } from '../types.js'
import { UserError } from '../core/errors.js'
import { pathWithin } from './paths.js'

/** Directory the assistant owns under the configured home root. */
export const ASSISTANT_HOME_DIRNAME = 'super-mind'

export class WorkspaceService {
  private readonly ctx: DshContextLike
  private readonly config: OneConfig

  constructor(ctx: DshContextLike, config: OneConfig) {
    this.ctx = ctx
    this.config = config
  }

  isAllowed(path: string): boolean {
    return this.config.allowedWorkspaceRoots.length === 0
      || this.config.allowedWorkspaceRoots.some(root => pathWithin(root, path))
  }

  assertAllowed(path: string): void {
    if (!this.isAllowed(path)) {
      throw new UserError('one/workspace-forbidden', `workspace "${path}" is outside the allowed roots`, { path })
    }
  }

  /** Create the directory and register it as a DSH Workspace when possible. */
  async create(input: { readonly path: string; readonly name?: string }): Promise<{ readonly path: string; readonly workspaceId?: string }> {
    const target = resolve(input.path.trim())
    if (target.trim() === '') throw new UserError('one/invalid-argument', 'workspace path must not be blank', {})
    this.assertAllowed(target)
    await mkdir(target, { recursive: true })
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined) return { path: target }
    try {
      const known = await registry.resolveByPath(target)
      if (known !== undefined) return { path: target, workspaceId: known.id }
      const created = await registry.create(target, input.name?.trim() || target)
      return { path: target, workspaceId: created.id }
    } catch {
      // A registry failure must not block directory creation: the Session's cwd
      // still opens; only the named Workspace grouping is missing.
      return { path: target }
    }
  }

  /** Resolve the assistant's own home, creating it on demand. */
  async ensureAssistantHome(preferred?: string): Promise<string> {
    const chosen = preferred?.trim()
    if (chosen !== undefined && chosen !== '') {
      const explicit = resolve(chosen)
      this.assertAllowed(explicit)
      await mkdir(explicit, { recursive: true })
      return explicit
    }
    const root = this.config.assistantHomeRoot.trim()
    const base = root === ''
      ? join(process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh'), ASSISTANT_HOME_DIRNAME)
      : join(resolve(root), ASSISTANT_HOME_DIRNAME)
    this.assertAllowed(base)
    await mkdir(base, { recursive: true })
    return base
  }
}
