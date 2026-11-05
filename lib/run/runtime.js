/**
 * Durable, host-side coordinator for one goal.
 *
 * The assistant session is the Router: it plans a goal into steps and calls
 * `one_run_start`, which returns immediately (async ReAct). Workers run the
 * steps through the existing `TaskRuntime`, and this runtime watches their
 * transitions, records user-facing activity, and wakes the assistant only when
 * a person must decide or the goal settled.
 *
 * It deliberately owns no task semantics: slots, leases, budgets, reports,
 * retries and recovery stay in `TaskRuntime`.
 */
import { OneError } from '../types.js';
import { defaultCoreConfig } from '../core/defaults.js';
import { senderLabelFor } from '../core/sender.js';
import { DEFAULT_QUIET_POLICY, suppressionOf } from '../task/notify.js';
import { WebChannel } from '../channel/web.js';
import { canonicalWorkspace, classifyError, hashOf, nextId, now as systemNow, preview } from '../util.js';
import { attentionOf, isTerminalRun, runStatusOf, transitionsOf } from './filter.js';
function fallbackSettings() {
    return {
        displayName: () => defaultCoreConfig().displayName,
        assistantSessionId: () => undefined,
        notifyMuted: () => false,
        quietHours: () => ({}),
        runsPaused: () => false,
    };
}
const TASK_TERMINAL = ['done', 'failed', 'cancelled'];
export class RunRuntime {
    mode;
    ctx;
    config;
    store;
    core;
    tasks;
    settings;
    now;
    channel;
    listeners = new Set();
    dispatchInflight = new Set();
    timer;
    coalesceTimer;
    ticking = false;
    pendingTick = false;
    disposed = false;
    constructor(ctx, config, store, core, tasks, settings, hooks = {}) {
        this.ctx = ctx;
        this.config = config;
        this.store = store;
        this.core = core;
        this.tasks = tasks;
        this.settings = settings ?? fallbackSettings();
        this.now = hooks.now ?? systemNow;
        this.channel = hooks.channel ?? new WebChannel(core);
        this.mode = config.assistantRunMode;
    }
    /** Reattach interrupted runs, then start the watchdog. */
    async open() {
        const at = this.now();
        for (const stored of this.store.listRuns()) {
            if (isTerminalRun(stored.status))
                continue;
            const rebound = this.rebind(stored, this.settings.assistantSessionId());
            if (rebound !== stored)
                await this.store.putRun(rebound);
            await this.appendActivity(stored.runId, 'recovered', '宿主重启，已重新挂接', {
                detail: '步骤状态以任务账本为准；未完成的提醒不会重发',
                dedupeKey: `recovered:${at}`,
            });
        }
        this.timer = setInterval(() => { void this.tick(); }, this.config.watchdogTickMs);
        this.timer.unref?.();
        await this.tick();
    }
    dispose() {
        this.disposed = true;
        if (this.timer !== undefined)
            clearInterval(this.timer);
        if (this.coalesceTimer !== undefined)
            clearTimeout(this.coalesceTimer);
        this.timer = undefined;
        this.coalesceTimer = undefined;
        this.listeners.clear();
    }
    /** Create one run and return as soon as its steps are dispatched. */
    async start(input) {
        const goal = input.goal.trim();
        if (goal === '')
            throw new OneError('one/invalid-argument', 'goal is required');
        const cwd = this.resolveCwd(input);
        const mode = this.modeOf(input);
        const assistantSessionId = this.ownerOf(input);
        const runId = input.idempotencyKey === undefined
            ? nextId('run')
            : `run-${hashOf({ owner: assistantSessionId ?? input.origin, key: input.idempotencyKey })}`;
        const existing = this.store.getRun(runId);
        if (existing !== undefined) {
            return { run: this.view(existing), observed: existing.mode === 'observed' };
        }
        const maxTasks = clamp(input.maxTasks ?? this.config.runMaxTasks, 1, 20);
        const deadlineMs = clamp(input.deadlineMs ?? this.config.runDeadlineMs, 60_000, 86_400_000);
        const at = this.now();
        const steps = this.plan(runId, input, goal, maxTasks);
        let run = {
            runId,
            goal,
            title: (input.title ?? '').trim() || preview(goal, 80),
            cwd,
            cwdLabel: cwd,
            origin: input.origin,
            mode,
            ...(assistantSessionId === undefined ? {} : { assistantSessionId }),
            status: 'active',
            paused: false,
            steps,
            limits: { maxTasks, deadlineMs },
            deadlineAt: at + deadlineMs,
            activitySeq: 0,
            seen: {},
            createdAt: at,
            updatedAt: at,
        };
        await this.store.putRun(run);
        await this.appendActivity(runId, 'run-started', mode === 'execute' ? '目标已开始推进' : '目标已记录（observe 模式）', {
            detail: `${steps.length} 个步骤 · ${cwd}`,
        });
        try {
            for (const step of steps) {
                const created = await this.tasks.createTask({
                    title: step.title,
                    goal: step.goal,
                    cwd: step.cwd ?? cwd,
                    runId,
                    origin: this.taskOrigin(input.origin),
                    ...(input.callerSessionId === undefined ? {} : { createdBy: input.callerSessionId }),
                }, {
                    source: mode === 'execute'
                        ? input.origin === 'human' ? 'command' : input.origin === 'assistant' ? 'assistant' : 'tool'
                        : 'tool',
                    mode,
                    ...(input.callerSessionId === undefined ? {} : { callerSessionId: input.callerSessionId }),
                    ...(input.callerCwd === undefined ? {} : { callerCwd: input.callerCwd }),
                    taskId: step.taskId,
                    // The assistant is the user's proxy: its steps announce who ordered
                    // them. A run planned by an agent or by a human does not.
                    ...(input.origin === 'assistant'
                        ? { assistantLabel: senderLabelFor(this.settings.displayName()) }
                        : {}),
                });
                if (mode === 'execute' && !created.observed) {
                    await this.appendActivity(runId, 'step-dispatched', `已派发：${step.title}`, {
                        taskId: step.taskId,
                        dedupeKey: `${runId}:${step.taskId}:dispatched`,
                    });
                    this.dispatch(step.taskId);
                }
            }
        }
        catch (error) {
            const failedAt = this.now();
            run = await this.store.updateRun(runId, current => ({
                ...current,
                status: 'failed',
                verdict: classifyError(error).message,
                terminalAt: failedAt,
                updatedAt: failedAt,
            }));
            await this.appendActivity(runId, 'run-failed', '目标未能开始', { detail: classifyError(error).message, level: 'error' });
            this.emit();
            throw error;
        }
        if (mode === 'observed') {
            const seen = {};
            for (const step of steps)
                seen[step.taskId] = 'queued';
            run = await this.store.updateRun(runId, current => ({
                ...current,
                status: 'done',
                verdict: 'observed; no tasks were executed',
                seen,
                terminalAt: at,
                updatedAt: at,
            }));
            await this.appendActivity(runId, 'run-done', '已记录，未执行（observe 模式）', { dedupeKey: `${runId}:observed` });
            this.emit();
            return { run: this.view(run), observed: true };
        }
        this.scheduleTick();
        this.emit();
        return { run: this.view(this.store.getRun(runId) ?? run), observed: false };
    }
    get(runId) {
        const run = this.store.getRun(runId);
        return run === undefined ? undefined : this.view(run);
    }
    list() {
        return this.store.listRuns().map(run => this.view(run)).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    summary() {
        const groups = new Map();
        for (const run of this.list()) {
            const key = canonicalWorkspace(run.cwd);
            const group = groups.get(key) ?? { cwd: key, label: run.cwdLabel, runs: [] };
            group.runs.push(run);
            groups.set(key, group);
        }
        const totals = { active: 0, needsYou: 0, done: 0, failed: 0, paused: 0 };
        const rendered = [...groups.values()]
            .sort((a, b) => (b.runs[0]?.updatedAt ?? 0) - (a.runs[0]?.updatedAt ?? 0))
            .map(group => {
            const counts = countRuns(group.runs);
            totals.active += counts.active;
            totals.needsYou += counts.needsYou;
            totals.done += counts.done;
            totals.failed += counts.failed;
            totals.paused += counts.paused;
            return { ...group, runs: group.runs, counts };
        });
        return {
            generatedAt: this.now(),
            assistant: { sessionId: this.settings.assistantSessionId() ?? null, displayName: this.settings.displayName() },
            pausedAll: this.settings.runsPaused(),
            groups: rendered,
            totals,
        };
    }
    activities(runId, limit = 100) {
        return this.store.listRunActivities(runId, Math.max(1, Math.min(200, limit)));
    }
    async control(input) {
        const run = this.store.getRun(input.runId);
        if (run === undefined)
            throw new OneError('one/run-not-found', `run "${input.runId}" was not found`, { runId: input.runId });
        if (isTerminalRun(run.status)) {
            throw new OneError('one/run-terminal', `run "${run.runId}" is ${run.status}`, { runId: run.runId });
        }
        const at = this.now();
        if (input.action === 'pause') {
            if (run.paused)
                return this.view(run);
            const updated = await this.store.updateRun(run.runId, current => ({
                ...current,
                paused: true,
                ...(input.reason === undefined ? {} : { pauseReason: input.reason }),
                updatedAt: at,
            }));
            await this.appendActivity(run.runId, 'run-paused', '已暂停', { detail: input.reason });
            this.emit();
            return this.view(updated);
        }
        if (input.action === 'resume') {
            if (!run.paused)
                return this.view(run);
            const updated = await this.store.updateRun(run.runId, current => ({
                ...current,
                paused: false,
                pauseReason: undefined,
                updatedAt: at,
            }));
            await this.appendActivity(run.runId, 'run-resumed', '已继续', { detail: input.reason });
            this.scheduleTick();
            this.emit();
            return this.view(updated);
        }
        for (const step of run.steps) {
            const task = this.tasks.getTask(step.taskId);
            if (task === undefined || TASK_TERMINAL.includes(task.status))
                continue;
            try {
                await this.tasks.control({
                    taskId: step.taskId,
                    action: 'cancel',
                    reason: input.reason ?? 'run cancelled',
                    ...(run.assistantSessionId === undefined ? {} : { callerSessionId: run.assistantSessionId }),
                });
            }
            catch {
                // A task that settled between the read and the cancel is already terminal.
            }
        }
        const updated = await this.store.updateRun(run.runId, current => ({
            ...current,
            status: 'cancelled',
            paused: false,
            verdict: input.reason ?? 'cancelled',
            terminalAt: at,
            updatedAt: at,
        }));
        await this.appendActivity(run.runId, 'run-cancelled', '已取消', { detail: input.reason, level: 'attention' });
        this.emit();
        return this.view(updated);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /** Coalesce a burst of task changes into one decision. */
    scheduleTick() {
        if (this.disposed || this.coalesceTimer !== undefined)
            return;
        this.coalesceTimer = setTimeout(() => {
            this.coalesceTimer = undefined;
            void this.tick();
        }, this.config.wakeCoalesceMs);
        this.coalesceTimer.unref?.();
    }
    /** Project every live run, enforce deadlines, and decide whether to speak. */
    async tick() {
        if (this.disposed)
            return;
        if (this.ticking) {
            this.pendingTick = true;
            return;
        }
        this.ticking = true;
        try {
            const assistantId = this.settings.assistantSessionId();
            for (const stored of this.store.listRuns()) {
                if (isTerminalRun(stored.status))
                    continue;
                let run = stored;
                const rebound = this.rebind(run, assistantId);
                if (rebound !== run) {
                    await this.store.putRun(rebound);
                    run = rebound;
                }
                const at = this.now();
                if (at >= run.deadlineAt) {
                    await this.expire(run, at);
                    continue;
                }
                const projection = this.project(run);
                for (const transition of transitionsOf(run, projection.steps)) {
                    await this.appendActivity(run.runId, transition.kind, transitionTitle(transition.step), {
                        taskId: transition.step.taskId,
                        level: transition.level,
                        ...(transition.step.latestReport === undefined ? {} : { detail: transition.step.latestReport }),
                        dedupeKey: transition.dedupeKey,
                    });
                }
                const status = runStatusOf(run, projection.steps);
                const attention = attentionOf(projection.steps, at);
                const seen = {};
                for (const step of projection.steps)
                    seen[step.taskId] = step.status;
                const changed = status !== run.status
                    || JSON.stringify(seen) !== JSON.stringify(run.seen)
                    || JSON.stringify(attention) !== JSON.stringify(run.attention)
                    || (!isTerminalRun(status) && run.terminalAt !== undefined);
                if (changed) {
                    run = await this.store.updateRun(run.runId, current => ({
                        ...current,
                        status,
                        seen,
                        ...(attention === undefined ? { attention: undefined } : { attention }),
                        ...(isTerminalRun(status) ? { terminalAt: current.terminalAt ?? at } : { terminalAt: undefined }),
                        updatedAt: at,
                    }));
                    if (status === 'done') {
                        await this.appendActivity(run.runId, 'run-done', '目标已完成', { dedupeKey: `${run.runId}:done` });
                    }
                    else if (status === 'failed') {
                        await this.appendActivity(run.runId, 'run-failed', '目标未能完成', {
                            detail: attention?.reason,
                            level: 'error',
                            dedupeKey: `${run.runId}:failed`,
                        });
                    }
                }
                if (!run.paused && !this.settings.runsPaused())
                    await this.redispatch(run, projection.steps);
                await this.maybeWake(run);
            }
        }
        finally {
            this.ticking = false;
            if (this.pendingTick) {
                this.pendingTick = false;
                this.scheduleTick();
            }
        }
        this.emit();
    }
    async expire(run, at) {
        for (const step of run.steps) {
            const task = this.tasks.getTask(step.taskId);
            if (task === undefined || TASK_TERMINAL.includes(task.status))
                continue;
            try {
                await this.tasks.control({ taskId: step.taskId, action: 'cancel', reason: 'run deadline exceeded' });
            }
            catch {
                // Already settled.
            }
        }
        const updated = await this.store.updateRun(run.runId, current => ({
            ...current,
            status: 'exhausted',
            verdict: 'deadline exceeded',
            attention: { reason: 'deadline exceeded', since: at },
            terminalAt: at,
            updatedAt: at,
        }));
        await this.appendActivity(run.runId, 'run-exhausted', '已达到运行上限，已停止后续步骤', {
            level: 'attention',
            dedupeKey: `${run.runId}:exhausted`,
        });
        await this.maybeWake(updated);
        this.emit();
    }
    project(run) {
        const tasks = [];
        const steps = run.steps.map(step => {
            const task = this.tasks.getTask(step.taskId);
            tasks.push(task);
            const status = task?.status ?? (run.mode === 'observed' ? 'cancelled' : 'failed');
            return {
                ...step,
                status,
                ...(task?.latestReport === undefined ? {} : { latestReport: preview(task.latestReport.summary, 200) }),
                ...(task?.attention === undefined ? {} : { attention: preview(task.attention.reason, 200) }),
                ...(task?.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
            };
        });
        return { steps, tasks };
    }
    async redispatch(run, steps) {
        if (run.mode !== 'execute' || run.paused)
            return;
        for (const step of steps) {
            if (step.status !== 'queued')
                continue;
            this.dispatch(step.taskId);
        }
    }
    /** Start a queued step without awaiting the dispatch chain. */
    dispatch(taskId) {
        if (this.dispatchInflight.has(taskId))
            return;
        const callerSessionId = this.settings.assistantSessionId();
        this.dispatchInflight.add(taskId);
        void this.tasks.assign(taskId, {
            ...(callerSessionId === undefined ? {} : { callerSessionId }),
        })
            .then(() => { this.scheduleTick(); })
            .catch(error => {
            void this.core.audit({
                action: 'run_dispatch_failed',
                taskId,
                outcome: 'error',
                detail: classifyError(error).message,
            });
        })
            .finally(() => {
            this.dispatchInflight.delete(taskId);
            this.scheduleTick();
        });
    }
    async maybeWake(run) {
        const projection = this.project(run);
        // A paused run still has a *decision* state: it is recorded as suppressed so
        // the activity feed explains the silence, and resume can raise it afresh.
        const decisionStatus = run.paused ? runStatusOf({ ...run, paused: false }, projection.steps) : run.status;
        const reason = decisionStatus === 'done'
            ? 'done'
            : decisionStatus === 'failed' || decisionStatus === 'exhausted'
                ? 'failed'
                : decisionStatus === 'needs-you'
                    ? 'needs-you'
                    : undefined;
        if (reason === undefined)
            return;
        const target = run.assistantSessionId ?? this.settings.assistantSessionId();
        const fingerprint = `${decisionStatus}:${run.paused ? 'paused' : 'live'}:${projection.steps.map(step => `${step.taskId}=${step.status}`).join(',')}`;
        const wakeId = `wake-${hashOf({ runId: run.runId, reason, target: target ?? '', fingerprint })}`;
        if (this.store.getRunWake(wakeId) !== undefined)
            return;
        const at = this.now();
        const quiet = this.settings.quietHours();
        const suppressedBy = run.paused || this.settings.runsPaused()
            ? 'paused'
            : target === undefined
                ? 'no-target'
                : suppressionOf({ reason, key: wakeId, title: `${run.title} ${decisionStatus}`, at }, {
                    muted: this.settings.notifyMuted(),
                    breakthrough: [...DEFAULT_QUIET_POLICY.breakthrough],
                    ...(quiet.from === undefined || quiet.to === undefined ? {} : { quietFrom: quiet.from, quietTo: quiet.to }),
                }, { utcOffsetMinutes: -new Date(at).getTimezoneOffset() });
        const wake = {
            wakeId,
            runId: run.runId,
            reason,
            requestId: wakeId,
            status: suppressedBy === undefined ? 'pending' : 'suppressed',
            ...(suppressedBy === undefined ? {} : { suppressedBy }),
            attempts: 0,
            createdAt: at,
            updatedAt: at,
        };
        await this.store.putRunWake(wake);
        if (suppressedBy !== undefined) {
            await this.appendActivity(run.runId, 'wake-suppressed', `已保持安静：${suppressedBy}`, {
                detail: this.wakeText(run, projection.steps, reason),
                dedupeKey: `${wakeId}:suppressed`,
            });
            return;
        }
        const text = this.wakeText(run, projection.steps, reason);
        void this.deliverWake(wake, run.cwd, target, text);
    }
    async deliverWake(wake, cwd, target, text) {
        const sendingAt = this.now();
        await this.store.putRunWake({ ...wake, status: 'sending', attempts: 1, updatedAt: sendingAt });
        const delivery = await this.channel.deliver({
            runId: wake.runId,
            targetSessionId: target,
            reason: wake.reason,
            text,
            cwd,
            at: wake.createdAt,
            dedupeKey: wake.requestId,
        });
        if (delivery.status === 'sent') {
            await this.store.putRunWake({ ...wake, status: 'sent', attempts: 1, updatedAt: this.now() });
            await this.appendActivity(wake.runId, 'wake-sent', '已提醒助手', {
                detail: wake.reason,
                dedupeKey: String(wake.wakeId),
            });
        }
        else {
            const message = delivery.error ?? 'channel delivery failed';
            await this.store.putRunWake({
                ...wake,
                status: 'failed',
                attempts: 1,
                updatedAt: this.now(),
                error: message,
            });
            await this.appendActivity(wake.runId, 'wake-suppressed', '提醒失败', {
                detail: message,
                level: 'error',
                dedupeKey: `${wake.wakeId}:failed`,
            });
        }
        this.emit();
    }
    wakeText(run, steps, reason) {
        return [
            `[DSH One 运行 ${run.runId} · ${reason}]`,
            `目标：${preview(run.goal, 400)}`,
            `工作区：${run.cwd}`,
            '步骤：',
            ...steps.map(step => `- [${step.status}] ${step.title}${step.latestReport === undefined ? '' : ` — ${step.latestReport}`}`),
            '',
            '这是宿主事件，不是用户的新消息；不要重新规划同一个目标。',
            reason === 'needs-you'
                ? '用一两句话说明卡在哪里，并提出一个具体的决定或下一步；不要重复状态条里的进度。'
                : reason === 'done'
                    ? '用一两句话汇报结果和证据；不要在聊天里逐条复述所有步骤。'
                    : '说明失败原因和建议的下一步；不要自动重试，除非用户明确要求。',
        ].join('\n');
    }
    async appendActivity(runId, kind, title, options = {}) {
        const run = this.store.getRun(runId);
        if (run === undefined)
            return;
        if (options.dedupeKey !== undefined) {
            const existing = this.store.listRunActivities(runId, 200).find(item => item.dedupeKey === options.dedupeKey);
            if (existing !== undefined)
                return;
        }
        const updated = await this.store.updateRun(runId, current => ({
            ...current,
            activitySeq: current.activitySeq + 1,
        }));
        const seq = updated.activitySeq;
        await this.store.appendRunActivity({
            activityId: `${runId}:${String(seq).padStart(8, '0')}`,
            runId,
            seq,
            ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
            cwd: run.cwd,
            at: this.now(),
            kind,
            level: options.level ?? 'info',
            title,
            ...(options.detail === undefined ? {} : { detail: preview(options.detail, 400) }),
            ...(options.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey }),
        });
    }
    view(run) {
        const projection = this.project(run);
        const done = projection.steps.filter(step => step.status === 'done').length;
        return {
            runId: run.runId,
            goal: run.goal,
            title: run.title,
            cwd: run.cwd,
            cwdLabel: run.cwdLabel,
            origin: run.origin,
            mode: run.mode,
            ...(run.assistantSessionId === undefined ? {} : { assistantSessionId: run.assistantSessionId }),
            status: run.status,
            paused: run.paused,
            ...(run.pauseReason === undefined ? {} : { pauseReason: run.pauseReason }),
            steps: projection.steps,
            limits: run.limits,
            deadlineAt: run.deadlineAt,
            ...(run.attention === undefined ? {} : { attention: run.attention }),
            ...(run.verdict === undefined ? {} : { verdict: run.verdict }),
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            ...(run.terminalAt === undefined ? {} : { terminalAt: run.terminalAt }),
            progress: { done, total: projection.steps.length },
            elapsedMs: Math.max(0, (run.terminalAt ?? this.now()) - run.createdAt),
        };
    }
    plan(runId, input, goal, maxTasks) {
        const provided = (input.steps ?? []).slice(0, maxTasks);
        const source = provided.length === 0
            ? [{ title: (input.title ?? '').trim() || preview(goal, 80), goal }]
            : provided;
        return source.map((step, index) => ({
            index,
            taskId: `task-${hashOf({ runId, index })}`,
            title: step.title.trim() || preview(goal, 80),
            goal: step.goal.trim() || goal,
            ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
        }));
    }
    modeOf(input) {
        if (input.mode !== undefined)
            return input.mode;
        if (input.origin === 'human')
            return 'execute';
        if (input.origin === 'assistant')
            return this.config.assistantRunMode === 'execute' ? 'execute' : 'observed';
        return this.tasks.mode === 'active' ? 'execute' : 'observed';
    }
    taskOrigin(origin) {
        return origin === 'human' || origin === 'assistant' ? 'human' : 'agent';
    }
    ownerOf(input) {
        if (input.origin === 'assistant')
            return input.callerSessionId ?? this.settings.assistantSessionId();
        return this.settings.assistantSessionId() ?? input.callerSessionId;
    }
    resolveCwd(input) {
        const cwd = (input.cwd ?? input.callerCwd ?? this.config.defaultWorkspaceRoot).trim();
        if (cwd === '') {
            throw new OneError('one/run-no-workspace', 'a run needs a workspace; pass cwd or set defaultWorkspaceRoot');
        }
        if (!this.core.isWorkspaceAllowed(cwd)) {
            throw new OneError('one/workspace-forbidden', `workspace "${cwd}" is outside the allowed roots`, { cwd });
        }
        return cwd;
    }
    rebind(run, assistantId) {
        if (assistantId === undefined || run.assistantSessionId === assistantId)
            return run;
        return { ...run, assistantSessionId: assistantId, updatedAt: this.now() };
    }
    emit() {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            }
            catch {
                // A subscriber failure must not break the run that already settled.
            }
        }
    }
}
function clamp(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function transitionTitle(step) {
    if (step.status === 'done')
        return `已完成：${step.title}`;
    if (step.status === 'failed')
        return `失败：${step.title}`;
    return `需要你：${step.title}`;
}
function countRuns(runs) {
    return {
        active: runs.filter(run => run.status === 'active' && !run.paused).length,
        needsYou: runs.filter(run => run.status === 'needs-you').length,
        done: runs.filter(run => run.status === 'done').length,
        failed: runs.filter(run => run.status === 'failed' || run.status === 'exhausted').length,
        paused: runs.filter(run => run.paused).length,
    };
}
