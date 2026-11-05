/** Model-facing run tools: start immediately, read status, and control. */
import type { DshContextLike, RunService, RunView } from '../types.js';
/** The assistant session is the user's proxy; any other agent stays an agent. */
export interface RunToolOptions {
    readonly assistantSessionId?: () => string | undefined;
}
export declare function registerRunTools(ctx: DshContextLike, service: RunService, timeoutMs: number, options?: RunToolOptions): () => void;
export declare function runJson(run: RunView): Record<string, unknown>;
