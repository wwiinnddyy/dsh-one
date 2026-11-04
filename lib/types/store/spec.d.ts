/**
 * The `dsh-one` storage domain declaration.
 *
 * The helpers mirror `@deepseek-ai/dsh-storage-domain`'s load-time contract
 * (name/version/table validation) without importing that package at runtime,
 * so the plugin still loads on a host whose profile tree cannot resolve it.
 */
import { z } from 'zod';
export interface DomainTableSpec<Value> {
    readonly valueSchema: z.ZodType<Value>;
}
export interface DomainSpec {
    readonly name: string;
    readonly version: number;
    readonly layout?: 'single' | 'per-record';
    readonly compatibleVersions?: readonly number[];
    readonly invalidRecords?: 'backup-and-skip';
    readonly tables: Record<string, DomainTableSpec<unknown>>;
}
/** Mirrors `@deepseek-ai/dsh-storage`'s name rule. */
export declare const UNIT_NAME_RE: RegExp;
/** Declare one table. */
export declare function domainTable<Value>(valueSchema: z.ZodType<Value>): DomainTableSpec<Value>;
/** Validate a domain declaration at module load. */
export declare function defineDomain<S extends DomainSpec>(spec: S): S;
export declare const managedSessionSchema: z.ZodObject<{
    sessionId: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    workspaceId: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    status: z.ZodEnum<{
        error: "error";
        active: "active";
        missing: "missing";
    }>;
    trusted: z.ZodBoolean;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    lastSeenAt: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const outboxSchema: z.ZodObject<{
    requestId: z.ZodString;
    callerSessionId: z.ZodOptional<z.ZodString>;
    targetSessionId: z.ZodString;
    text: z.ZodString;
    mode: z.ZodEnum<{
        queue: "queue";
        steer: "steer";
    }>;
    source: z.ZodEnum<{
        tool: "tool";
        command: "command";
    }>;
    status: z.ZodEnum<{
        failed: "failed";
        cancelled: "cancelled";
        unknown: "unknown";
        pending: "pending";
        sent: "sent";
        observed: "observed";
        sending: "sending";
    }>;
    attempts: z.ZodNumber;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    completedAt: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const auditSchema: z.ZodObject<{
    id: z.ZodString;
    at: z.ZodNumber;
    action: z.ZodString;
    actorSessionId: z.ZodOptional<z.ZodString>;
    targetSessionId: z.ZodOptional<z.ZodString>;
    taskId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
    outcome: z.ZodEnum<{
        error: "error";
        observed: "observed";
        ok: "ok";
    }>;
    detail: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const usageSchema: z.ZodObject<{
    inputTokens: z.ZodNumber;
    outputTokens: z.ZodNumber;
    cacheReadTokens: z.ZodNumber;
    cacheWriteTokens: z.ZodNumber;
    totalTokens: z.ZodNumber;
    lastUsageSeq: z.ZodNumber;
}, z.core.$strip>;
export declare const assignmentSchema: z.ZodObject<{
    assignmentId: z.ZodString;
    kind: z.ZodEnum<{
        initial: "initial";
        retry: "retry";
    }>;
    sessionId: z.ZodString;
    status: z.ZodEnum<{
        assigned: "assigned";
        running: "running";
        waiting: "waiting";
        ready: "ready";
        failed: "failed";
        done: "done";
        cancelled: "cancelled";
        unknown: "unknown";
    }>;
    promptStatus: z.ZodEnum<{
        failed: "failed";
        unknown: "unknown";
        pending: "pending";
        sent: "sent";
    }>;
    promptRequestId: z.ZodString;
    permissionPreset: z.ZodOptional<z.ZodString>;
    agentPreset: z.ZodOptional<z.ZodString>;
    leaseId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const inputSchema: z.ZodObject<{
    inputId: z.ZodString;
    kind: z.ZodEnum<{
        human: "human";
        work: "work";
        recovery: "recovery";
        "policy-changed": "policy-changed";
    }>;
    text: z.ZodString;
    requestId: z.ZodString;
    createdAt: z.ZodNumber;
    deliveredAt: z.ZodOptional<z.ZodNumber>;
    deliveryStatus: z.ZodEnum<{
        failed: "failed";
        unknown: "unknown";
        pending: "pending";
        sent: "sent";
    }>;
}, z.core.$strip>;
export declare const reportSchema: z.ZodObject<{
    reportId: z.ZodString;
    kind: z.ZodEnum<{
        waiting: "waiting";
        ready: "ready";
        blocked: "blocked";
        failed: "failed";
        progress: "progress";
        dropped: "dropped";
    }>;
    summary: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    evidence: z.ZodOptional<z.ZodString>;
    assignmentId: z.ZodString;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
export declare const attentionSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        waiting: "waiting";
        blocked: "blocked";
        failed: "failed";
        report: "report";
        budget: "budget";
        mandate: "mandate";
    }>;
    reason: z.ZodString;
    since: z.ZodNumber;
}, z.core.$strip>;
export declare const sourceRefSchema: z.ZodObject<{
    sourceId: z.ZodString;
    threadId: z.ZodString;
    externalId: z.ZodString;
    url: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const taskSchema: z.ZodObject<{
    taskId: z.ZodString;
    title: z.ZodString;
    goal: z.ZodString;
    status: z.ZodEnum<{
        queued: "queued";
        assigned: "assigned";
        running: "running";
        waiting: "waiting";
        ready: "ready";
        blocked: "blocked";
        failed: "failed";
        done: "done";
        cancelled: "cancelled";
    }>;
    origin: z.ZodEnum<{
        human: "human";
        agent: "agent";
        source: "source";
    }>;
    priority: z.ZodNumber;
    cwd: z.ZodString;
    workspaceMode: z.ZodEnum<{
        lease: "lease";
        shared: "shared";
    }>;
    assignments: z.ZodArray<z.ZodObject<{
        assignmentId: z.ZodString;
        kind: z.ZodEnum<{
            initial: "initial";
            retry: "retry";
        }>;
        sessionId: z.ZodString;
        status: z.ZodEnum<{
            assigned: "assigned";
            running: "running";
            waiting: "waiting";
            ready: "ready";
            failed: "failed";
            done: "done";
            cancelled: "cancelled";
            unknown: "unknown";
        }>;
        promptStatus: z.ZodEnum<{
            failed: "failed";
            unknown: "unknown";
            pending: "pending";
            sent: "sent";
        }>;
        promptRequestId: z.ZodString;
        permissionPreset: z.ZodOptional<z.ZodString>;
        agentPreset: z.ZodOptional<z.ZodString>;
        leaseId: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    inputs: z.ZodArray<z.ZodObject<{
        inputId: z.ZodString;
        kind: z.ZodEnum<{
            human: "human";
            work: "work";
            recovery: "recovery";
            "policy-changed": "policy-changed";
        }>;
        text: z.ZodString;
        requestId: z.ZodString;
        createdAt: z.ZodNumber;
        deliveredAt: z.ZodOptional<z.ZodNumber>;
        deliveryStatus: z.ZodEnum<{
            failed: "failed";
            unknown: "unknown";
            pending: "pending";
            sent: "sent";
        }>;
    }, z.core.$strip>>;
    latestReport: z.ZodOptional<z.ZodObject<{
        reportId: z.ZodString;
        kind: z.ZodEnum<{
            waiting: "waiting";
            ready: "ready";
            blocked: "blocked";
            failed: "failed";
            progress: "progress";
            dropped: "dropped";
        }>;
        summary: z.ZodString;
        detail: z.ZodOptional<z.ZodString>;
        evidence: z.ZodOptional<z.ZodString>;
        assignmentId: z.ZodString;
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        createdAt: z.ZodNumber;
    }, z.core.$strip>>;
    attention: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            waiting: "waiting";
            blocked: "blocked";
            failed: "failed";
            report: "report";
            budget: "budget";
            mandate: "mandate";
        }>;
        reason: z.ZodString;
        since: z.ZodNumber;
    }, z.core.$strip>>;
    mandateId: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodObject<{
        sourceId: z.ZodString;
        threadId: z.ZodString;
        externalId: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    usage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheWriteTokens: z.ZodNumber;
        totalTokens: z.ZodNumber;
        lastUsageSeq: z.ZodNumber;
    }, z.core.$strip>;
    tokenBudget: z.ZodNumber;
    createdBy: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    completedAt: z.ZodOptional<z.ZodNumber>;
    blockedReason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const leaseSchema: z.ZodObject<{
    leaseId: z.ZodString;
    workspace: z.ZodString;
    ownerTaskId: z.ZodString;
    ownerAssignmentId: z.ZodString;
    status: z.ZodEnum<{
        active: "active";
        released: "released";
        expired: "expired";
    }>;
    acquiredAt: z.ZodNumber;
    heartbeatAt: z.ZodNumber;
    expiresAt: z.ZodNumber;
}, z.core.$strip>;
export declare const reportRowSchema: z.ZodObject<{
    reportId: z.ZodString;
    kind: z.ZodEnum<{
        waiting: "waiting";
        ready: "ready";
        blocked: "blocked";
        failed: "failed";
        progress: "progress";
        dropped: "dropped";
    }>;
    summary: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    evidence: z.ZodOptional<z.ZodString>;
    assignmentId: z.ZodString;
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    createdAt: z.ZodNumber;
    taskId: z.ZodString;
}, z.core.$strip>;
export declare const triggerSchema: z.ZodObject<{
    triggerId: z.ZodString;
    sourceId: z.ZodString;
    repository: z.ZodString;
    eventKind: z.ZodString;
    externalEventId: z.ZodString;
    actor: z.ZodString;
    threadId: z.ZodString;
    receivedAt: z.ZodNumber;
    gate: z.ZodEnum<{
        pass: "pass";
        reject: "reject";
        ignore: "ignore";
    }>;
    gateReason: z.ZodOptional<z.ZodString>;
    evalId: z.ZodOptional<z.ZodString>;
    decision: z.ZodOptional<z.ZodEnum<{
        accept: "accept";
        "would-accept": "would-accept";
        decline: "decline";
        "observe-only": "observe-only";
        "no-delegate": "no-delegate";
    }>>;
    taskId: z.ZodOptional<z.ZodString>;
    payload: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const threadSchema: z.ZodObject<{
    threadId: z.ZodString;
    sourceId: z.ZodString;
    repository: z.ZodString;
    externalId: z.ZodString;
    number: z.ZodNumber;
    title: z.ZodString;
    url: z.ZodOptional<z.ZodString>;
    isPullRequest: z.ZodBoolean;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    lastTriggerId: z.ZodOptional<z.ZodString>;
    evalId: z.ZodOptional<z.ZodString>;
    taskId: z.ZodOptional<z.ZodString>;
    accepted: z.ZodNumber;
    declined: z.ZodNumber;
}, z.core.$strip>;
export declare const assessmentSchema: z.ZodObject<{
    ruleId: z.ZodString;
    pass: z.ZodBoolean;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const evalSchema: z.ZodObject<{
    evalId: z.ZodString;
    triggerId: z.ZodString;
    threadId: z.ZodString;
    status: z.ZodEnum<{
        queued: "queued";
        running: "running";
        settled: "settled";
    }>;
    policyVersion: z.ZodString;
    gate: z.ZodEnum<{
        pass: "pass";
        reject: "reject";
    }>;
    gateReason: z.ZodOptional<z.ZodString>;
    assessment: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        pass: z.ZodBoolean;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    outcome: z.ZodOptional<z.ZodEnum<{
        accept: "accept";
        "would-accept": "would-accept";
        decline: "decline";
    }>>;
    reason: z.ZodOptional<z.ZodString>;
    payload: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    settledAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const decisionSchema: z.ZodObject<{
    decisionId: z.ZodString;
    evalId: z.ZodString;
    threadId: z.ZodString;
    triggerId: z.ZodString;
    outcome: z.ZodEnum<{
        accept: "accept";
        "would-accept": "would-accept";
        decline: "decline";
        "observe-only": "observe-only";
        "no-delegate": "no-delegate";
    }>;
    reasons: z.ZodArray<z.ZodString>;
    policyVersion: z.ZodString;
    taskId: z.ZodOptional<z.ZodString>;
    mandateId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
export declare const policyRuleSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    required: z.ZodBoolean;
    denyPattern: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const policySchema: z.ZodObject<{
    policyId: z.ZodString;
    version: z.ZodString;
    strength: z.ZodEnum<{
        advisory: "advisory";
        standard: "standard";
        strict: "strict";
    }>;
    scope: z.ZodString;
    rules: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        required: z.ZodBoolean;
        denyPattern: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    hash: z.ZodString;
    createdAt: z.ZodNumber;
    supersededBy: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const mandateSchema: z.ZodObject<{
    mandateId: z.ZodString;
    taskId: z.ZodString;
    threadId: z.ZodString;
    policyVersion: z.ZodString;
    strength: z.ZodEnum<{
        advisory: "advisory";
        standard: "standard";
        strict: "strict";
    }>;
    scope: z.ZodString;
    basis: z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        pass: z.ZodBoolean;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
export declare const deliverySchema: z.ZodObject<{
    deliveryId: z.ZodString;
    sourceId: z.ZodString;
    direction: z.ZodEnum<{
        in: "in";
        out: "out";
    }>;
    externalId: z.ZodString;
    status: z.ZodEnum<{
        failed: "failed";
        sent: "sent";
        received: "received";
        duplicate: "duplicate";
        accepted: "accepted";
        rejected: "rejected";
    }>;
    at: z.ZodNumber;
    detail: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const cursorSchema: z.ZodObject<{
    cursorId: z.ZodString;
    sourceId: z.ZodString;
    repository: z.ZodString;
    value: z.ZodString;
    etag: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodNumber;
}, z.core.$strip>;
export declare const subscriptionSchema: z.ZodObject<{
    subscriptionId: z.ZodString;
    taskId: z.ZodString;
    threadId: z.ZodString;
    sourceId: z.ZodString;
    mode: z.ZodEnum<{
        reply: "reply";
        none: "none";
    }>;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
/**
 * One user-facing preference row. `namespace` groups settings by surface and
 * `key` is the row name, so a single table carries every mutable setting
 * without widening the domain schema per preference.
 */
export declare const settingSchema: z.ZodObject<{
    namespace: z.ZodString;
    key: z.ZodString;
    value: z.ZodString;
    updatedAt: z.ZodNumber;
    updatedBy: z.ZodEnum<{
        human: "human";
        agent: "agent";
        system: "system";
    }>;
}, z.core.$strip>;
/** Domain declaration consumed by `ctx.storageDomain.open`. */
export declare const oneDomainSpec: {
    name: string;
    version: number;
    compatibleVersions: number[];
    tables: {
        sessions: DomainTableSpec<{
            sessionId: string;
            status: "error" | "active" | "missing";
            trusted: boolean;
            createdAt: number;
            updatedAt: number;
            title?: string | undefined;
            workspaceId?: string | undefined;
            cwd?: string | undefined;
            model?: {
                provider: string;
                model: string;
                reasoningEffort?: string | undefined;
            } | undefined;
            lastSeenAt?: number | undefined;
            error?: string | undefined;
        }>;
        outbox: DomainTableSpec<{
            requestId: string;
            targetSessionId: string;
            text: string;
            mode: "queue" | "steer";
            source: "tool" | "command";
            status: "failed" | "cancelled" | "unknown" | "pending" | "sent" | "observed" | "sending";
            attempts: number;
            createdAt: number;
            updatedAt: number;
            callerSessionId?: string | undefined;
            completedAt?: number | undefined;
            error?: string | undefined;
        }>;
        audit: DomainTableSpec<{
            id: string;
            at: number;
            action: string;
            outcome: "error" | "observed" | "ok";
            actorSessionId?: string | undefined;
            targetSessionId?: string | undefined;
            taskId?: string | undefined;
            requestId?: string | undefined;
            detail?: string | undefined;
        }>;
        tasks: DomainTableSpec<{
            taskId: string;
            title: string;
            goal: string;
            status: "queued" | "assigned" | "running" | "waiting" | "ready" | "blocked" | "failed" | "done" | "cancelled";
            origin: "human" | "agent" | "source";
            priority: number;
            cwd: string;
            workspaceMode: "lease" | "shared";
            assignments: {
                assignmentId: string;
                kind: "initial" | "retry";
                sessionId: string;
                status: "assigned" | "running" | "waiting" | "ready" | "failed" | "done" | "cancelled" | "unknown";
                promptStatus: "failed" | "unknown" | "pending" | "sent";
                promptRequestId: string;
                createdAt: number;
                updatedAt: number;
                permissionPreset?: string | undefined;
                agentPreset?: string | undefined;
                leaseId?: string | undefined;
                error?: string | undefined;
            }[];
            inputs: {
                inputId: string;
                kind: "human" | "work" | "recovery" | "policy-changed";
                text: string;
                requestId: string;
                createdAt: number;
                deliveryStatus: "failed" | "unknown" | "pending" | "sent";
                deliveredAt?: number | undefined;
            }[];
            usage: {
                inputTokens: number;
                outputTokens: number;
                cacheReadTokens: number;
                cacheWriteTokens: number;
                totalTokens: number;
                lastUsageSeq: number;
            };
            tokenBudget: number;
            createdAt: number;
            updatedAt: number;
            latestReport?: {
                reportId: string;
                kind: "waiting" | "ready" | "blocked" | "failed" | "progress" | "dropped";
                summary: string;
                assignmentId: string;
                sessionId: string;
                seq: number;
                createdAt: number;
                detail?: string | undefined;
                evidence?: string | undefined;
            } | undefined;
            attention?: {
                kind: "waiting" | "blocked" | "failed" | "report" | "budget" | "mandate";
                reason: string;
                since: number;
            } | undefined;
            mandateId?: string | undefined;
            source?: {
                sourceId: string;
                threadId: string;
                externalId: string;
                url?: string | undefined;
            } | undefined;
            createdBy?: string | undefined;
            completedAt?: number | undefined;
            blockedReason?: string | undefined;
        }>;
        leases: DomainTableSpec<{
            leaseId: string;
            workspace: string;
            ownerTaskId: string;
            ownerAssignmentId: string;
            status: "active" | "released" | "expired";
            acquiredAt: number;
            heartbeatAt: number;
            expiresAt: number;
        }>;
        reports: DomainTableSpec<{
            reportId: string;
            kind: "waiting" | "ready" | "blocked" | "failed" | "progress" | "dropped";
            summary: string;
            assignmentId: string;
            sessionId: string;
            seq: number;
            createdAt: number;
            taskId: string;
            detail?: string | undefined;
            evidence?: string | undefined;
        }>;
        triggers: DomainTableSpec<{
            triggerId: string;
            sourceId: string;
            repository: string;
            eventKind: string;
            externalEventId: string;
            actor: string;
            threadId: string;
            receivedAt: number;
            gate: "pass" | "reject" | "ignore";
            gateReason?: string | undefined;
            evalId?: string | undefined;
            decision?: "accept" | "would-accept" | "decline" | "observe-only" | "no-delegate" | undefined;
            taskId?: string | undefined;
            payload?: string | undefined;
        }>;
        threads: DomainTableSpec<{
            threadId: string;
            sourceId: string;
            repository: string;
            externalId: string;
            number: number;
            title: string;
            isPullRequest: boolean;
            createdAt: number;
            updatedAt: number;
            accepted: number;
            declined: number;
            url?: string | undefined;
            lastTriggerId?: string | undefined;
            evalId?: string | undefined;
            taskId?: string | undefined;
        }>;
        evals: DomainTableSpec<{
            evalId: string;
            triggerId: string;
            threadId: string;
            status: "queued" | "running" | "settled";
            policyVersion: string;
            gate: "pass" | "reject";
            createdAt: number;
            updatedAt: number;
            gateReason?: string | undefined;
            assessment?: {
                ruleId: string;
                pass: boolean;
                note?: string | undefined;
            }[] | undefined;
            outcome?: "accept" | "would-accept" | "decline" | undefined;
            reason?: string | undefined;
            payload?: string | undefined;
            settledAt?: number | undefined;
        }>;
        decisions: DomainTableSpec<{
            decisionId: string;
            evalId: string;
            threadId: string;
            triggerId: string;
            outcome: "accept" | "would-accept" | "decline" | "observe-only" | "no-delegate";
            reasons: string[];
            policyVersion: string;
            createdAt: number;
            taskId?: string | undefined;
            mandateId?: string | undefined;
        }>;
        policies: DomainTableSpec<{
            policyId: string;
            version: string;
            strength: "advisory" | "standard" | "strict";
            scope: string;
            rules: {
                id: string;
                text: string;
                required: boolean;
                denyPattern?: string | undefined;
            }[];
            hash: string;
            createdAt: number;
            supersededBy?: string | undefined;
        }>;
        mandates: DomainTableSpec<{
            mandateId: string;
            taskId: string;
            threadId: string;
            policyVersion: string;
            strength: "advisory" | "standard" | "strict";
            scope: string;
            basis: {
                ruleId: string;
                pass: boolean;
                note?: string | undefined;
            }[];
            createdAt: number;
        }>;
        deliveries: DomainTableSpec<{
            deliveryId: string;
            sourceId: string;
            direction: "in" | "out";
            externalId: string;
            status: "failed" | "sent" | "received" | "duplicate" | "accepted" | "rejected";
            at: number;
            detail?: string | undefined;
        }>;
        cursors: DomainTableSpec<{
            cursorId: string;
            sourceId: string;
            repository: string;
            value: string;
            updatedAt: number;
            etag?: string | undefined;
        }>;
        subscriptions: DomainTableSpec<{
            subscriptionId: string;
            taskId: string;
            threadId: string;
            sourceId: string;
            mode: "reply" | "none";
            createdAt: number;
        }>;
        settings: DomainTableSpec<{
            namespace: string;
            key: string;
            value: string;
            updatedAt: number;
            updatedBy: "human" | "agent" | "system";
        }>;
    };
};
