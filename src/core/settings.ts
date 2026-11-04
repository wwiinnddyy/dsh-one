/**
 * Persisted display preferences for dsh-one.
 *
 * The row configuration is deployment-wide and immutable at runtime, so a
 * user-chosen assistant name lives in the domain instead: the row default
 * seeds it, and a stored override (or an explicit reset) wins from then on.
 */

import type { DshContextLike, SettingRecord } from '../types.js'
import type { OneStore } from '../store/store.js'
import { OneError as OneErrorClass } from '../types.js'
import { now as systemNow } from '../util.js'

/** Settings namespace owned by this module. */
export const SETTINGS_NAMESPACE = 'one'

/** The one setting this build reads: the assistant's display name. */
export const DISPLAY_NAME_KEY = 'displayName'

/** The assistant's real DSH session, so the entry opens a normal conversation. */
export const ASSISTANT_SESSION_KEY = 'assistantSession'

/**
 * The assistant's home directory key.
 *
 * A session without a `cwd` belongs to no Workspace, and the DSH client then
 * refuses to open it without asking the user to pick one. The assistant must
 * therefore own a directory of its own.
 */
export const ASSISTANT_HOME_KEY = 'assistantHome'

/**
 * Whether the assistant may raise notifications.
 *
 * `false` mutes everything except blocks and failures, which is the "don't
 * narrate progress" setting most people actually want.
 */
export const NOTIFY_MUTED_KEY = 'notifyMuted'

/** Longest accepted name, in Unicode code points. */
export const DISPLAY_NAME_MAX_CHARS = 24

/** Version counter bumping on every accepted change, so live surfaces can react. */
export interface SettingsService {
  /** The effective name: the stored override, else the row default. */
  displayName(): string
  /** The row default the deployment declared. */
  defaultDisplayName(): string
  /** True when a stored override exists. */
  hasOverride(): boolean
  /** Persist a human-chosen name and return it, trimmed and validated. */
  setName(value: string, updatedBy?: SettingRecord['updatedBy']): Promise<string>
  /** Drop the override so the row default applies again. */
  resetName(updatedBy?: SettingRecord['updatedBy']): Promise<string>
  /** The session id the assistant conversation lives in, when one was opened. */
  assistantSessionId(): string | undefined
  /** Remember the assistant's session id. */
  setAssistantSessionId(sessionId: string, updatedBy?: SettingRecord['updatedBy']): Promise<void>
  /** Forget the assistant's session, so the next open creates a fresh one. */
  clearAssistantSessionId(updatedBy?: SettingRecord['updatedBy']): Promise<void>
  /** The directory the assistant calls home; `undefined` until it is resolved. */
  assistantHome(): string | undefined
  /** Remember the resolved home directory, so a restart reuses the same one. */
  setAssistantHome(path: string, updatedBy?: SettingRecord['updatedBy']): Promise<void>
  /** Whether progress narration is muted; blocks and failures still break through. */
  notifyMuted(): boolean
  /** Set the mute switch. */
  setNotifyMuted(muted: boolean, updatedBy?: SettingRecord['updatedBy']): Promise<void>
  /** Every persisted setting row, newest namespace first. */
  list(): readonly SettingRecord[]
  /** Subscribe to accepted changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/**
 * Normalize one display name. Control characters and surrounding whitespace
 * are rejected rather than silently rewritten, so a pasted value never lands
 * as a surprise in another surface.
 */
export function normalizeDisplayName(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new OneErrorClass('one/name-empty', 'the assistant name cannot be empty', {})
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OneErrorClass('one/name-invalid', 'the assistant name cannot contain control characters', {})
  }
  const chars = [...value]
  if (chars.length > DISPLAY_NAME_MAX_CHARS) {
    throw new OneErrorClass('one/name-too-long', `the assistant name is limited to ${DISPLAY_NAME_MAX_CHARS} characters`, {
      length: chars.length,
      limit: DISPLAY_NAME_MAX_CHARS,
    })
  }
  return value
}

