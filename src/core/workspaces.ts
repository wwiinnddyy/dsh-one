/**
 * Cross-Workspace command surface for the assistant.
 *
 * The assistant is not tied to one project: it observes every Workspace the
 * deployment can see and issues instructions into their Sessions. This module
 * provides the *structure* that makes that possible — Workspaces grouped by
 * their canonical path, the Sessions inside each, and the outstanding
 * instructions it has sent — while the actual delivery stays in `OneCore`'s
 * outbox so a send keeps its existing retry and idempotency guarantees.
 *
 * Everything here is derived from data the Host already owns. Nothing is cached
 * across calls: a Workspace is only a `cwd` grouping, and inventing a durable
 * Workspace id would drift from the Host's own view.
 */

import type { SessionView } from '../types.js'

/** One Session as the assistant sees it from outside a Workspace. */
export interface WorkspaceSessionView {
  readonly sessionId: string
  readonly title?: string
  readonly running: boolean
  readonly blank: boolean
  readonly registered: boolean
  readonly lastSeenAt?: number
}

/** One Workspace: a canonical directory and the Sessions that live under it. */
export interface WorkspaceGroup {
  /** Canonical absolute path, or `''` for the ungrouped bucket. */
  readonly path: string
  /** Human-facing label: the final path segment, or a marker for the bucket. */
  readonly label: string
  readonly sessions: readonly WorkspaceSessionView[]
  /** Sessions currently executing a turn. */
  readonly running: number
  /** Sessions that exist but were not registered by this plugin. */
  readonly unregistered: number
  readonly lastActivityAt?: number
}

/** One outstanding instruction the assistant sent into another Session. */
export interface InstructionView {
  readonly requestId: string
  readonly targetSessionId: string
  readonly targetWorkspace: string
  readonly status: string
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly text: string
  readonly error?: string
}

/** The whole cross-Workspace picture the assistant reasons over. */
export interface WorkspaceOverview {
  readonly workspaces: readonly WorkspaceGroup[]
  /** Sessions whose `cwd` is missing, so no Workspace can own them. */
  readonly homeless: readonly WorkspaceSessionView[]
  readonly instructions: readonly InstructionView[]
  readonly totals: {
    readonly workspaces: number
    readonly sessions: number
    readonly running: number
    readonly pendingInstructions: number
  }
}

/** Normalize a path for grouping, independent of separators and trailing slash. */
export function canonicalPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (trimmed === '') return ''
  // Windows drive letters are case-insensitive; keep POSIX paths untouched.
  return /^[a-zA-Z]:\//u.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/** The final segment of a canonical path, for a Workspace's display label. */
export function workspaceLabel(path: string): string {
  const canonical = canonicalPath(path)
  if (canonical === '') return '(no workspace)'
  const parts = canonical.split('/').filter(part => part !== '')
  return parts[parts.length - 1] ?? canonical
}

/** Convert one listed Session into the trimmed view the assistant needs. */
function toWorkspaceSession(view: SessionView): WorkspaceSessionView {
  return {
    sessionId: view.sessionId,
    ...(view.title === undefined ? {} : { title: view.title }),
    running: view.running,
    blank: view.blank,
    registered: view.registered,
    ...(view.lastSeenAt === undefined ? {} : { lastSeenAt: view.lastSeenAt }),
  }
}

/**
 * Group Sessions by Workspace.
 *
 * Sessions are only ever grouped by `cwd`; a Session without one cannot belong
 * to a Workspace, so it lands in `homeless` instead of being guessed into a
 * bucket. Ordering is by recent activity so the assistant sees active work
 * first, and an empty path sorts last because it is not a real project.
 */
export function groupSessionsByWorkspace(items: readonly SessionView[]): {
  readonly workspaces: readonly WorkspaceGroup[]
  readonly homeless: readonly WorkspaceSessionView[]
} {
  const byPath = new Map<string, SessionView[]>()
  const homeless: WorkspaceSessionView[] = []

  for (const item of items) {
    if (item.subagent) continue
    const path = item.cwd === undefined ? '' : canonicalPath(item.cwd)
    if (path === '') {
      homeless.push(toWorkspaceSession(item))
      continue
    }
    const bucket = byPath.get(path)
    if (bucket === undefined) byPath.set(path, [item])
    else bucket.push(item)
  }

  const groups: WorkspaceGroup[] = []
  for (const [path, sessions] of byPath) {
    const views = sessions.map(toWorkspaceSession)
    const activity = views
      .map(view => view.lastSeenAt ?? 0)
      .filter(value => value > 0)
    groups.push({
      path,
      label: workspaceLabel(path),
      sessions: views,
      running: views.filter(view => view.running).length,
      unregistered: views.filter(view => !view.registered).length,
      ...(activity.length === 0 ? {} : { lastActivityAt: Math.max(...activity) }),
    })
  }

  groups.sort((left, right) => {
    const delta = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
    return delta !== 0 ? delta : left.path.localeCompare(right.path)
  })

  return { workspaces: groups, homeless }
}

/** Build the assistant's full cross-Workspace overview. */
export function buildWorkspaceOverview(input: {
  readonly sessions: readonly SessionView[]
  readonly instructions: readonly {
    readonly requestId: string
    readonly targetSessionId: string
    readonly status: string
    readonly attempts: number
    readonly createdAt: number
    readonly updatedAt: number
    readonly text: string
    readonly error?: string
  }[]
}): WorkspaceOverview {
  const { workspaces, homeless } = groupSessionsByWorkspace(input.sessions)
  const workspaceOf = new Map<string, string>()
  for (const group of workspaces) {
    for (const session of group.sessions) workspaceOf.set(session.sessionId, group.path)
  }
  const instructions: InstructionView[] = input.instructions.map(item => ({
    requestId: item.requestId,
    targetSessionId: item.targetSessionId,
    targetWorkspace: workspaceOf.get(item.targetSessionId) ?? '',
    status: item.status,
    attempts: item.attempts,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    text: item.text,
    ...(item.error === undefined ? {} : { error: item.error }),
  }))
  const sessions = workspaces.reduce((sum, group) => sum + group.sessions.length, 0)
  return {
    workspaces,
    homeless,
    instructions,
    totals: {
      workspaces: workspaces.length,
      sessions: sessions + homeless.length,
      running: workspaces.reduce((sum, group) => sum + group.running, 0)
        + homeless.filter(session => session.running).length,
      pendingInstructions: instructions.filter(item => item.status === 'pending' || item.status === 'sending').length,
    },
  }
}
