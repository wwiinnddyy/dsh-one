/** Read-only `/one/api/*` routes for the Web client panel. */
import type { DshContextLike, PanelOverview } from '../types.js';
import type { OneCore } from '../core/registry.js';
/** Register the panel's read endpoints. They never open storage themselves. */
export declare function registerPanelApi(ctx: DshContextLike, core: OneCore): () => void;
/** Build the same overview the HTTP route serves; the DSH Go panel reads it directly. */
export declare function buildPanelOverview(ctx: DshContextLike, core: OneCore): PanelOverview;
