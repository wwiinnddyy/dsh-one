/** The `one_sessions`, `one_send`, and `one_model` model-facing tools. */
import type { DshContextLike, OneConfig } from './types.js';
import { OneCore } from './core.js';
/** Register the three tools. */
export declare function registerOneTools(ctx: DshContextLike, core: OneCore, config: OneConfig): () => void;
