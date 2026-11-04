/** Shared conservative core defaults for rows that load without the core row. */

import type { OneConfig } from '../types.js'

/** The core posture used by delegate/ingress when `oneCore` is not mounted. */
export function defaultCoreConfig(): OneConfig {
  return {
    displayName: '鲸宝',
    assistantHomeRoot: '',
    mode: 'active',
    allowAllSessions: true,
    allowedSessionIds: [],
    allowedWorkspaceRoots: [],
    allowSessionCreation: true,
    maxSendAttempts: 3,
    retryDelayMs: 1000,
    maxMessageChars: 10_000,
    commandTimeoutMs: 30_000,
    modelFallback: true,
    auditLimit: 1000,
    panelEnabled: false,
  }
}
