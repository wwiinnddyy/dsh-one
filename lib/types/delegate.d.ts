/**
 * dsh-one delegate row: the durable task runtime. It owns task state, worker
 * sessions, workspace leases, slots, token budgets, reports, recovery, and retry.
 */
import z from '@deepseek-ai/schemastery';
import type { DelegateConfig, DshContextLike } from './types.js';
/** Cordis plugin name. */
export declare const name = "dsh-one-delegate";
/** Tools are required. `oneCore` is read opportunistically; a missing core row gets a local registry. */
export declare const inject: string[];
/** Delegate row configuration. */
export declare const Config: z<DelegateConfig>;
/**
 * Open the shared store, recover interrupted assignments, and register the task surface.
 * @param ctx - Cordis context carrying `tools` and optional host services.
 * @param config - validated delegate configuration.
 */
export declare function apply(ctx: DshContextLike, config: DelegateConfig): Promise<void>;
