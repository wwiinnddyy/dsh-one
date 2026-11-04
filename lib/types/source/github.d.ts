/** GitHub source adapter: HMAC webhook verification, comment polling, and replies. */
import type { DispatchEvent, GithubSourceConfig, HttpRequestLike, HttpResponseLike, ThreadRecord } from '../types.js';
import type { OneStore } from '../store/store.js';
export interface WebhookEnvelope {
    readonly deliveryId: string;
    readonly eventType: string;
    readonly events: readonly DispatchEvent[];
}
/** Read a bounded request body; rejects oversize input with 413. */
export declare function readBody(req: HttpRequestLike, maxBytes: number): Promise<string>;
/** Write one JSON response. */
export declare function jsonResponse(res: HttpResponseLike, status: number, value: unknown): void;
/** Case-insensitive header read. */
export declare function headerOf(headers: HttpRequestLike['headers'], name: string): string | undefined;
export declare class GithubSource {
    private readonly config;
    private readonly store;
    private readonly now;
    constructor(config: GithubSourceConfig, store: OneStore, now?: () => number);
    /** Verify one webhook and parse its events. */
    verify(headers: HttpRequestLike['headers'], rawBody: string): WebhookEnvelope;
    /** Poll issue comments for each configured repository. */
    poll(signal?: AbortSignal): Promise<DispatchEvent[]>;
    /** Post one comment on the thread. */
    reply(thread: ThreadRecord, text: string, key: string): Promise<void>;
    private parsePayload;
    private issueEvent;
}
/** Build one acceptance reply key so a delivery retry is identifiable. */
export declare function confirmationKey(taskId: string): string;
/** Log one poll failure without leaking the token. */
export declare function pollErrorDetail(error: unknown): string;
