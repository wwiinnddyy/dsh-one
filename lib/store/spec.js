/**
 * The `dsh-one` storage domain declaration.
 *
 * The helpers mirror `@deepseek-ai/dsh-storage-domain`'s load-time contract
 * (name/version/table validation) without importing that package at runtime,
 * so the plugin still loads on a host whose profile tree cannot resolve it.
 */
import { z } from 'zod';
/** Mirrors `@deepseek-ai/dsh-storage`'s name rule. */
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/u;
/** Declare one table. */
export function domainTable(valueSchema) {
    return { valueSchema };
}
/** Validate a domain declaration at module load. */
export function defineDomain(spec) {
    if (!UNIT_NAME_RE.test(spec.name))
        throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
    if (!Number.isInteger(spec.version) || spec.version < 0) {
        throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
    }
    for (const compatible of spec.compatibleVersions ?? []) {
        if (!Number.isInteger(compatible) || compatible < 0 || compatible >= spec.version) {
            throw new Error(`domain '${spec.name}' compatibleVersions entries must be below version ${spec.version}, got ${compatible}`);
        }
    }
    if (spec.layout !== undefined && spec.layout !== 'single' && spec.layout !== 'per-record') {
        throw new Error(`domain '${spec.name}' has an unknown layout '${String(spec.layout)}'`);
    }
    if (spec.invalidRecords !== undefined && spec.invalidRecords !== 'backup-and-skip') {
        throw new Error(`domain '${spec.name}' has an unknown invalidRecords policy`);
    }
    for (const table of Object.keys(spec.tables)) {
        if (!UNIT_NAME_RE.test(table)) {
            throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
        }
    }
    return spec;
}
const nonNegative = z.number().int().nonnegative();
const modelSelectionSchema = z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
});
export const managedSessionSchema = z.object({
    sessionId: z.string(),
    title: z.string().optional(),
    workspaceId: z.string().optional(),
    cwd: z.string().optional(),
    model: modelSelectionSchema.optional(),
    status: z.enum(['active', 'missing', 'error']),
    trusted: z.boolean(),
    createdAt: nonNegative,
    updatedAt: nonNegative,
    lastSeenAt: nonNegative.optional(),
    error: z.string().optional(),
});
export const outboxSchema = z.object({
    requestId: z.string(),
    callerSessionId: z.string().optional(),
    targetSessionId: z.string(),
    text: z.string(),
    // Optional so rows written by an older build still load.
    deliveredText: z.string().optional(),
    senderLabel: z.string().optional(),
    mode: z.enum(['queue', 'steer']),
    source: z.enum(['tool', 'command', 'wake', 'assistant']),
    status: z.enum(['pending', 'sending', 'sent', 'observed', 'failed', 'unknown', 'cancelled']),
    attempts: nonNegative,
    createdAt: nonNegative,
    updatedAt: nonNegative,
    completedAt: nonNegative.optional(),
    error: z.string().optional(),
});
export const auditSchema = z.object({
    id: z.string(),
    at: nonNegative,
    action: z.string(),
    actorSessionId: z.string().optional(),
    targetSessionId: z.string().optional(),
    taskId: z.string().optional(),
    requestId: z.string().optional(),
    outcome: z.enum(['ok', 'error', 'observed']),
    detail: z.string().optional(),
});
export const usageSchema = z.object({
    inputTokens: nonNegative,
    outputTokens: nonNegative,
    cacheReadTokens: nonNegative,
    cacheWriteTokens: nonNegative,
    totalTokens: nonNegative,
    lastUsageSeq: z.number().int(),
});
export const assignmentSchema = z.object({
    assignmentId: z.string(),
    kind: z.enum(['initial', 'retry']),
    sessionId: z.string(),
    status: z.enum(['assigned', 'running', 'waiting', 'ready', 'unknown', 'done', 'failed', 'cancelled']),
    promptStatus: z.enum(['pending', 'sent', 'unknown', 'failed']),
    promptRequestId: z.string(),
    permissionPreset: z.string().optional(),
    agentPreset: z.string().optional(),
    leaseId: z.string().optional(),
    createdAt: nonNegative,
    updatedAt: nonNegative,
    error: z.string().optional(),
});
export const inputSchema = z.object({
    inputId: z.string(),
    kind: z.enum(['work', 'recovery', 'policy-changed', 'human']),
    text: z.string(),
    requestId: z.string(),
    createdAt: nonNegative,
    deliveredAt: nonNegative.optional(),
    deliveryStatus: z.enum(['pending', 'sent', 'unknown', 'failed']),
});
export const reportSchema = z.object({
    reportId: z.string(),
    kind: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
    summary: z.string(),
    detail: z.string().optional(),
    evidence: z.string().optional(),
    assignmentId: z.string(),
    sessionId: z.string(),
    seq: z.number().int(),
    createdAt: nonNegative,
});
export const attentionSchema = z.object({
    kind: z.enum(['report', 'blocked', 'failed', 'waiting', 'budget', 'mandate']),
    reason: z.string(),
    since: nonNegative,
});
export const sourceRefSchema = z.object({
    sourceId: z.string(),
    threadId: z.string(),
    externalId: z.string(),
    url: z.string().optional(),
});
export const taskSchema = z.object({
    taskId: z.string(),
    title: z.string(),
    goal: z.string(),
    status: z.enum(['queued', 'assigned', 'running', 'waiting', 'ready', 'blocked', 'failed', 'done', 'cancelled']),
    origin: z.enum(['human', 'agent', 'source']),
    priority: z.number(),
    cwd: z.string(),
    workspaceMode: z.enum(['lease', 'shared']),
    assignments: z.array(assignmentSchema),
    inputs: z.array(inputSchema),
    latestReport: reportSchema.optional(),
    attention: attentionSchema.optional(),
    mandateId: z.string().optional(),
    source: sourceRefSchema.optional(),
    runId: z.string().optional(),
    assistantLabel: z.string().optional(),
    usage: usageSchema,
    tokenBudget: nonNegative,
    createdBy: z.string().optional(),
    createdAt: nonNegative,
    updatedAt: nonNegative,
    completedAt: nonNegative.optional(),
    blockedReason: z.string().optional(),
});
export const leaseSchema = z.object({
    leaseId: z.string(),
    workspace: z.string(),
    ownerTaskId: z.string(),
    ownerAssignmentId: z.string(),
    status: z.enum(['active', 'released', 'expired']),
    acquiredAt: nonNegative,
    heartbeatAt: nonNegative,
    expiresAt: nonNegative,
});
export const reportRowSchema = reportSchema.extend({ taskId: z.string() });
export const triggerSchema = z.object({
    triggerId: z.string(),
    sourceId: z.string(),
    repository: z.string(),
    eventKind: z.string(),
    externalEventId: z.string(),
    actor: z.string(),
    threadId: z.string(),
    receivedAt: nonNegative,
    gate: z.enum(['pass', 'reject', 'ignore']),
    gateReason: z.string().optional(),
    evalId: z.string().optional(),
    decision: z.enum(['would-accept', 'accept', 'decline', 'observe-only', 'no-delegate']).optional(),
    taskId: z.string().optional(),
    payload: z.string().optional(),
});
export const threadSchema = z.object({
    threadId: z.string(),
    sourceId: z.string(),
    repository: z.string(),
    externalId: z.string(),
    number: nonNegative,
    title: z.string(),
    url: z.string().optional(),
    isPullRequest: z.boolean(),
    createdAt: nonNegative,
    updatedAt: nonNegative,
    lastTriggerId: z.string().optional(),
    evalId: z.string().optional(),
    taskId: z.string().optional(),
    accepted: nonNegative,
    declined: nonNegative,
});
export const assessmentSchema = z.object({
    ruleId: z.string(),
    pass: z.boolean(),
    note: z.string().optional(),
});
export const evalSchema = z.object({
    evalId: z.string(),
    triggerId: z.string(),
    threadId: z.string(),
    status: z.enum(['queued', 'running', 'settled']),
    policyVersion: z.string(),
    gate: z.enum(['pass', 'reject']),
    gateReason: z.string().optional(),
    assessment: z.array(assessmentSchema).optional(),
    outcome: z.enum(['accept', 'decline', 'would-accept']).optional(),
    reason: z.string().optional(),
    payload: z.string().optional(),
    createdAt: nonNegative,
    updatedAt: nonNegative,
    settledAt: nonNegative.optional(),
});
export const decisionSchema = z.object({
    decisionId: z.string(),
    evalId: z.string(),
    threadId: z.string(),
    triggerId: z.string(),
    outcome: z.enum(['accept', 'decline', 'would-accept', 'observe-only', 'no-delegate']),
    reasons: z.array(z.string()),
    policyVersion: z.string(),
    taskId: z.string().optional(),
    mandateId: z.string().optional(),
    createdAt: nonNegative,
});
export const policyRuleSchema = z.object({
    id: z.string(),
    text: z.string(),
    required: z.boolean(),
    denyPattern: z.string().optional(),
});
export const policySchema = z.object({
    policyId: z.string(),
    version: z.string(),
    strength: z.enum(['advisory', 'standard', 'strict']),
    scope: z.string(),
    rules: z.array(policyRuleSchema),
    hash: z.string(),
    createdAt: nonNegative,
    supersededBy: z.string().optional(),
});
export const mandateSchema = z.object({
    mandateId: z.string(),
    taskId: z.string(),
    threadId: z.string(),
    policyVersion: z.string(),
    strength: z.enum(['advisory', 'standard', 'strict']),
    scope: z.string(),
    basis: z.array(assessmentSchema),
    createdAt: nonNegative,
});
export const deliverySchema = z.object({
    deliveryId: z.string(),
    sourceId: z.string(),
    direction: z.enum(['in', 'out']),
    externalId: z.string(),
    status: z.enum(['received', 'duplicate', 'accepted', 'rejected', 'failed', 'sent']),
    at: nonNegative,
    detail: z.string().optional(),
});
export const cursorSchema = z.object({
    cursorId: z.string(),
    sourceId: z.string(),
    repository: z.string(),
    value: z.string(),
    etag: z.string().optional(),
    updatedAt: nonNegative,
});
export const subscriptionSchema = z.object({
    subscriptionId: z.string(),
    taskId: z.string(),
    threadId: z.string(),
    sourceId: z.string(),
    mode: z.enum(['reply', 'none']),
    createdAt: nonNegative,
});
/**
 * One user-facing preference row. `namespace` groups settings by surface and
 * `key` is the row name, so a single table carries every mutable setting
 * without widening the domain schema per preference.
 */
