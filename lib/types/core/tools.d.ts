/** The `one_sessions`, `one_send`, `one_model`, and `one_session_create` model-facing tools. */
import type { DshContextLike, OneConfig } from '../types.js';
import { OneCore } from './registry.js';
/** Who the assistant is, as far as these tools are concerned. */
export interface OneToolOptions {
    /** The assistant's own session id; only that caller gets the assistant posture. */
    readonly assistantSessionId?: () => string | undefined;
    /** The name rendered in the origin header. */
    readonly assistantName?: () => string;
}
/** Register the session, send, model, workspace, and session-create tools. */
export declare function registerOneTools(ctx: DshContextLike, core: OneCore, config: OneConfig, options?: OneToolOptions): () => void;
