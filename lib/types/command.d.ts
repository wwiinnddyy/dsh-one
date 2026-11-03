/** `/one` human command: sessions, send, model, status, audit. It never opens a model turn. */
import type { DshContextLike, OneConfig } from './types.js';
import { OneCore } from './core.js';
/** Register the single `/one` command. */
export declare function registerOneCommand(ctx: DshContextLike, core: OneCore, config: OneConfig): () => void;