export const settingSchema = z.object({
    namespace: z.string(),
    key: z.string(),
    value: z.string(),
    updatedAt: nonNegative,
    updatedBy: z.enum(['human', 'agent', 'system']),
});
export const runStepSchema = z.object({
    index: nonNegative,
    taskId: z.string(),
    title: z.string(),
    goal: z.string(),
    cwd: z.string().optional(),
});
export const runSchema = z.object({
    runId: z.string(),
    goal: z.string(),
    title: z.string(),
    cwd: z.string(),
    cwdLabel: z.string(),
    origin: z.enum(['human', 'assistant', 'agent']),
    mode: z.enum(['execute', 'observed']),
    assistantSessionId: z.string().optional(),
    status: z.enum(['active', 'needs-you', 'done', 'failed', 'cancelled', 'exhausted']),
    paused: z.boolean(),
    pauseReason: z.string().optional(),
    steps: z.array(runStepSchema),
    limits: z.object({ maxTasks: nonNegative, deadlineMs: nonNegative }),
    deadlineAt: nonNegative,
    activitySeq: nonNegative,
    seen: z.record(z.string(), z.string()),
    attention: z.object({
        reason: z.string(),
        taskId: z.string().optional(),
        since: nonNegative,
    }).optional(),
    verdict: z.string().optional(),
    createdAt: nonNegative,
    updatedAt: nonNegative,
    terminalAt: nonNegative.optional(),
});
export const runActivitySchema = z.object({
    activityId: z.string(),
    runId: z.string(),
    seq: nonNegative,
    taskId: z.string().optional(),
    cwd: z.string(),
    at: nonNegative,
    kind: z.enum([
        'run-started', 'step-dispatched', 'step-done', 'step-failed', 'step-blocked',
        'run-done', 'run-failed', 'run-paused', 'run-resumed', 'run-cancelled', 'run-exhausted',
        'quiet-suppressed', 'wake-sent', 'wake-suppressed', 'recovered',
    ]),
    level: z.enum(['info', 'attention', 'error']),
    title: z.string(),
    detail: z.string().optional(),
    dedupeKey: z.string().optional(),
});
export const runWakeSchema = z.object({
    wakeId: z.string(),
    runId: z.string(),
    reason: z.enum(['done', 'needs-you', 'failed']),
    requestId: z.string(),
    status: z.enum(['pending', 'sending', 'sent', 'suppressed', 'failed', 'unknown']),
    suppressedBy: z.string().optional(),
    attempts: nonNegative,
    createdAt: nonNegative,
    updatedAt: nonNegative,
    error: z.string().optional(),
});
/** Domain declaration consumed by `ctx.storageDomain.open`. */
export const oneDomainSpec = defineDomain({
    name: 'dsh_one',
    version: 2,
    compatibleVersions: [1],
    tables: {
        sessions: domainTable(managedSessionSchema),
        outbox: domainTable(outboxSchema),
        audit: domainTable(auditSchema),
        tasks: domainTable(taskSchema),
        leases: domainTable(leaseSchema),
        reports: domainTable(reportRowSchema),
        triggers: domainTable(triggerSchema),
        threads: domainTable(threadSchema),
        evals: domainTable(evalSchema),
        decisions: domainTable(decisionSchema),
        policies: domainTable(policySchema),
        mandates: domainTable(mandateSchema),
        deliveries: domainTable(deliverySchema),
        cursors: domainTable(cursorSchema),
        subscriptions: domainTable(subscriptionSchema),
        settings: domainTable(settingSchema),
        runs: domainTable(runSchema),
        run_activities: domainTable(runActivitySchema),
        run_wakes: domainTable(runWakeSchema),
    },
});
