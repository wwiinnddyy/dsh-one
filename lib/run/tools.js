/** Model-facing run tools: start immediately, read status, and control. */
import { OneError } from '../types.js';
import { asNumber, asRecord, asString, preview } from '../util.js';
import { agentSessionId } from '../core/registry.js';
const startParameters = {
    type: 'object',
    properties: {
        goal: { type: 'string', description: 'The outcome to reach, with acceptance evidence.' },
        title: { type: 'string', description: 'Short label for the run.' },
        cwd: { type: 'string', description: 'Absolute workspace directory. Defaults to the caller cwd, then defaultWorkspaceRoot.' },
        steps: {
            type: 'array',
            description: 'Optional plan. Omit to make one step from the goal.',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    title: { type: 'string' },
                    goal: { type: 'string' },
                    cwd: { type: 'string' },
                },
                required: ['title', 'goal'],
            },
        },
        maxTasks: { type: 'integer', description: 'Create at most this many steps (1-20).' },
        deadlineMs: { type: 'integer', description: 'Wall-clock budget for the whole run.' },
        idempotencyKey: { type: 'string', description: 'Reusing this key returns the same run instead of creating another.' },
    },
    required: ['goal'],
    additionalProperties: false,
};
const statusParameters = {
    type: 'object',
    properties: {
        runId: { type: 'string', description: 'One run id. Omit to list recent runs.' },
        limit: { type: 'integer', description: 'Maximum rows when listing.' },
    },
    additionalProperties: false,
};
const controlParameters = {
    type: 'object',
    properties: {
        runId: { type: 'string' },
        action: { type: 'string', enum: ['pause', 'resume', 'cancel'] },
        reason: { type: 'string' },
    },
    required: ['runId', 'action'],
    additionalProperties: false,
};
const startOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        cwd: { type: 'string' },
        observed: { type: 'boolean' },
        steps: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    index: { type: 'integer' },
                    taskId: { type: 'string' },
                    title: { type: 'string' },
                },
                required: ['index', 'taskId', 'title'],
            },
        },
    },
    required: ['runId', 'status', 'cwd', 'observed', 'steps'],
};
const statusOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        run: { type: 'object', additionalProperties: true },
        runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        activities: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['run', 'runs', 'activities'],
};
const controlOutput = {
    type: 'object',
    additionalProperties: true,
    properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        paused: { type: 'boolean' },
    },
    required: ['runId', 'status', 'paused'],
};
export function registerRunTools(ctx, service, timeoutMs, options = {}) {
    const disposers = [
        ctx.tools.register(startTool(service, timeoutMs, options)),
        ctx.tools.register(statusTool(service, timeoutMs)),
        ctx.tools.register(controlTool(service, timeoutMs)),
    ];
    return () => {
        for (const dispose of disposers.reverse())
            dispose();
    };
}
function startTool(service, timeoutMs, options) {
    return {
        name: 'one_run_start',
        description: 'Start a durable goal that the host advances in the background. Returns immediately with a runId; '
            + 'do not poll in this turn. The host wakes you only when a person must decide, or the run finishes or fails. '
            + 'Use one_run_status to read status later.',
        parameters: startParameters,
        timeoutMs,
        output: {
            schema: startOutput,
            render(_args, value) {
                const result = value;
                return [{
                        type: 'text',
                        text: `one_run_start ${result.runId}: ${result.status}${result.observed ? ' (observed, not executed)' : ''} · ${result.steps.length} steps · ${result.cwd}`,
                    }];
            },
        },
        async execute(args, exec) {
            const record = asRecord(args) ?? {};
            const goal = asString(record['goal']);
            if (goal === undefined || goal.trim() === '')
                throw new OneError('one/invalid-argument', 'goal is required');
            const agent = requireAgent(exec);
            const callerSessionId = agentSessionId(agent);
            const assistantId = options.assistantSessionId?.();
            const steps = parseSteps(record['steps']);
            const result = await service.start({
                goal,
                ...(asString(record['title']) === undefined ? {} : { title: asString(record['title']) }),
                ...(asString(record['cwd']) === undefined ? {} : { cwd: asString(record['cwd']) }),
                ...(steps === undefined ? {} : { steps }),
                ...(asNumber(record['maxTasks']) === undefined ? {} : { maxTasks: asNumber(record['maxTasks']) }),
                ...(asNumber(record['deadlineMs']) === undefined ? {} : { deadlineMs: asNumber(record['deadlineMs']) }),
                ...(asString(record['idempotencyKey']) === undefined ? {} : { idempotencyKey: asString(record['idempotencyKey']) }),
                origin: assistantId !== undefined && callerSessionId === assistantId ? 'assistant' : 'agent',
                ...(callerSessionId === undefined ? {} : { callerSessionId }),
                ...(agent.session.header.cwd === undefined ? {} : { callerCwd: agent.session.header.cwd }),
            });
            return startJson(result);
        },
    };
}
function statusTool(service, timeoutMs) {
    return {
        name: 'one_run_status',
        description: 'Read one run or list recent runs, with the latest activity. Read-only.',
        parameters: statusParameters,
        timeoutMs,
        output: {
            schema: statusOutput,
            render(_args, value) {
                const result = value;
                if (typeof result.run['runId'] === 'string')
                    return [{ type: 'text', text: runLine(result.run) }];
                return [{ type: 'text', text: result.runs.length === 0 ? 'no runs' : result.runs.map(runLine).join('\n') }];
            },
        },
        async execute(args) {
            const record = asRecord(args) ?? {};
            const runId = asString(record['runId']);
            if (runId !== undefined) {
                const run = service.get(runId);
                if (run === undefined)
                    throw new OneError('one/run-not-found', `run "${runId}" was not found`, { runId });
                return { run: runJson(run), runs: [], activities: service.activities(runId, 20).map(activityJson) };
            }
            const limit = Math.max(1, Math.min(100, asNumber(record['limit']) ?? 20));
            const runs = service.list().slice(0, limit);
            return { run: {}, runs: runs.map(runJson), activities: [] };
        },
    };
}
function controlTool(service, timeoutMs) {
    return {
        name: 'one_run_control',
        description: 'Pause, resume, or cancel one run. Cancelling stops its unfinished step tasks.',
        parameters: controlParameters,
        timeoutMs,
        output: {
            schema: controlOutput,
            render(_args, value) {
                const result = value;
                return [{ type: 'text', text: `one_run_control ${result.runId}: ${result.status}${result.paused ? ' (paused)' : ''}` }];
            },
        },
        async execute(args) {
            const record = asRecord(args) ?? {};
            const runId = asString(record['runId']);
            const action = asString(record['action']);
            if (runId === undefined || action === undefined)
                throw new OneError('one/invalid-argument', 'runId and action are required');
            if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
                throw new OneError('one/invalid-argument', `unknown run action "${action}"`);
            }
            const run = await service.control({
                runId,
                action,
                ...(asString(record['reason']) === undefined ? {} : { reason: asString(record['reason']) }),
            });
            return runJson(run);
        },
    };
}
function requireAgent(exec) {
    if (exec.agent === undefined)
        throw new OneError('one/no-agent', 'this tool requires a calling agent session');
    return exec.agent;
}
function parseSteps(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.flatMap(item => {
        const step = asRecord(item);
        const title = asString(step?.['title']);
        const goal = asString(step?.['goal']);
        if (title === undefined || goal === undefined)
            return [];
        const cwd = asString(step?.['cwd']);
        return [{ title, goal, ...(cwd === undefined ? {} : { cwd }) }];
    });
}
function startJson(result) {
    return {
        runId: result.run.runId,
        status: result.observed ? 'observed' : 'started',
        cwd: result.run.cwd,
        observed: result.observed,
        steps: result.run.steps.map(step => ({ index: step.index, taskId: step.taskId, title: step.title })),
    };
}
export function runJson(run) {
    return {
        runId: run.runId,
        title: run.title,
        goal: preview(run.goal, 400),
        status: run.status,
        mode: run.mode,
        paused: run.paused,
        cwd: run.cwd,
        progress: run.progress,
        elapsedMs: run.elapsedMs,
        ...(run.attention === undefined ? {} : { attention: run.attention }),
        ...(run.verdict === undefined ? {} : { verdict: run.verdict }),
        steps: run.steps.map(step => ({
            index: step.index,
            taskId: step.taskId,
            title: step.title,
            status: step.status,
            ...(step.latestReport === undefined ? {} : { latestReport: step.latestReport }),
            ...(step.attention === undefined ? {} : { attention: step.attention }),
        })),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.terminalAt === undefined ? {} : { terminalAt: run.terminalAt }),
    };
}
function activityJson(activity) {
    return {
        kind: activity.kind,
        level: activity.level,
        title: activity.title,
        at: activity.at,
        ...(activity.detail === undefined ? {} : { detail: activity.detail }),
        ...(activity.taskId === undefined ? {} : { taskId: activity.taskId }),
    };
}
function runLine(run) {
    const suffix = run.paused ? ' (paused)' : run.attention === undefined ? '' : ` ! ${run.attention.reason}`;
    return `${run.runId}  ${run.status}  ${run.progress.done}/${run.progress.total}  ${run.title}${suffix}`;
}
