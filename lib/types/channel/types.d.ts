/**
 * Outbound channel seam for the assistant.
 *
 * The chat channel is the only implementation today. IM (for example QQ via the
 * external `dsh-im` plugin) plugs in here later: an adapter receives the same
 * envelope, so the run runtime never learns which transport spoke.
 */
export interface WakeEnvelope {
    readonly runId: string;
    readonly targetSessionId: string;
    readonly reason: 'done' | 'needs-you' | 'failed';
    readonly text: string;
    readonly cwd: string;
    readonly at: number;
    /** Stable identity; two channels must not deliver the same wake twice. */
    readonly dedupeKey: string;
}
export interface ChannelDelivery {
    readonly status: 'sent' | 'failed';
    readonly error?: string;
}
export interface AssistantChannel {
    readonly id: 'web' | 'im';
    deliver(wake: WakeEnvelope): Promise<ChannelDelivery>;
}
