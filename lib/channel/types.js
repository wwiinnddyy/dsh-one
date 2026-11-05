/**
 * Outbound channel seam for the assistant.
 *
 * The chat channel is the only implementation today. IM (for example QQ via the
 * external `dsh-im` plugin) plugs in here later: an adapter receives the same
 * envelope, so the run runtime never learns which transport spoke.
 */
export {};
