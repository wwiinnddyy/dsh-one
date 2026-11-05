/** `/one run` and `/one runs` human commands. */
import type { CommandInvocationLike, CommandResultLike, DshContextLike } from '../types.js';
/** `/one runs [limit]` */
export declare function handleRuns(rest: string, ctx: DshContextLike): CommandResultLike;
/** `/one run <goal>`, `/one run show|pause|resume|cancel <runId>`, `/one run resume <runId>`. */
export declare function handleRun(rest: string, invocation: CommandInvocationLike, ctx: DshContextLike): CommandResultLike | Promise<CommandResultLike>;