/** Storage-backed settings service. Every method is safe to call before any write. */
export class OneSettings implements SettingsService {
  private readonly store: OneStore
  private readonly fallback: string
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private cached: string | undefined

  constructor(store: OneStore, defaultDisplayName: string, now: () => number = systemNow) {
    this.store = store
    this.fallback = normalizeDisplayName(defaultDisplayName)
    this.now = now
  }

  displayName(): string {
    return this.cached ?? this.readOverride() ?? this.fallback
  }

  defaultDisplayName(): string {
    return this.fallback
  }

  hasOverride(): boolean {
    return this.readOverride() !== undefined
  }

  async setName(value: string, updatedBy: SettingRecord['updatedBy'] = 'human'): Promise<string> {
    const name = normalizeDisplayName(value)
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: DISPLAY_NAME_KEY,
      value: name,
      updatedAt: this.now(),
      updatedBy,
    })
    this.cached = name
    this.emit()
    return name
  }

  async resetName(updatedBy: SettingRecord['updatedBy'] = 'human'): Promise<string> {
    await this.store.deleteSetting(SETTINGS_NAMESPACE, DISPLAY_NAME_KEY)
    this.cached = undefined
    this.emit()
    return this.fallback
  }

  assistantSessionId(): string | undefined {
    const record = this.store.getSetting(SETTINGS_NAMESPACE, ASSISTANT_SESSION_KEY)
    const value = record?.value.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async setAssistantSessionId(
    sessionId: string,
    updatedBy: SettingRecord['updatedBy'] = 'human',
  ): Promise<void> {
    const value = sessionId.trim()
    if (value === '') {
      throw new OneErrorClass('one/session-id-empty', 'the assistant session id cannot be empty', {})
    }
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: ASSISTANT_SESSION_KEY,
      value,
      updatedAt: this.now(),
      updatedBy,
    })
    this.emit()
  }

  async clearAssistantSessionId(updatedBy: SettingRecord['updatedBy'] = 'human'): Promise<void> {
    void updatedBy
    await this.store.deleteSetting(SETTINGS_NAMESPACE, ASSISTANT_SESSION_KEY)
    this.emit()
  }

  assistantHome(): string | undefined {
    const record = this.store.getSetting(SETTINGS_NAMESPACE, ASSISTANT_HOME_KEY)
    const value = record?.value.trim()
    return value === undefined || value === '' ? undefined : value
  }

  async setAssistantHome(path: string, updatedBy: SettingRecord['updatedBy'] = 'human'): Promise<void> {
    const value = path.trim()
    if (value === '') {
      throw new OneErrorClass('one/home-empty', 'the assistant home directory cannot be empty', {})
    }
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: ASSISTANT_HOME_KEY,
      value,
      updatedAt: this.now(),
      updatedBy,
    })
    this.emit()
  }

  notifyMuted(): boolean {
    const record = this.store.getSetting(SETTINGS_NAMESPACE, NOTIFY_MUTED_KEY)
    return record?.value === 'true'
  }

  async setNotifyMuted(muted: boolean, updatedBy: SettingRecord['updatedBy'] = 'human'): Promise<void> {
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: NOTIFY_MUTED_KEY,
      value: muted ? 'true' : 'false',
      updatedAt: this.now(),
      updatedBy,
    })
    this.emit()
  }

  list(): readonly SettingRecord[] {
    return this.store.listSettings(SETTINGS_NAMESPACE)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private readOverride(): string | undefined {
    const record = this.store.getSetting(SETTINGS_NAMESPACE, DISPLAY_NAME_KEY)
    if (record === undefined) return undefined
    try {
      return normalizeDisplayName(record.value)
    } catch {
      // A row persisted by a future build must not break startup: ignore it.
      return undefined
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A subscriber failure must not break the write that already landed.
      }
    }
  }
}

/** Acquire the service from a context that already mounted the core row. */
export function settingsService(ctx: DshContextLike): SettingsService | undefined {
  return ctx.get('oneSettings') as SettingsService | undefined
}
