/** dsh-one core: registry, access policy, outbox, audit, and host adapters. */
import { OneError as OneErrorClass } from './types.js';
import { asString, classifyError, isAbortError, isRetryable, isSubagentRefusal, nextId, now as systemNow, pathWithin, preview, REQUEST_ID_PATTERN, sleep as systemSleep, } from './util.js';
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
/** Process-local, in-process implementation behind commands and tools. */
export class OneCore {
    controller;
    store;
    config;
    now;
    sleeper;
    inflight = new Map();
    startError;
    reconciledAt;
    constructor(ctx, config, store, hooks = {}) {
        this.config = config;
        this.store = store;
        this.controller = ctx.get('sessionController');
        this.now = hooks.now ?? systemNow;
        this.sleeper = hooks.sleep ?? systemSleep;
    }
    /** Reconcile the registry once the host has settled its Session service. */
    async start() {
        if (this.controller === undefined) {
            this.startError = 'sessionController is unavailable; cross-session actions will fail';
            return;
        }
        try {
            await this.reconcile();
        }
        catch (error) {
            this.startError = `registry reconciliation failed: ${classifyError(error).message}`;
        }
    }
    get degraded() {
        return this.store.degraded;
    }
    get lastError() {
        return this.startError;
    }
    get lastReconciledAt() {
        return this.reconciledAt;
    }
    /**
     * Compare registered sessions with `session/list`. A missing registration
     * is created only when `allowSessionCreation` is on; otherwise it stays
     * visible as `missing`.
     */
    async reconcile() {
        const controller = this.requireController();
        const signal = this.timedSignal();
        const listed = await controller.list({}, signal);
        const byId = new Map(listed.items.map(item => [item.sessionId, item]));
        const at = this.now();
        for (const record of this.store.listSessions()) {
            const summary = byId.get(record.sessionId);
            if (summary !== undefined) {
                await this.store.putSession({
                    ...record,
                    status: 'active',
                    lastSeenAt: at,
                    updatedAt: at,
                    cwd: record.cwd ?? summary.cwd,
                    error: undefined,
                });
                continue;
            }
            if (!this.config.allowSessionCreation) {
                await this.store.putSession({
                    ...record,
                    status: 'missing',
                    updatedAt: at,
                    error: 'registered session is absent and allowSessionCreation is false',
                });
                continue;
            }
            try {
                const created = await controller.create({
                    sessionId: record.sessionId,
                    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
                    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
                });
                if (created.sessionId !== record.sessionId) {
                    await this.store.putSession({
                        ...record,
                        status: 'error',
                        updatedAt: at,
                        error: `host created session "${created.sessionId}" instead of "${record.sessionId}"`,
                    });
                    continue;
                }
                await this.store.putSession({
                    ...record,
                    status: 'active',
                    lastSeenAt: at,
                    updatedAt: at,
                    error: undefined,
                });
                await this.audit({
                    action: 'session_created',
                    targetSessionId: record.sessionId,
                    outcome: 'ok',
                    detail: 'created a missing registered session during reconciliation',
                });
            }
            catch (error) {
                await this.store.putSession({
                    ...record,
                    status: 'error',
                    updatedAt: at,
                    error: classifyError(error).message,
                });
            }
        }
        this.reconciledAt = at;
    }
    /** List registered sessions plus the host's current session list. */
    async listSessions() {
        const records = new Map(this.store.listSessions().map(record => [record.sessionId, record]));
        const controller = this.controller;
        if (controller === undefined) {
            return {
                items: [...records.values()].map(record => this.viewFromRecord(record)),
                degraded: this.degraded,
                ...(this.reconciledAt === undefined ? {} : { reconciledAt: this.reconciledAt }),
                error: this.startError,
            };
        }
        const signal = this.timedSignal();
        let listed;
        try {
            listed = await controller.list({}, signal);
        }
        catch (error) {
            return {
                items: [...records.values()].map(record => this.viewFromRecord(record)),
                degraded: this.degraded,
                ...(this.reconciledAt === undefined ? {} : { reconciledAt: this.reconciledAt }),
                error: `session/list failed: ${classifyError(error).message}`,
            };
        }
        const items = [];
        const seen = new Set();
        for (const summary of listed.items) {
            seen.add(summary.sessionId);
            const record = records.get(summary.sessionId);
            items.push(this.viewFromSummary(summary, record));
        }
        for (const record of records.values()) {
            if (!seen.has(record.sessionId))
                items.push(this.viewFromRecord(record));
        }
        return {
            items: items.sort((a, b) => Number(b.running) - Number(a.running) || a.sessionId.localeCompare(b.sessionId)),
            degraded: this.degraded,
            ...(this.reconciledAt === undefined ? {} : { reconciledAt: this.reconciledAt }),
            ...(this.startError === undefined ? {} : { error: this.startError }),
        };
    }
    /**
     * Explicitly register one session for cross-session operations. This is a
     * human command path; tools cannot call it.
     */
    async registerSession(input) {
        this.assertSessionId(input.sessionId);
        const controller = this.requireController();
        const signal = this.timedSignal();
        const listed = await controller.list({}, signal);
        const summary = listed.items.find(item => item.sessionId === input.sessionId);
        if (summary !== undefined && this.isSubagent(summary)) {
            throw new OneErrorClass('one/subagent-target', `session "${input.sessionId}" belongs to subagent routing`, {
                sessionId: input.sessionId,
            });
        }
        if (summary === undefined && !this.config.allowSessionCreation) {
            throw new OneErrorClass('one/session-not-found', `session "${input.sessionId}" is absent and creation is disabled`, {
                sessionId: input.sessionId,
            });
        }
        if (summary === undefined && input.cwd === undefined && input.workspaceId === undefined) {
            throw new OneErrorClass('one/workspace-required', 'registering a missing session requires cwd or workspaceId', {
                sessionId: input.sessionId,
            });
        }
        if (input.cwd !== undefined)
            this.assertWorkspaceAllowed(input.cwd);
        if (input.workspaceId !== undefined && this.config.allowedWorkspaceRoots.length > 0 && input.cwd === undefined) {
            throw new OneErrorClass('one/workspace-required', 'workspaceId registration requires cwd for the workspace boundary check', {
                sessionId: input.sessionId,
            });
        }
        const at = this.now();
        let summaryCwd = summary?.cwd;
        if (summary === undefined) {
            const created = await controller.create({
                sessionId: input.sessionId,
                ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            });
            if (created.sessionId !== input.sessionId) {
                throw new OneErrorClass('one/session-create-mismatch', 'host created a different session identity', {
                    requested: input.sessionId,
                    created: created.sessionId,
                });
            }
            summaryCwd = input.cwd;
        }
        const existing = this.store.getSession(input.sessionId);
        const record = {
            sessionId: input.sessionId,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
            ...((input.cwd ?? summaryCwd) === undefined ? {} : { cwd: input.cwd ?? summaryCwd }),
            ...(existing?.model === undefined ? {} : { model: existing.model }),
            status: 'active',
            trusted: true,
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
            lastSeenAt: at,
        };
        await this.store.putSession(record);
        await this.audit({
            action: 'session_registered',
            targetSessionId: input.sessionId,
            outcome: 'ok',
            detail: preview(input.cwd ?? summaryCwd ?? 'no cwd'),
        });
        return record;
    }
    /** Send a user message to another ordinary session, with retries and idempotency. */
    async send(input) {
        this.assertSessionId(input.targetSessionId);
        if (input.text.trim() === '')
            throw new OneErrorClass('one/invalid-argument', 'text must not be blank');
        if (input.text.length > this.config.maxMessageChars) {
            throw new OneErrorClass('one/message-too-long', `text exceeds ${this.config.maxMessageChars} characters`, {
                length: input.text.length,
                max: this.config.maxMessageChars,
            });
        }
        const requestId = input.requestId ?? nextId('one');
        if (!REQUEST_ID_PATTERN.test(requestId)) {
            throw new OneErrorClass('one/invalid-request-id', 'requestId must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}', {
                requestId,
            });
        }
        const mode = input.mode ?? 'queue';
        const existing = this.store.getOutbox(requestId);
        if (existing !== undefined) {
            if (existing.targetSessionId !== input.targetSessionId || existing.text !== input.text || existing.mode !== mode) {
                throw new OneErrorClass('one/request-conflict', `requestId "${requestId}" already names a different send`, {
                    requestId,
                });
            }
            return this.resultOf(existing);
        }
        const target = await this.resolveTarget(input.targetSessionId);
        this.assertOperable(target, input.callerSessionId);
        const at = this.now();
        const base = {
            requestId,
            ...(input.callerSessionId === undefined ? {} : { callerSessionId: input.callerSessionId }),
            targetSessionId: input.targetSessionId,
            text: input.text,
            mode,
            source: input.source,
            status: 'pending',
            attempts: 0,
            createdAt: at,
            updatedAt: at,
        };
        if (input.source === 'tool' && this.config.mode === 'observe') {
            const observed = { ...base, status: 'observed' };
            await this.store.putOutbox(observed);
            await this.audit({
                action: 'send_observed',
                actorSessionId: input.callerSessionId,
                targetSessionId: input.targetSessionId,
                requestId,
                outcome: 'observed',
                detail: preview(input.text),
            });
            return this.resultOf(observed);
        }
        await this.store.putOutbox(base);
        await this.audit({
            action: 'send_started',
            actorSessionId: input.callerSessionId,
            targetSessionId: input.targetSessionId,
            requestId,
            outcome: 'ok',
            detail: `${mode}: ${preview(input.text)}`,
        });
        const running = this.inflight.get(requestId);
        if (running !== undefined)
            return running;
        const promise = this.executeSend(base, input.signal)
            .finally(() => {
            this.inflight.delete(requestId);
        });
        this.inflight.set(requestId, promise);
        return promise;
    }
    async executeSend(base, callerSignal) {
        const controller = this.requireController();
        const signal = this.combineSignal(callerSignal);
        let lastError = 'send did not finish';
        let attemptsUsed = 0;
        for (let attempt = 1; attempt <= this.config.maxSendAttempts; attempt += 1) {
            attemptsUsed = attempt;
            if (signal.aborted) {
                const cancelled = {
                    ...base,
                    status: 'cancelled',
                    attempts: attempt - 1,
                    updatedAt: this.now(),
                    completedAt: this.now(),
                    error: 'cancelled before delivery',
                };
                await this.store.putOutbox(cancelled);
                await this.audit({
                    action: 'send_cancelled',
                    actorSessionId: base.callerSessionId,
                    targetSessionId: base.targetSessionId,
                    requestId: base.requestId,
                    outcome: 'error',
                    detail: 'cancelled before delivery',
                });
                return this.resultOf(cancelled);
            }
            const sending = {
                ...base,
                status: 'sending',
                attempts: attempt,
                updatedAt: this.now(),
            };
            await this.store.putOutbox(sending);
            try {
                await controller.prompt({
                    requestId: base.requestId,
                    sessionId: base.targetSessionId,
                    mode: base.mode,
                    content: [{ type: 'text', text: base.text }],
                }, signal);
                const sent = {
                    ...base,
                    status: 'sent',
                    attempts: attempt,
                    updatedAt: this.now(),
                    completedAt: this.now(),
                };
                await this.store.putOutbox(sent);
                await this.audit({
                    action: 'send_sent',
                    actorSessionId: base.callerSessionId,
                    targetSessionId: base.targetSessionId,
                    requestId: base.requestId,
                    outcome: 'ok',
                    detail: `attempt ${attempt}`,
                });
                return this.resultOf(sent);
            }
            catch (error) {
                lastError = classifyError(error).message;
                if (isAbortError(error, signal)) {
                    const cancelled = {
                        ...base,
                        status: 'cancelled',
                        attempts: attempt,
                        updatedAt: this.now(),
                        completedAt: this.now(),
                        error: lastError,
                    };
                    await this.store.putOutbox(cancelled);
                    await this.audit({
                        action: 'send_cancelled',
                        actorSessionId: base.callerSessionId,
                        targetSessionId: base.targetSessionId,
                        requestId: base.requestId,
                        outcome: 'error',
                        detail: lastError,
                    });
                    return this.resultOf(cancelled);
                }
                if (isSubagentRefusal(error)) {
                    const failed = {
                        ...base,
                        status: 'failed',
                        attempts: attempt,
                        updatedAt: this.now(),
                        completedAt: this.now(),
                        error: 'target is owned by subagent routing; use its parent session',
                    };
                    await this.store.putOutbox(failed);
                    await this.audit({
                        action: 'send_failed',
                        actorSessionId: base.callerSessionId,
                        targetSessionId: base.targetSessionId,
                        requestId: base.requestId,
                        outcome: 'error',
                        detail: failed.error ?? lastError,
                    });
                    return this.resultOf(failed);
                }
                if (attempt < this.config.maxSendAttempts && isRetryable(error)) {
                    await this.audit({
                        action: 'send_retry',
                        actorSessionId: base.callerSessionId,
                        targetSessionId: base.targetSessionId,
                        requestId: base.requestId,
                        outcome: 'error',
                        detail: `attempt ${attempt}: ${lastError}`,
                    });
                    try {
                        await this.sleeper(this.config.retryDelayMs * 2 ** (attempt - 1), signal);
                    }
                    catch (sleepError) {
                        const cancelled = {
                            ...base,
                            status: 'cancelled',
                            attempts: attempt,
                            updatedAt: this.now(),
                            completedAt: this.now(),
                            error: isAbortError(sleepError, signal) ? 'cancelled during retry backoff' : classifyError(sleepError).message,
                        };
                        await this.store.putOutbox(cancelled);
                        await this.audit({
                            action: 'send_cancelled',
                            actorSessionId: base.callerSessionId,
                            targetSessionId: base.targetSessionId,
                            requestId: base.requestId,
                            outcome: 'error',
                            detail: cancelled.error ?? lastError,
                        });
                        return this.resultOf(cancelled);
                    }
                    continue;
                }
                break;
            }
        }
        const failed = {
            ...base,
            status: 'failed',
            attempts: attemptsUsed,
            updatedAt: this.now(),
            completedAt: this.now(),
            error: lastError,
        };
        await this.store.putOutbox(failed);
        await this.audit({
            action: 'send_failed',
            actorSessionId: base.callerSessionId,
            targetSessionId: base.targetSessionId,
            requestId: base.requestId,
            outcome: 'error',
            detail: lastError,
        });
        return this.resultOf(failed);
    }
    /** Select a model for one session, with catalog validation and a fallback route. */
    async selectModel(input) {
        this.assertSessionId(input.targetSessionId);
        if (input.provider.trim() === '' || input.model.trim() === '') {
            throw new OneErrorClass('one/invalid-argument', 'provider and model must not be blank');
        }
        const target = await this.resolveTarget(input.targetSessionId);
        this.assertOperable(target, input.callerSessionId);
        if (input.source === 'tool' && this.config.mode === 'observe') {
            await this.audit({
                action: 'model_observed',
                actorSessionId: input.callerSessionId,
                targetSessionId: input.targetSessionId,
                outcome: 'observed',
                detail: `${input.provider}/${input.model}`,
            });
            return {
                sessionId: input.targetSessionId,
                provider: input.provider,
                model: input.model,
                ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
                selected: false,
                observed: true,
                fallbackUsed: false,
            };
        }
        const controller = this.requireController();
        const signal = this.combineSignal(input.signal);
        const catalog = await controller.modelCatalog();
        let fallbackUsed = false;
        let selection = {
            provider: input.provider,
            model: input.model,
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        };
        if (!modelAvailable(catalog, selection)) {
            if (!this.config.modelFallback) {
                throw new OneErrorClass('one/model-unavailable', `model route ${input.provider}/${input.model} is not available`, { provider: input.provider, model: input.model });
            }
            selection = fallbackSelection(catalog, input.provider);
            fallbackUsed = true;
        }
        let selected;
        try {
            selected = (await controller.selectModel({ sessionId: input.targetSessionId, ...selection })).selected;
        }
        catch (error) {
            const classified = classifyError(error);
            if (classified.code !== 'session/model-unavailable' || !this.config.modelFallback || fallbackUsed)
                throw error;
            selection = catalog.default;
            fallbackUsed = true;
            selected = (await controller.selectModel({ sessionId: input.targetSessionId, ...selection })).selected;
        }
        const at = this.now();
        const existing = this.store.getSession(input.targetSessionId);
        const record = {
            sessionId: input.targetSessionId,
            ...(existing?.title === undefined ? {} : { title: existing.title }),
            ...(existing?.workspaceId === undefined ? {} : { workspaceId: existing.workspaceId }),
            ...((existing?.cwd ?? target.cwd) === undefined ? {} : { cwd: existing?.cwd ?? target.cwd }),
            model: selected,
            status: 'active',
            trusted: existing?.trusted ?? false,
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
            lastSeenAt: at,
        };
        await this.store.putSession(record);
        await this.audit({
            action: fallbackUsed ? 'model_fallback' : 'model_selected',
            actorSessionId: input.callerSessionId,
            targetSessionId: input.targetSessionId,
            outcome: 'ok',
            detail: `${selected.provider}/${selected.model}${fallbackUsed ? ` (from ${input.provider}/${input.model})` : ''}`,
        });
        return {
            sessionId: input.targetSessionId,
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
            selected: true,
            observed: false,
            fallbackUsed,
        };
    }
    getOutbox(requestId) {
        const record = this.store.getOutbox(requestId);
        if (record === undefined)
            throw new OneErrorClass('one/request-not-found', `request "${requestId}" was not found`, { requestId });
        return record;
    }
    listAudit(limit = 20) {
        return this.store.listAudit(limit);
    }
    async dispose() {
        await this.store.close();
    }
    requireController() {
        if (this.controller === undefined) {
            throw new OneErrorClass('one/unavailable', 'sessionController is unavailable in this profile', {});
        }
        return this.controller;
    }
    timedSignal() {
        return AbortSignal.timeout(this.config.commandTimeoutMs);
    }
    combineSignal(signal) {
        const timeout = AbortSignal.timeout(this.config.commandTimeoutMs);
        return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    }
    assertSessionId(sessionId) {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
            throw new OneErrorClass('one/invalid-session-id', `invalid session id "${sessionId}"`, { sessionId });
        }
    }
    assertWorkspaceAllowed(cwd) {
        if (this.config.allowedWorkspaceRoots.length === 0)
            return;
        if (this.config.allowedWorkspaceRoots.some(root => pathWithin(root, cwd)))
            return;
        throw new OneErrorClass('one/workspace-forbidden', `workspace "${cwd}" is outside the allowed roots`, { cwd });
    }
    async resolveTarget(sessionId) {
        const controller = this.requireController();
        const signal = this.timedSignal();
        const listed = await controller.list({}, signal);
        const summary = listed.items.find(item => item.sessionId === sessionId);
        if (summary === undefined) {
            throw new OneErrorClass('one/session-not-found', `session "${sessionId}" is not in session/list`, { sessionId });
        }
        if (this.isSubagent(summary)) {
            throw new OneErrorClass('one/subagent-target', `session "${sessionId}" is owned by subagent routing`, { sessionId });
        }
        return summary;
    }
    isSubagent(summary) {
        return summary.origin === 'subagent' || summary.parentSessionId !== undefined;
    }
    assertOperable(target, callerSessionId) {
        if (this.config.allowAllSessions)
            return;
        if (callerSessionId !== undefined && target.sessionId === callerSessionId)
            return;
        if (this.config.allowedSessionIds.includes(target.sessionId))
            return;
        const record = this.store.getSession(target.sessionId);
        if (record?.trusted === true)
            return;
        if (this.config.allowedWorkspaceRoots.length > 0 && target.cwd !== undefined
            && this.config.allowedWorkspaceRoots.some(root => pathWithin(root, target.cwd)))
            return;
        throw new OneErrorClass('one/session-forbidden', `session "${target.sessionId}" is not registered or allowed; use "/one sessions add" or add it to allowedSessionIds`, { sessionId: target.sessionId });
    }
    viewFromSummary(summary, record) {
        return {
            sessionId: summary.sessionId,
            ...(record?.title === undefined ? {} : { title: record.title }),
            ...(summary.cwd ?? record?.cwd) === undefined ? {} : { cwd: summary.cwd ?? record?.cwd },
            running: summary.running,
            blank: summary.blank,
            subagent: this.isSubagent(summary),
            registered: record !== undefined,
            trusted: record?.trusted === true,
            ...(record?.model === undefined ? {} : { model: record.model }),
            ...(record?.status === undefined ? {} : { status: record.status }),
            ...(record?.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
        };
    }
    viewFromRecord(record) {
        return {
            sessionId: record.sessionId,
            ...(record.title === undefined ? {} : { title: record.title }),
            ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
            running: false,
            blank: true,
            subagent: false,
            registered: true,
            trusted: record.trusted,
            ...(record.model === undefined ? {} : { model: record.model }),
            status: record.status,
            ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
        };
    }
    resultOf(record) {
        return {
            requestId: record.requestId,
            targetSessionId: record.targetSessionId,
            status: record.status,
            accepted: record.status === 'sent' || record.status === 'sending',
            observed: record.status === 'observed',
            attempts: record.attempts,
            ...(record.error === undefined ? {} : { error: record.error }),
        };
    }
    async audit(input) {
        await this.store.appendAudit({
            id: nextId('audit'),
            at: this.now(),
            action: input.action,
            ...(input.actorSessionId === undefined ? {} : { actorSessionId: input.actorSessionId }),
            ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
            outcome: input.outcome,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
        }, this.config.auditLimit);
    }
}
function modelAvailable(catalog, selection) {
    const group = catalog.groups.find(candidate => candidate.id === selection.provider);
    return group !== undefined && group.models.some(model => model.id === selection.model);
}
function fallbackSelection(catalog, requestedProvider) {
    const group = catalog.groups.find(candidate => candidate.id === requestedProvider);
    const model = group?.models[0];
    if (group !== undefined && model !== undefined)
        return { provider: group.id, model: model.id };
    return catalog.default;
}
/** Resolve the agent's session id from the minimal Agent surface. */
export function agentSessionId(agent) {
    if (agent === undefined)
        return undefined;
    const id = asString(agent.id);
    return id === undefined || id === '' ? undefined : id;
}
