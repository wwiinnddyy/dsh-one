/**
 * dsh-one ingress row: source adapters, webhook route, trigger/thread/eval,
 * policy, mandate, decision, and acceptance. Disabled by default.
 */
import z from '@deepseek-ai/schemastery';
import type { DshContextLike, IngressConfig } from './types.js';
/** Cordis plugin name. */
export declare const name = "dsh-one-ingress";
/** No required surface beyond the optional host services read through `ctx.get`. */
export declare const inject: string[];
/** Ingress row configuration. */
export declare const Config: z<IngressConfig>;
/**
 * Mount source intake. The row is disabled in the shipped patch; enabling it
 * requires a webhook secret, repository list, and actor allowlist.
 * @param ctx - Cordis context with optional `webServer`, `connection`, and `oneCore`.
 * @param config - validated ingress configuration.
 */
export declare function apply(ctx: DshContextLike, config: IngressConfig): Promise<void>;
