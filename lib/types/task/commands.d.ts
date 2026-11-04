/** `/one task` and `/one tasks` human commands. */
import type { CommandInvocationLike, CommandResultLike, DshContextLike } from '../types.js';
/** `/one tasks [limit]` */
export declare function handleTasks(rest: string, ctx: DshContextLike): CommandResultLike;
/** `/one task add|assign|show|retry|cancel|complete ...` */
export declare function handleTask(rest: string, invocation: CommandInvocationLike, ctx: DshContextLike): CommandResultLike | Promise<CommandResultLike>;
