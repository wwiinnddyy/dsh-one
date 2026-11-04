/** Intake runtime: trigger dedupe, gate, assessment, eval, mandate, decision, acceptance. */
import { classifyError, hashOf, nextId, now as systemNow, preview, sourceTaskId, } from '../util.js';
export class IntakeRuntime {
    ctx;
    config;
    store;
    core;
    now;
    reply;
    poller;
    listeners = new Set();
    chain = Promise.resolve();
    lastPollAt;
    lastError;
    currentPolicy;
    constructor(ctx, config, store, core, options = {}) {
        this.ctx = ctx;
        this.config = config;
        this.store = store;
        this.core = core;
        this.now = options.now ?? systemNow;
        this.reply = options.reply;
        this.poller = options.poll;
    }
    get taskService() {
        return this.ctx.get('oneTasks');
    }
    /** Install or refresh the policy, recover mandates, and finish queued evals. */
    async start() {
        await this.enqueue(async () => {
            this.currentPolicy = await this.ensurePolicy();
            await this.reconcile();
            await this.processQueuedEvals();
        });
        this.emit();
    }
    async handle(event) {
        const result = await this.enqueue(async () => await this.handleInternal(event));
        this.emit();
        return result;
    }
    snapshot() {
        const items = this.store.listDecisions(20).map(decision => ({
            id: decision.decisionId,
            title: `${decision.outcome} · ${decision.threadId}`,
            status: decision.outcome,
            detail: decision.reasons.join('; '),
            updatedAt: decision.createdAt,
        }));
        return {
            recent: items,
            acceptMode: this.config.acceptMode,
            ...(this.currentPolicy === undefined ? {} : { policyVersion: this.currentPolicy.version }),
            pendingEvals: this.store.listEvals().filter(item => item.status !== 'settled').length,
            ...(this.lastPollAt === undefined ? {} : { lastPollAt: this.lastPollAt }),
            ...(this.lastError === undefined ? {} : { error: this.lastError }),
        };
    }
    decisions(limit = 20) {
        return this.store.listDecisions(limit);
    }
    policy() {
        return this.currentPolicy ?? this.store.activePolicy();
    }
    health() {
        const policy = this.policy();
        return {
            acceptMode: this.config.acceptMode,
            ...(policy === undefined ? {} : { policyVersion: policy.version }),
            ...(this.lastPollAt === undefined ? {} : { lastPollAt: this.lastPollAt }),
            ...(this.lastError === undefined ? {} : { error: this.lastError }),
        };
    }
    /** Run one poll pass through the configured source adapter. */
    async pollNow() {
        if (this.poller === undefined)
            return 0;
        try {
            const events = await this.poller(AbortSignal.timeout(Math.max(this.config.github.pollIntervalMs, 5_000)));
            this.lastPollAt = this.now();
            this.lastError = undefined;
            for (const event of events)
                await this.handle(event);
            return events.length;
        }
        catch (error) {
            this.lastError = classifyError(error).message;
            this.emit();
            return 0;
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit() {
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch {
                // Panel observers cannot veto intake.
            }
        }
    }
    enqueue(operation) {
        const run = this.chain.then(operation, operation);
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    async handleInternal(event) {
        const triggerId = `${event.sourceId}:${event.id}`;
        if (this.store.getTrigger(triggerId) !== undefined) {
            return { status: 'duplicate', reason: 'trigger already recorded' };
        }
        const receivedAt = this.now();
        const thread = this.upsertThread(event, receivedAt);
        const gate = this.gate(event);
        const baseTrigger = {
            triggerId,
            sourceId: event.sourceId,
            repository: event.repository,
            eventKind: event.kind,
            externalEventId: event.id,
            actor: event.actor,
            threadId: thread.threadId,
            receivedAt,
            gate: gate.verdict,
            ...(gate.reason === undefined ? {} : { gateReason: gate.reason }),
            payload: JSON.stringify(event),
        };
        if (gate.verdict === 'ignore') {
            await this.store.putTrigger({ ...baseTrigger, decision: 'observe-only' });
            return { trigger: baseTrigger, status: 'ignored', reason: gate.reason };
        }
        if (gate.verdict === 'reject') {
            await this.store.putTrigger(baseTrigger);
            await this.store.putThread({ ...thread, declined: thread.declined + 1, lastTriggerId: triggerId });
            await this.core.audit({
                action: 'trigger_rejected',
                outcome: 'error',
                detail: `${triggerId}: ${gate.reason ?? 'gate rejected'}`,
            });
            return { trigger: baseTrigger, status: 'declined', reason: gate.reason };
        }
        const active = thread.evalId === undefined ? undefined : this.store.getEval(thread.evalId);
        if (active !== undefined && active.status !== 'settled') {
            await this.store.putTrigger({ ...baseTrigger, gateReason: 'thread already has an active eval' });
            return { trigger: baseTrigger, status: 'deferred', reason: 'thread already has an active eval' };
        }
        const policy = this.currentPolicy ?? this.store.activePolicy();
        if (policy === undefined) {
            await this.store.putTrigger({ ...baseTrigger, gateReason: 'policy missing' });
            return { trigger: baseTrigger, status: 'deferred', reason: 'policy missing' };
        }
        const evalId = `${thread.threadId}:eval:${hashOf({ triggerId, policy: policy.version })}`;
        const evalRecord = {
            evalId,
            triggerId,
            threadId: thread.threadId,
            status: 'running',
            policyVersion: policy.version,
            gate: 'pass',
            payload: JSON.stringify(event),
            createdAt: receivedAt,
            updatedAt: receivedAt,
        };
        await this.store.putEval(evalRecord);
        await this.store.putTrigger({ ...baseTrigger, evalId });
        await this.store.putThread({ ...thread, evalId, lastTriggerId: triggerId, updatedAt: receivedAt });
        return await this.settleEval(evalRecord, event, policy);
    }
    upsertThread(event, at) {
        const threadId = `${event.sourceId}:${event.repository}:${event.externalId}`;
        const existing = this.store.getThread(threadId);
        if (existing !== undefined) {
            return {
                ...existing,
                title: event.title,
                ...(event.url === undefined ? {} : { url: event.url }),
                updatedAt: at,
            };
        }
        const thread = {
            threadId,
            sourceId: event.sourceId,
            repository: event.repository,
            externalId: event.externalId,
            number: event.number,
            title: event.title,
            ...(event.url === undefined ? {} : { url: event.url }),
            isPullRequest: event.isPullRequest,
            createdAt: at,
            updatedAt: at,
            accepted: 0,
            declined: 0,
        };
        void this.store.putThread(thread);
        return thread;
    }
    gate(event) {
        if (!this.config.github.enabled)
            return { verdict: 'ignore', reason: 'github source is disabled' };
        if (this.config.acceptMode === 'off')
            return { verdict: 'ignore', reason: 'accept mode is off' };
        if (this.config.github.repositories.length === 0)
            return { verdict: 'reject', reason: 'no repositories are allowed' };
        if (!this.config.github.repositories.includes(event.repository)) {
            return { verdict: 'reject', reason: `repository "${event.repository}" is not allowed` };
        }
        if (this.config.github.eventTypes.length > 0 && !this.config.github.eventTypes.includes(event.kind)) {
            return { verdict: 'reject', reason: `event type "${event.kind}" is not allowed` };
        }
        if (this.config.github.botLogins.includes(event.actor)) {
            return { verdict: 'reject', reason: 'bot actors are ignored' };
        }
        if (this.config.github.allowedActors.length > 0
            && !this.config.github.allowedActors.includes('*')
            && !this.config.github.allowedActors.includes(event.actor)) {
            return { verdict: 'reject', reason: `actor "${event.actor}" is not allowed` };
        }
        if (this.config.github.allowedActors.length === 0 && !this.config.github.allowedActors.includes('*')) {
            return { verdict: 'reject', reason: 'no actors are allowed' };
        }
        if (this.config.github.requireMention) {
            const login = this.config.github.mentionLogin;
            if (login === '')
                return { verdict: 'reject', reason: 'mentionLogin is empty while requireMention is on' };
            const pattern = new RegExp(`@${escapeRegExp(login)}\\b`, 'iu');
            if (!pattern.test(`${event.title}\n${event.body}`)) {
                return { verdict: 'reject', reason: `event does not mention @${login}` };
            }
        }
        return { verdict: 'pass' };
    }
    async settleEval(evalRecord, event, policy) {
        const assessment = await this.assess(event, policy);
        const checks = assessment.checks;
        const requiredPass = policy.rules.filter(rule => rule.required).every(rule => checks.some(check => check.ruleId === rule.id && check.pass));
        const at = this.now();
        if (this.config.acceptMode === 'observe') {
            const reasons = checks.map(check => `${check.ruleId}: ${check.pass ? 'pass' : 'fail'}${check.note === undefined ? '' : ` (${check.note})`}`);
            const settled = {
                ...evalRecord,
                status: 'settled',
                assessment: checks,
                outcome: 'would-accept',
                reason: 'observe mode: recorded would-accept',
                updatedAt: at,
                settledAt: at,
            };
            await this.store.putEval(settled);
            const decision = await this.recordDecision(settled, event, 'would-accept', reasons, policy);
            await this.store.putTrigger({ ...this.requireTrigger(evalRecord.triggerId), decision: 'would-accept' });
            await this.store.putThread({ ...this.requireThread(evalRecord.threadId), evalId: undefined, updatedAt: at });
            return { eval: settled, decision, status: 'observed', reason: 'would-accept' };
        }
        if (!requiredPass || assessment.source === 'unavailable') {
            const reason = assessment.source === 'unavailable'
                ? `assessment unavailable${assessment.error === undefined ? '' : `: ${assessment.error}`}`
                : 'one or more required policy rules failed';
            const reasons = checks.map(check => `${check.ruleId}: ${check.pass ? 'pass' : 'fail'}`);
            const settled = {
                ...evalRecord,
                status: 'settled',
                assessment: checks,
                outcome: 'decline',
                reason,
                updatedAt: at,
                settledAt: at,
            };
            await this.store.putEval(settled);
            const decision = await this.recordDecision(settled, event, 'decline', [...reasons, reason], policy);
            await this.store.putTrigger({ ...this.requireTrigger(evalRecord.triggerId), decision: 'decline' });
            await this.store.putThread({
                ...this.requireThread(evalRecord.threadId),
                evalId: undefined,
                declined: this.requireThread(evalRecord.threadId).declined + 1,
                updatedAt: at,
            });
            await this.core.audit({ action: 'trigger_declined', outcome: 'error', detail: `${evalRecord.triggerId}: ${reason}` });
            return { eval: settled, decision, status: 'declined', reason };
        }
        // accept
        const taskService = this.taskService;
        if (taskService === undefined) {
            const reasons = ['delegation row is not mounted (dsh-one-delegate disabled)'];
            const settled = {
                ...evalRecord,
                status: 'settled',
                assessment: checks,
                outcome: 'decline',
                reason: reasons[0],
                updatedAt: at,
                settledAt: at,
            };
            await this.store.putEval(settled);
            const decision = await this.recordDecision(settled, event, 'no-delegate', reasons, policy);
            await this.store.putTrigger({ ...this.requireTrigger(evalRecord.triggerId), decision: 'no-delegate' });
            await this.store.putThread({ ...this.requireThread(evalRecord.threadId), evalId: undefined, updatedAt: at });
            return { eval: settled, decision, status: 'deferred', reason: reasons[0] };
        }
        if (this.config.taskWorkspaceRoot === '') {
            const reason = 'taskWorkspaceRoot is empty; configure a workspace before accepting source work';
            const settled = {
                ...evalRecord,
                status: 'settled',
                assessment: checks,
                outcome: 'decline',
                reason,
                updatedAt: at,
                settledAt: at,
            };
            await this.store.putEval(settled);
            const decision = await this.recordDecision(settled, event, 'decline', [reason], policy);
            await this.store.putTrigger({ ...this.requireTrigger(evalRecord.triggerId), decision: 'decline' });
            await this.store.putThread({ ...this.requireThread(evalRecord.threadId), evalId: undefined, declined: this.requireThread(evalRecord.threadId).declined + 1, updatedAt: at });
            return { eval: settled, decision, status: 'declined', reason };
        }
        const mandateId = `mandate-${event.sourceId}-${hashOf({ threadId: evalRecord.threadId, taskId: sourceTaskId(event.sourceId, event.externalId) })}`;
        const mandate = {
            mandateId,
            taskId: sourceTaskId(event.sourceId, event.externalId),
            threadId: evalRecord.threadId,
            policyVersion: policy.version,
            strength: policy.strength,
            scope: policy.scope,
            basis: checks,
            createdAt: at,
        };
        await this.store.putMandateOnce(mandate);
        const taskId = sourceTaskId(event.sourceId, event.externalId);
        const existingTask = taskService.getTask(taskId);
        let task = existingTask;
        if (task === undefined) {
            try {
                const created = await taskService.createTask({
                    title: `[${event.repository}#${event.number}] ${event.title}`,
                    goal: this.goalText(event),
                    cwd: this.config.taskWorkspaceRoot,
                    origin: 'source',
                    createdBy: `source:${event.sourceId}`,
                    mandateId,
                    source: {
                        sourceId: event.sourceId,
                        threadId: evalRecord.threadId,
                        externalId: event.externalId,
                        ...(event.url === undefined ? {} : { url: event.url }),
                    },
                }, {
                    source: 'source',
                    taskId,
                    autoAssign: true,
                });
                task = created.task;
            }
            catch (error) {
                const reason = `task creation failed: ${classifyError(error).message}`;
                const settled = {
                    ...evalRecord,
                    status: 'settled',
                    assessment: checks,
                    outcome: 'decline',
                    reason,
                    updatedAt: this.now(),
                    settledAt: this.now(),
                };
                await this.store.putEval(settled);
                const decision = await this.recordDecision(settled, event, 'decline', [reason], policy);
                await this.store.putTrigger({ ...this.requireTrigger(evalRecord.triggerId), decision: 'decline' });
                await this.store.putThread({ ...this.requireThread(evalRecord.threadId), evalId: undefined, declined: this.requireThread(evalRecord.threadId).declined + 1, updatedAt: this.now() });
                return { eval: settled, decision, status: 'declined', reason };
            }
        }
        const thread = this.requireThread(evalRecord.threadId);
        const subscriptionId = `sub-${taskId}`;
        await this.store.putSubscription({
            subscriptionId,
            taskId,
            threadId: thread.threadId,
            sourceId: event.sourceId,
            mode: this.reply === undefined ? 'none' : 'reply',
            createdAt: at,
        });
        const settled = {
            ...evalRecord,
            status: 'settled',
            assessment: checks,
            outcome: 'accept',
            reason: 'all required rules passed',
            updatedAt: at,
            settledAt: at,
        };
        await this.store.putEval(settled);
        const decision = await this.recordDecision(settled, event, 'accept', checks.map(check => `${check.ruleId}: pass`), policy, taskId, mandateId);
        await this.store.putTrigger({ ...this.requireTrigger(evalRecord.triggerId), decision: 'accept', taskId });
        await this.store.putThread({
            ...thread,
            evalId: undefined,
            taskId,
            accepted: thread.taskId === undefined ? thread.accepted + 1 : thread.accepted,
            updatedAt: at,
        });
        await this.confirm(thread, taskId);
        await this.core.audit({ action: 'trigger_accepted', taskId, outcome: 'ok', detail: evalRecord.triggerId });
        return { eval: settled, decision, taskId, status: 'accepted' };
    }
    async recordDecision(evalRecord, event, outcome, reasons, policy, taskId, mandateId) {
        const decisionId = `decision-${hashOf({ triggerId: evalRecord.triggerId, outcome })}`;
        const existing = this.store.getDecision(decisionId);
        if (existing !== undefined)
            return existing;
        const decision = {
            decisionId,
            evalId: evalRecord.evalId,
            threadId: evalRecord.threadId,
            triggerId: evalRecord.triggerId,
            outcome,
            reasons: reasons.map(reason => preview(reason, 240)),
            policyVersion: policy.version,
            ...(taskId === undefined ? {} : { taskId }),
            ...(mandateId === undefined ? {} : { mandateId }),
            createdAt: this.now(),
        };
        await this.store.putDecision(decision);
        void event;
        return decision;
    }
    async confirm(thread, taskId) {
        if (this.reply === undefined)
            return;
        const deliveryId = `out:${taskId}:accept`;
        if (this.store.getDelivery(deliveryId)?.status === 'sent')
            return;
        try {
            await this.reply(thread, `Accepted as ${taskId}. Progress and the final result are reported through the task runtime.`, deliveryId);
            await this.store.putDelivery({
                deliveryId,
                sourceId: thread.sourceId,
                direction: 'out',
                externalId: thread.externalId,
                status: 'sent',
                at: this.now(),
                detail: preview(taskId),
            });
        }
        catch (error) {
            await this.store.putDelivery({
                deliveryId,
                sourceId: thread.sourceId,
                direction: 'out',
                externalId: thread.externalId,
                status: 'failed',
                at: this.now(),
                detail: classifyError(error).message,
            });
        }
    }
    async assess(event, policy) {
        if (!this.config.assessment.enabled)
            return this.rulesAssessment(event, policy, 'rules');
        const llm = this.ctx.get('llm');
        if (llm === undefined || typeof llm.stream !== 'function') {
            return this.rulesAssessment(event, policy, 'unavailable', 'llm service is unavailable');
        }
        const provider = this.config.assessment.provider;
        const model = this.config.assessment.model;
        if (provider === '' || model === '')
            return this.rulesAssessment(event, policy, 'unavailable', 'assessment provider/model is empty');
        const prompt = [
            `Repository: ${event.repository}`,
            `Actor: ${event.actor}`,
            `Event: ${event.kind} ${event.action}`,
            `Title: ${event.title}`,
            'Body:',
            event.body.slice(0, 4000),
            '',
            'Rules:',
            ...policy.rules.map(rule => `- ${rule.id}: ${rule.text}`),
            '',
            'Answer with one JSON array only. Each item: {"ruleId":string,"pass":boolean,"note":string}.',
        ].join('\n');
        try {
            let text = '';
            for await (const chunk of llm.stream({
                provider,
                model,
                system: 'You are a strict intake assessor. Judge only whether the event satisfies each rule. Return JSON only.',
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                maxTokens: this.config.assessment.maxTokens,
                signal: AbortSignal.timeout(this.config.assessment.timeoutMs),
            })) {
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    text += chunk.text;
            }
            const parsed = parseAssessment(text);
            if (parsed === undefined)
                return this.rulesAssessment(event, policy, 'unavailable', 'model answer was not valid JSON');
            const checks = policy.rules.map(rule => parsed.find(item => item.ruleId === rule.id)
                ?? { ruleId: rule.id, pass: false, note: 'missing from model answer' });
            return { checks, source: 'model' };
        }
        catch (error) {
            return this.rulesAssessment(event, policy, 'unavailable', classifyError(error).message);
        }
    }
    rulesAssessment(event, policy, source, error) {
        const checks = policy.rules.map(rule => {
            if (rule.denyPattern !== undefined) {
                try {
                    const pattern = new RegExp(rule.denyPattern, 'iu');
                    if (pattern.test(`${event.title}\n${event.body}`)) {
                        return { ruleId: rule.id, pass: false, note: `matched denyPattern ${rule.denyPattern}` };
                    }
                }
                catch {
                    return { ruleId: rule.id, pass: false, note: 'denyPattern is not a valid regular expression' };
                }
            }
            return { ruleId: rule.id, pass: true, note: 'deterministic rule check passed' };
        });
        return { checks, source, ...(error === undefined ? {} : { error }) };
    }
    async ensurePolicy() {
        const desired = {
            strength: this.config.policyStrength,
            scope: this.config.policyScope,
            rules: this.config.policyRules,
        };
        const hash = hashOf(desired);
        const active = this.store.activePolicy();
        if (active !== undefined && active.hash === hash)
            return active;
        const version = `pv-${hash}`;
        const policy = {
            policyId: nextId('policy'),
            version,
            strength: desired.strength,
            scope: desired.scope,
            rules: desired.rules,
            hash,
            createdAt: this.now(),
        };
        if (active !== undefined) {
            await this.store.putPolicy({ ...active, supersededBy: version });
            await this.onPolicyChanged(active, policy);
        }
        await this.store.putPolicy(policy);
        this.currentPolicy = policy;
        return policy;
    }
    async onPolicyChanged(previous, next) {
        for (const evalRecord of this.store.listEvals()) {
            if (evalRecord.status === 'settled')
                continue;
            await this.store.putEval({
                ...evalRecord,
                status: 'queued',
                policyVersion: next.version,
                updatedAt: this.now(),
            });
        }
        const tasks = this.taskService;
        if (tasks !== undefined) {
            for (const task of tasks.listTasks()) {
                if (task.mandateId === undefined || task.status === 'done' || task.status === 'cancelled')
                    continue;
                try {
                    await tasks.addInput(task.taskId, `[policy-changed] The intake policy changed from ${previous.version} to ${next.version}. Re-check the work against the current rules before continuing.`, 'policy-changed');
                }
                catch (error) {
                    await this.core.audit({ action: 'policy_input_failed', taskId: task.taskId, outcome: 'error', detail: classifyError(error).message });
                }
            }
        }
        await this.core.audit({ action: 'policy_changed', outcome: 'ok', detail: `${previous.version} -> ${next.version}` });
    }
    async reconcile() {
        const tasks = this.taskService;
        if (tasks === undefined)
            return;
        const policy = this.currentPolicy ?? this.store.activePolicy();
        for (const task of tasks.listTasks()) {
            if (task.mandateId === undefined || task.status === 'done' || task.status === 'cancelled')
                continue;
            const mandate = this.store.getMandate(task.mandateId);
            if (mandate === undefined) {
                await tasks.blockTask(task.taskId, 'mandate-invalid', 'mandate');
                continue;
            }
            if (policy !== undefined && !scopeCovers(policy.scope, mandate.scope)) {
                await tasks.blockTask(task.taskId, `mandate-invalid: policy scope "${policy.scope}" no longer covers "${mandate.scope}"`, 'mandate');
            }
        }
        // Fill a missing decision for an accepted task (a crash between task creation and decision).
        for (const mandate of this.store.listMandates()) {
            const task = tasks.getTask(mandate.taskId);
            if (task === undefined)
                continue;
            const decision = this.store.listDecisions().find(item => item.taskId === mandate.taskId);
            if (decision !== undefined)
                continue;
            const thread = this.store.getThread(mandate.threadId);
            if (thread === undefined)
                continue;
            await this.store.putDecision({
                decisionId: `decision-reconciled-${mandate.taskId}`,
                evalId: `reconciled-${mandate.taskId}`,
                threadId: mandate.threadId,
                triggerId: `reconciled-${mandate.taskId}`,
                outcome: 'accept',
                reasons: ['reconciled after restart: task and mandate exist'],
                policyVersion: mandate.policyVersion,
                taskId: mandate.taskId,
                mandateId: mandate.mandateId,
                createdAt: this.now(),
            });
            await this.store.putThread({ ...thread, taskId: mandate.taskId, evalId: undefined, updatedAt: this.now() });
            await this.core.audit({ action: 'accept_reconciled', taskId: mandate.taskId, outcome: 'ok', detail: 'decision filled' });
        }
    }
    async processQueuedEvals() {
        for (const evalRecord of this.store.listEvals()) {
            if (evalRecord.status !== 'queued')
                continue;
            const policy = this.currentPolicy ?? this.store.activePolicy();
            if (policy === undefined || evalRecord.payload === undefined)
                continue;
            let event;
            try {
                event = JSON.parse(evalRecord.payload);
            }
            catch {
                await this.store.putEval({ ...evalRecord, status: 'settled', outcome: 'decline', reason: 'stored eval payload is invalid', updatedAt: this.now(), settledAt: this.now() });
                continue;
            }
            await this.settleEval({ ...evalRecord, status: 'running', policyVersion: policy.version }, event, policy);
        }
    }
    requireTrigger(triggerId) {
        const trigger = this.store.getTrigger(triggerId);
        if (trigger === undefined)
            throw new Error(`missing trigger ${triggerId}`);
        return trigger;
    }
    requireThread(threadId) {
        const thread = this.store.getThread(threadId);
        if (thread === undefined)
            throw new Error(`missing thread ${threadId}`);
        return thread;
    }
    goalText(event) {
        return [
            `Repository: ${event.repository}`,
            `Thread: ${event.url ?? `${event.repository}#${event.number}`} (${event.isPullRequest ? 'pull request' : 'issue'})`,
            `Requested by: @${event.actor}`,
            `Title: ${event.title}`,
            '',
            'Request:',
            event.body.slice(0, 6000),
            '',
            'Acceptance evidence must be concrete: changed files, commands run, test output, or a commit/PR link.',
            'Before changing anything, check the current repository state and whether earlier work already satisfies the request.',
        ].join('\n');
    }
}
function scopeCovers(policyScope, mandateScope) {
    if (policyScope === '*')
        return true;
    if (policyScope === mandateScope)
        return true;
    return policyScope.endsWith('*') && mandateScope.startsWith(policyScope.slice(0, -1));
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function parseAssessment(text) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start)
        return undefined;
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(value))
            return undefined;
        const checks = [];
        for (const item of value) {
            if (typeof item !== 'object' || item === null)
                continue;
            const record = item;
            const ruleId = typeof record['ruleId'] === 'string' ? record['ruleId'] : undefined;
            const pass = typeof record['pass'] === 'boolean' ? record['pass'] : undefined;
            if (ruleId === undefined || pass === undefined)
                continue;
            checks.push({
                ruleId,
                pass,
                ...(typeof record['note'] === 'string' ? { note: record['note'] } : {}),
            });
        }
        return checks.length === 0 ? undefined : checks;
    }
    catch {
        return undefined;
    }
}
