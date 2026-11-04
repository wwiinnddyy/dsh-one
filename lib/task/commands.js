/** `/one task` and `/one tasks` human commands. */
import { OneError } from '../types.js';
import { splitFirstToken } from '../util.js';
function serviceOf(ctx) {
    return ctx.get('oneTasks');
}
/** `/one tasks [limit]` */
export function handleTasks(rest, ctx) {
    const service = serviceOf(ctx);
    if (service === undefined)
        return { kind: 'error', text: 'delegation is not mounted (dsh-one-delegate row is disabled)' };
    const limit = Number.parseInt(rest.trim() === '' ? '20' : rest.trim(), 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return { kind: 'error', text: 'tasks limit must be 1..100' };
    const tasks = [...service.listTasks()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    if (tasks.length === 0)
        return { kind: 'success', text: 'no tasks' };
    return {
        kind: 'success',
        text: tasks.map(task => {
            const assignment = task.assignments.find(item => item.status === 'assigned' || item.status === 'running' || item.status === 'waiting');
            return `${task.taskId}  ${task.status}  ${task.origin}  ${task.title}${assignment === undefined ? '' : `  -> ${assignment.sessionId}`}${task.attention === undefined ? '' : `  ! ${task.attention.reason}`}`;
        }).join('\n'),
    };
}
/** `/one task add|assign|show|retry|cancel|complete ...` */
export function handleTask(rest, invocation, ctx) {
    const service = serviceOf(ctx);
    if (service === undefined)
        return { kind: 'error', text: 'delegation is not mounted (dsh-one-delegate row is disabled)' };
    const { token, rest: body } = splitFirstToken(rest);
    switch (token) {
        case 'add': return addTask(body, invocation, service);
        case 'assign': return assignTask(body, invocation, service);
        case 'show': return showTask(body, service);
        case 'retry': return controlTask('retry', body, invocation, service);
        case 'cancel': return controlTask('cancel', body, invocation, service);
        case 'complete': return controlTask('complete', body, invocation, service);
        case '':
            return { kind: 'error', text: 'usage: /one task add|assign|show|retry|cancel|complete' };
        default:
            return { kind: 'error', text: `unknown /one task action "${token}"` };
    }
}
function addTask(body, invocation, service) {
    const split = body.split('|');
    const title = split[0]?.trim() ?? '';
    let goal = split.slice(1).join('|').trim();
    if (title === '' || goal === '') {
        return { kind: 'error', text: 'usage: /one task add <title> | <goal> [--cwd <path>] [--priority <n>] [--budget <n>]' };
    }
    const flags = extractFlags(goal);
    goal = flags.text;
    if (goal === '')
        return { kind: 'error', text: 'goal must not be empty' };
    return (async () => {
        try {
            const result = await service.createTask({
                title,
                goal,
                ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
                ...(flags.priority === undefined ? {} : { priority: flags.priority }),
                ...(flags.budget === undefined ? {} : { tokenBudget: flags.budget }),
                origin: 'human',
                createdBy: invocation.agent.id,
            }, {
                source: 'command',
                callerSessionId: invocation.agent.id,
                ...(invocation.agent.session.header.cwd === undefined ? {} : { callerCwd: invocation.agent.session.header.cwd }),
            });
            return { kind: 'success', text: `created ${result.task.taskId}: ${result.task.title} (queued; /one task assign ${result.task.taskId})` };
        }
        catch (error) {
            if (error instanceof OneError)
                return { kind: 'error', text: `${error.code}: ${error.message}` };
            return { kind: 'error', text: String(error) };
        }
    })();
}
function assignTask(body, invocation, service) {
    const taskId = body.trim();
    if (taskId === '')
        return { kind: 'error', text: 'usage: /one task assign <taskId>' };
    return service.assign(taskId, { callerSessionId: invocation.agent.id }).then(result => ({
        kind: 'success',
        text: `${result.task.taskId}: ${result.task.status}${result.started ? ' started' : result.waitingForLease ? ' waiting for workspace lease' : result.waitingForSlot ? ' waiting for a free worker slot' : ''}`,
    }));
}
function showTask(body, service) {
    const taskId = body.trim();
    if (taskId === '')
        return { kind: 'error', text: 'usage: /one task show <taskId>' };
    const task = service.getTask(taskId);
    if (task === undefined)
        return { kind: 'error', text: `task "${taskId}" was not found` };
    const assignment = task.assignments.find(item => item.status === 'assigned' || item.status === 'running' || item.status === 'waiting')
        ?? task.assignments[task.assignments.length - 1];
    return {
        kind: 'success',
        text: [
            `${task.taskId}  ${task.status}  ${task.origin}`,
            task.title,
            `workspace ${task.cwd} (${task.workspaceMode})`,
            `usage ${task.usage.totalTokens}/${task.tokenBudget === 0 ? 'unlimited' : task.tokenBudget} tokens`,
            ...(assignment === undefined ? ['no assignment'] : [
                `assignment ${assignment.assignmentId} ${assignment.status} prompt=${assignment.promptStatus}`,
                `session ${assignment.sessionId}`,
            ]),
            ...(task.latestReport === undefined ? [] : [`report ${task.latestReport.kind}: ${task.latestReport.summary}`]),
            ...(task.attention === undefined ? [] : [`attention ${task.attention.kind}: ${task.attention.reason}`]),
            ...(task.blockedReason === undefined ? [] : [`blocked ${task.blockedReason}`]),
        ].join('\n'),
    };
}
function controlTask(action, body, invocation, service) {
    const trimmed = body.trim();
    const { token: taskId, rest } = splitFirstToken(trimmed);
    if (taskId === '')
        return { kind: 'error', text: `usage: /one task ${action} <taskId> [reason]` };
    const reason = rest.trim();
    return service.control({
        taskId,
        action,
        ...(reason === '' ? {} : { reason }),
        callerSessionId: invocation.agent.id,
    }).then(task => ({ kind: 'success', text: `${task.taskId}: ${task.status}` }));
}
function extractFlags(text) {
    const tokens = text.split(/\s+/u);
    const kept = [];
    let cwd;
    let priority;
    let budget;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        const next = tokens[index + 1];
        if (token === '--cwd' && next !== undefined) {
            cwd = next;
            index += 1;
            continue;
        }
        if (token === '--priority' && next !== undefined) {
            const value = Number.parseInt(next, 10);
            if (Number.isInteger(value))
                priority = value;
            index += 1;
            continue;
        }
        if (token === '--budget' && next !== undefined) {
            const value = Number.parseInt(next, 10);
            if (Number.isInteger(value) && value >= 0)
                budget = value;
            index += 1;
            continue;
        }
        kept.push(token);
    }
    return {
        text: kept.join(' ').trim(),
        ...(cwd === undefined ? {} : { cwd }),
        ...(priority === undefined ? {} : { priority }),
        ...(budget === undefined ? {} : { budget }),
    };
}
