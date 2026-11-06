/**
 * The `dsh_one_v3` storage domain.
 *
 * A new domain name is deliberate: 0.2.x wrote a different `dsh_one` schema, and
 * reusing the name would force the old rows through new validators. The legacy
 * domain is left untouched, so the rebuild can never corrupt it.
 */

import { z } from 'zod'

export interface DomainTableSpec<Value> {
  readonly valueSchema: z.ZodType<Value>
}

export interface DomainSpec {
  readonly name: string
  readonly version: number
  readonly compatibleVersions?: readonly number[]
  readonly invalidRecords?: 'backup-and-skip'
  readonly tables: Record<string, DomainTableSpec<unknown>>
}

export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/u

export function domainTable<Value>(valueSchema: z.ZodType<Value>): DomainTableSpec<Value> {
  return { valueSchema }
}

export function defineDomain<S extends DomainSpec>(spec: S): S {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer`)
  }
  for (const compatible of spec.compatibleVersions ?? []) {
    if (!Number.isInteger(compatible) || compatible < 0 || compatible >= spec.version) {
      throw new Error(`domain '${spec.name}' compatibleVersions entries must be below ${spec.version}`)
    }
  }
  return spec
}

const nonNegative = z.number().int().nonnegative()

const assignmentSchema = z.object({
  assignmentId: z.string(),
  sessionId: z.string(),
  status: z.enum(['pending', 'running', 'ended']),
  startedAt: nonNegative,
  endedAt: nonNegative.optional(),
  error: z.string().optional(),
})

const reportSchema = z.object({
  reportId: z.string(),
  assignmentId: z.string(),
  sessionId: z.string(),
  kind: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
  summary: z.string(),
  detail: z.string().optional(),
  evidence: z.string().optional(),
  at: nonNegative,
})

const attentionSchema = z.object({
  question: z.string(),
  askedAt: nonNegative,
  answer: z.string().optional(),
  answeredAt: nonNegative.optional(),
})

const deliverySchema = z.object({
  message: z.string(),
  at: nonNegative,
})

export const ticketSchema = z.object({
  ticketId: z.string(),
  title: z.string(),
  goal: z.string(),
  cwd: z.string().optional(),
  status: z.enum(['open', 'ended']),
  outcome: z.enum(['completed', 'dropped', 'cancelled']).optional(),
  assignments: z.array(assignmentSchema),
  latestReport: reportSchema.optional(),
  attention: attentionSchema.optional(),
  delivery: deliverySchema.optional(),
  goalId: z.string().optional(),
  origin: z.enum(['assistant', 'human', 'agent']).optional(),
  assistantLabel: z.string().optional(),
  createdBy: z.string().optional(),
  createdAt: nonNegative,
  updatedAt: nonNegative,
  endedAt: nonNegative.optional(),
  endReason: z.string().optional(),
})

export const goalSchema = z.object({
  goalId: z.string(),
  title: z.string(),
  cwd: z.string().optional(),
  ticketIds: z.array(z.string()),
  createdAt: nonNegative,
  updatedAt: nonNegative,
})

export const effectSchema = z.object({
  effectId: z.string(),
  kind: z.enum(['launch', 'delivery', 'relay', 'notice', 'reply', 'assessment']),
  key: z.string(),
  payload: z.unknown(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  attempts: nonNegative,
  dueAt: nonNegative,
  createdAt: nonNegative,
  updatedAt: nonNegative,
  error: z.string().optional(),
})

export const managedSessionSchema = z.object({
  sessionId: z.string(),
  role: z.enum(['router', 'executor']),
  title: z.string().optional(),
  cwd: z.string().optional(),
  status: z.enum(['active', 'missing', 'error']),
  trusted: z.boolean(),
  createdAt: nonNegative,
  updatedAt: nonNegative,
  lastSeenAt: nonNegative.optional(),
  error: z.string().optional(),
})

export const settingSchema = z.object({
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
  updatedAt: nonNegative,
  updatedBy: z.enum(['human', 'agent', 'system']),
})

export const auditSchema = z.object({
  id: z.string(),
  at: nonNegative,
  action: z.string(),
  actorSessionId: z.string().optional(),
  targetSessionId: z.string().optional(),
  ticketId: z.string().optional(),
  outcome: z.enum(['ok', 'error', 'observed']),
  detail: z.string().optional(),
})

/** One row of the assistant's own conversation, shown only in the assistant page. */
export const chatSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  at: nonNegative,
  status: z.enum(['sending', 'delivered', 'read', 'replied', 'waiting', 'failed']).optional(),
  replyTo: z.string().optional(),
  requestId: z.string().optional(),
  sessionSeq: nonNegative.optional(),
})

export const oneDomainSpec = defineDomain({
  name: 'dsh_one_v3',
  version: 1,
  tables: {
    tickets: domainTable(ticketSchema),
    goals: domainTable(goalSchema),
    effects: domainTable(effectSchema),
    sessions: domainTable(managedSessionSchema),
    settings: domainTable(settingSchema),
    audit: domainTable(auditSchema),
    chat: domainTable(chatSchema),
  },
})
