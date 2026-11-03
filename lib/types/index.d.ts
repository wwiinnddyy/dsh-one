/**
 * dsh-one host plugin: a resident session registry, cross-session outbox, and
 * per-session model selector for DeepSeek Harness.
 *
 * MVP scope: no Super Agent orchestration, no DSH Go native panel, no
 * autonomous execution. Model-initiated tools are observe-only by default.
 */
import z from '@deepseek-ai/schemastery';
import type { DshContextLike, OneConfig } from './types.js';
/** Cordis plugin name. */
export declare const name = "dsh-one";
/** Required services. `sessionController` and `storageDomain` are optional at runtime. */
export declare const inject: string[];
/** Deployment configuration. */
export declare const Config: z<OneConfig>;
/**
 * Open storage, reconcile the registry, and register the command and tools.
 * @param ctx - Cordis context carrying `tools`, `commands`, and optional
 * `sessionController` / `storageDomain`.
 * @param config - validated deployment configuration.
 */
export declare function apply(ctx: DshContextLike, config: OneConfig): Promise<void>;
