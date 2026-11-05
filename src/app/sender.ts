/**
 * The visible origin tag on messages the assistant sends to another session.
 *
 * DSH's `sessionController.prompt` has no sender field and a non-user message
 * source renders as a `context` row some clients hide, so the origin travels as
 * a fixed text header. It is a label, not a security control.
 */

const FALLBACK_NAME = '助手'

export function senderLabelFor(name: string): string {
  const safe = name.replace(/[「」\r\n]/gu, ' ').trim() || FALLBACK_NAME
  return `[来自助手「${safe}」]`
}

export function withSenderLabel(label: string | undefined, text: string): string {
  if (label === undefined || label === '') return text
  return text.startsWith(label) ? text : `${label}\n\n${text}`
}
