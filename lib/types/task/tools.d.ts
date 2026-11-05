/** Model-facing task tools: create, assign, status, report, control. */
import type { DshContextLike, TaskService } from '../types.js';
/** Register the five task tools. Background goals live in `src/run/tools.ts`. */
export declare function registerTaskTools(ctx: DshContextLike, service: TaskService, timeoutMs: number, options?: TaskToolOptions): () => void;
/** Who counts as the assistant, so only its tasks carry the origin header. */
export interface TaskToolOptions {
    readonly assistantSessionId?: () => string | undefined;
    readonly assistantName?: () => string;
}
