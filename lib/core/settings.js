/**
 * Persisted display preferences for dsh-one.
 *
 * The row configuration is deployment-wide and immutable at runtime, so a
 * user-chosen assistant name lives in the domain instead: the row default
 * seeds it, and a stored override (or an explicit reset) wins from then on.
 */
import { OneError as OneErrorClass } from '../types.js';
import { now as systemNow } from '../util.js';
/** Settings namespace owned by this module. */
export const SETTINGS_NAMESPACE = 'one';
/** The one setting this build reads: the assistant's display name. */
export const DISPLAY_NAME_KEY = 'displayName';
/** Longest accepted name, in Unicode code points. */
export const DISPLAY_NAME_MAX_CHARS = 24;
/**
 * Normalize one display name. Control characters and surrounding whitespace
 * are rejected rather than silently rewritten, so a pasted value never lands
 * as a surprise in another surface.
 */
export function normalizeDisplayName(raw) {
    const value = raw.trim();
    if (value === '')
        throw new OneErrorClass('one/name-empty', 'the assistant name cannot be empty', {});
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
        throw new OneErrorClass('one/name-invalid', 'the assistant name cannot contain control characters', {});
    }
    const chars = [...value];
    if (chars.length > DISPLAY_NAME_MAX_CHARS) {
        throw new OneErrorClass('one/name-too-long', `the assistant name is limited to ${DISPLAY_NAME_MAX_CHARS} characters`, {
            length: chars.length,
            limit: DISPLAY_NAME_MAX_CHARS,
        });
    }
    return value;
}
/** Storage-backed settings service. Every method is safe to call before any write. */
export class OneSettings {
    store;
    fallback;
    now;
    listeners = new Set();
    cached;
    constructor(store, defaultDisplayName, now = systemNow) {
        this.store = store;
        this.fallback = normalizeDisplayName(defaultDisplayName);
        this.now = now;
    }
    displayName() {
        return this.cached ?? this.readOverride() ?? this.fallback;
    }
    defaultDisplayName() {
        return this.fallback;
    }
    hasOverride() {
        return this.readOverride() !== undefined;
    }
    async setName(value, updatedBy = 'human') {
        const name = normalizeDisplayName(value);
        await this.store.putSetting({
            namespace: SETTINGS_NAMESPACE,
            key: DISPLAY_NAME_KEY,
            value: name,
            updatedAt: this.now(),
            updatedBy,
        });
        this.cached = name;
        this.emit();
        return name;
    }
    async resetName(updatedBy = 'human') {
        await this.store.deleteSetting(SETTINGS_NAMESPACE, DISPLAY_NAME_KEY);
        this.cached = undefined;
        this.emit();
        return this.fallback;
    }
    list() {
        return this.store.listSettings(SETTINGS_NAMESPACE);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    readOverride() {
        const record = this.store.getSetting(SETTINGS_NAMESPACE, DISPLAY_NAME_KEY);
        if (record === undefined)
            return undefined;
        try {
            return normalizeDisplayName(record.value);
        }
        catch {
            // A row persisted by a future build must not break startup: ignore it.
            return undefined;
        }
    }
    emit() {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            }
            catch {
                // A subscriber failure must not break the write that already landed.
            }
        }
    }
}
/** Acquire the service from a context that already mounted the core row. */
export function settingsService(ctx) {
    return ctx.get('oneSettings');
}
