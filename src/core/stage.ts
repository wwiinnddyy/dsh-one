/**
 * The Ticket stage table.
 *
 * Read top to bottom; the first matching row wins. This is the only place that
 * answers "what is this Ticket waiting for", so tools, the panel and the router
 * never infer it differently.
 */

import type { Ticket, TicketStage } from './model.js'

export function stageOf(ticket: Ticket): TicketStage {
  if (ticket.status === 'ended') return 'ended'
  // A person must act before the work can continue.
  if (ticket.delivery !== undefined) return 'person/delivery'
  if (ticket.attention !== undefined && ticket.attention.answer === undefined) return 'person/answer'
  if (ticket.latestReport?.kind === 'ready') return 'person/review'
  if (ticket.latestReport?.kind === 'blocked') return 'person/blocked'
  if (ticket.latestReport?.kind === 'failed') return 'person/failed'
  // Work that has not started, or waits for a slot.
  const running = ticket.assignments.find(item => item.status === 'running')
  if (running === undefined) {
    const pending = ticket.assignments.some(item => item.status === 'pending')
    if (ticket.assignments.length === 0 || pending) return 'working/queued'
    // The last Assignment ended without an outstanding question.
    return 'idle'
  }
  return 'working'
}

export function isTerminal(ticket: Ticket): boolean {
  return ticket.status === 'ended'
}
