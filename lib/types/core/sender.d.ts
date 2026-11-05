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
/**
 * Build the header for one assistant name.
 *
 * Brackets and line breaks are stripped so a crafted name cannot forge a second
 * header, close the quote early, or inject an extra paragraph.
 */
export declare function senderLabelFor(name: string): string;
/**
 * Prefix one message with the header.
 *
 * Idempotent: text that already starts with the exact label is returned as-is,
 * so a retry, a resumed run, or a caller that pre-tagged its text cannot stack
 * two headers.
 */
export declare function withSenderLabel(label: string | undefined, text: string): string;
