/** Model-facing task tools: create, assign, status, report, control. */
import type { DshContextLike, TaskService } from '../types.js';
/** Register the five task tools plus the bounded autonomous loop. */
export declare function registerTaskTools(ctx: DshContextLike, service: TaskService, timeoutMs: number): () => void;
