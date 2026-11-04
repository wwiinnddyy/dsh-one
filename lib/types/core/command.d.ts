/** `/one` human command: sessions, send, model, status, audit, tasks. It never opens a model turn. */
import type { DshContextLike, OneConfig } from '../types.js';
import { OneCore } from './registry.js';
/** Register the single `/one` command. */
export declare function registerOneCommand(ctx: DshContextLike, core: OneCore, _config: OneConfig): () => void;
