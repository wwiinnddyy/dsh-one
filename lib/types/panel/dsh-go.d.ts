/** Optional DSH Go native panel, status strip, and toasts. Absent hosts are skipped. */
import type { DshContextLike } from '../types.js';
import type { OneCore } from '../core/registry.js';
import type { SettingsService } from '../core/settings.js';
/** Register the native panel when the DSH Go bridge is present. */
export declare function registerDshGoPanel(ctx: DshContextLike, core: OneCore, settings: SettingsService): () => void;
