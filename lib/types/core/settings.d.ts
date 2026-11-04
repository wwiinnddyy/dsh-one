/**
 * Persisted display preferences for dsh-one.
 *
 * The row configuration is deployment-wide and immutable at runtime, so a
 * user-chosen assistant name lives in the domain instead: the row default
 * seeds it, and a stored override (or an explicit reset) wins from then on.
 */
import type { DshContextLike, SettingRecord } from '../types.js';
import type { OneStore } from '../store/store.js';
/** Settings namespace owned by this module. */
export declare const SETTINGS_NAMESPACE = "one";
/** The one setting this build reads: the assistant's display name. */
export declare const DISPLAY_NAME_KEY = "displayName";
/** The assistant's real DSH session, so the entry opens a normal conversation. */
export declare const ASSISTANT_SESSION_KEY = "assistantSession";
/** Longest accepted name, in Unicode code points. */
export declare const DISPLAY_NAME_MAX_CHARS = 24;
/** Version counter bumping on every accepted change, so live surfaces can react. */
export interface SettingsService {
    /** The effective name: the stored override, else the row default. */
    displayName(): string;
    /** The row default the deployment declared. */
    defaultDisplayName(): string;
    /** True when a stored override exists. */
    hasOverride(): boolean;
    /** Persist a human-chosen name and return it, trimmed and validated. */
    setName(value: string, updatedBy?: SettingRecord['updatedBy']): Promise<string>;
    /** Drop the override so the row default applies again. */
    resetName(updatedBy?: SettingRecord['updatedBy']): Promise<string>;
    /** The session id the assistant conversation lives in, when one was opened. */
    assistantSessionId(): string | undefined;
    /** Remember the assistant's session id. */
    setAssistantSessionId(sessionId: string, updatedBy?: SettingRecord['updatedBy']): Promise<void>;
    /** Forget the assistant's session, so the next open creates a fresh one. */
    clearAssistantSessionId(updatedBy?: SettingRecord['updatedBy']): Promise<void>;
    /** Every persisted setting row, newest namespace first. */
    list(): readonly SettingRecord[];
    /** Subscribe to accepted changes; returns the unsubscribe function. */
    subscribe(listener: () => void): () => void;
}
/**
 * Normalize one display name. Control characters and surrounding whitespace
 * are rejected rather than silently rewritten, so a pasted value never lands
 * as a surprise in another surface.
 */
export declare function normalizeDisplayName(raw: string): string;
/** Storage-backed settings service. Every method is safe to call before any write. */
export declare class OneSettings implements SettingsService {
    private readonly store;
    private readonly fallback;
    private readonly now;
    private readonly listeners;
    private cached;
    constructor(store: OneStore, defaultDisplayName: string, now?: () => number);
    displayName(): string;
    defaultDisplayName(): string;
    hasOverride(): boolean;
    setName(value: string, updatedBy?: SettingRecord['updatedBy']): Promise<string>;
    resetName(updatedBy?: SettingRecord['updatedBy']): Promise<string>;
    assistantSessionId(): string | undefined;
    setAssistantSessionId(sessionId: string, updatedBy?: SettingRecord['updatedBy']): Promise<void>;
    clearAssistantSessionId(updatedBy?: SettingRecord['updatedBy']): Promise<void>;
    list(): readonly SettingRecord[];
    subscribe(listener: () => void): () => void;
    private readOverride;
    private emit;
}
/** Acquire the service from a context that already mounted the core row. */
export declare function settingsService(ctx: DshContextLike): SettingsService | undefined;
