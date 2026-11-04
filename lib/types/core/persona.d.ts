/**
 * The assistant's identity.
 *
 * A Session with a `cwd` and nothing else is an ordinary blank conversation —
 * which is exactly what a user sees as "no different from a new chat". This
 * module holds the text that makes the assistant *someone*: what it is, what it
 * may do on its own, and when it must stay quiet.
 *
 * The default is a constant so a fresh install behaves correctly with no setup.
 * A user edit replaces the editable middle; the fixed frame around it is not
 * editable, because those rules are what keep the assistant safe rather than
 * merely well-behaved.
 */
/** Longest accepted user override, so one paste cannot blow up every turn. */
export declare const PERSONA_MAX_CHARS = 8000;
/**
 * Rules the user may rewrite.
 *
 * Everything here is behaviour the owner is entitled to change: tone, scope,
 * how proactive it is. Safety fences live outside this text on purpose.
 */
export declare const DEFAULT_PERSONA: string;
/** Normalize a user edit, rejecting an empty or oversized replacement. */
export declare function normalizePersona(raw: string): string;
/**
 * Compose the final prompt text.
 *
 * The frame is always present, so a user who deletes the safety section in
 * their own edit still cannot talk the assistant out of it.
 */
export declare function composePersona(override?: string): string;
