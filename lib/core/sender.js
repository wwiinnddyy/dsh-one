/**
 * The visible origin tag on every message the assistant sends to another session.
 *
 * DSH's `sessionController.prompt` is a strict schema with no sender field, and a
 * `user/message` event whose `source.kind` is not `user` renders as a `context`
 * row — which the desktop's `ds-bot` plugin hides. So the only dependable way to
 * tell a human "this instruction came from your assistant, not from you" is a
 * fixed text header inside the message body.
 *
 * The tag is a label, not a security control: `assertOperable`, the outbox, and
 * the three modes are what actually bound what the assistant may do.
 */
/** The placeholder used when the configured name is blank after sanitizing. */
const FALLBACK_NAME = '助手';
/**
 * Build the header for one assistant name.
 *
 * Brackets and line breaks are stripped so a crafted name cannot forge a second
 * header, close the quote early, or inject an extra paragraph.
 */
export function senderLabelFor(name) {
    const safe = name.replace(/[「」\r\n]/gu, ' ').trim() || FALLBACK_NAME;
    return `[来自助手「${safe}」]`;
}
/**
 * Prefix one message with the header.
 *
 * Idempotent: text that already starts with the exact label is returned as-is,
 * so a retry, a resumed run, or a caller that pre-tagged its text cannot stack
 * two headers.
 */
export function withSenderLabel(label, text) {
    if (label === undefined || label === '')
        return text;
    return text.startsWith(label) ? text : `${label}\n\n${text}`;
}
