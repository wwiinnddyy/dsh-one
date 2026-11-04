/** Read-only `/one/api/*` routes for the Web client panel. */
import type { DshContextLike, PanelOverview } from '../types.js';
import type { OneCore } from '../core/registry.js';
import type { SettingsService } from '../core/settings.js';
/** Register the panel's read endpoints and the one settings write endpoint. */
export declare function registerPanelApi(ctx: DshContextLike, core: OneCore, settings: SettingsService): () => void;
/** Build the same overview the HTTP route serves; the DSH Go panel reads it directly. */
export declare function buildPanelOverview(ctx: DshContextLike, core: OneCore, settings: SettingsService): PanelOverview;
