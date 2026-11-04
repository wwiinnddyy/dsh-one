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
import type { SessionView } from '../types.js';
/** One Session as the assistant sees it from outside a Workspace. */
export interface WorkspaceSessionView {
    readonly sessionId: string;
    readonly title?: string;
    readonly running: boolean;
    readonly blank: boolean;
    readonly registered: boolean;
    readonly lastSeenAt?: number;
}
/** One Workspace: a canonical directory and the Sessions that live under it. */
export interface WorkspaceGroup {
    /** Canonical absolute path, or `''` for the ungrouped bucket. */
    readonly path: string;
    /** Human-facing label: the final path segment, or a marker for the bucket. */
    readonly label: string;
    readonly sessions: readonly WorkspaceSessionView[];
    /** Sessions currently executing a turn. */
    readonly running: number;
    /** Sessions that exist but were not registered by this plugin. */
    readonly unregistered: number;
    readonly lastActivityAt?: number;
}
/** One outstanding instruction the assistant sent into another Session. */
export interface InstructionView {
    readonly requestId: string;
    readonly targetSessionId: string;
    readonly targetWorkspace: string;
    readonly status: string;
    readonly attempts: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly text: string;
    readonly error?: string;
}
/** The whole cross-Workspace picture the assistant reasons over. */
export interface WorkspaceOverview {
    readonly workspaces: readonly WorkspaceGroup[];
    /** Sessions whose `cwd` is missing, so no Workspace can own them. */
    readonly homeless: readonly WorkspaceSessionView[];
    readonly instructions: readonly InstructionView[];
    readonly totals: {
        readonly workspaces: number;
        readonly sessions: number;
        readonly running: number;
        readonly pendingInstructions: number;
    };
}
/** Normalize a path for grouping, independent of separators and trailing slash. */
export declare function canonicalPath(raw: string): string;
/** The final segment of a canonical path, for a Workspace's display label. */
export declare function workspaceLabel(path: string): string;
/**
 * Group Sessions by Workspace.
 *
 * Sessions are only ever grouped by `cwd`; a Session without one cannot belong
 * to a Workspace, so it lands in `homeless` instead of being guessed into a
 * bucket. Ordering is by recent activity so the assistant sees active work
 * first, and an empty path sorts last because it is not a real project.
 */
export declare function groupSessionsByWorkspace(items: readonly SessionView[]): {
    readonly workspaces: readonly WorkspaceGroup[];
    readonly homeless: readonly WorkspaceSessionView[];
};
/** Build the assistant's full cross-Workspace overview. */
export declare function buildWorkspaceOverview(input: {
    readonly sessions: readonly SessionView[];
    readonly instructions: readonly {
        readonly requestId: string;
        readonly targetSessionId: string;
        readonly status: string;
        readonly attempts: number;
        readonly createdAt: number;
        readonly updatedAt: number;
        readonly text: string;
        readonly error?: string;
    }[];
}): WorkspaceOverview;
