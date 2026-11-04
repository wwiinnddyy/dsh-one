/**
 * dsh-one core row: session registry, cross-session outbox, audit, `/one`,
 * the session tools, and the read-only Web panel routes.
 */
import z from '@deepseek-ai/schemastery';
import type { DshContextLike, OneConfig } from './types.js';
/** Cordis plugin name. */
export declare const name = "dsh-one";
/** Required services. `sessionController`, `storageDomain`, and `webServer` are optional. */
export declare const inject: string[];
/** Core row configuration. */
export declare const Config: z<OneConfig>;
/**
 * Open storage, reconcile the registry, and register the core surfaces.
 * @param ctx - Cordis context carrying `tools`, `commands`, and optional host services.
 * @param config - validated deployment configuration.
 */
export declare function apply(ctx: DshContextLike, config: OneConfig): Promise<void>;
