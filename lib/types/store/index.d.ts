/** Process-wide sharing of the one `dsh-one` domain across the three plugin rows. */
import type { DshContextLike, OneConfig } from '../types.js';
import { OneStore } from './store.js';
export interface StoreLease {
    readonly store: OneStore;
    release(): Promise<void>;
}
/**
 * Acquire the shared store. Each row holds one reference; the last release
 * closes the domain. A row that starts later joins the same open domain.
 */
export declare function acquireStore(ctx: DshContextLike, config: OneConfig): Promise<StoreLease>;
