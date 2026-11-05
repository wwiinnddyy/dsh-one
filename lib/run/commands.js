/** `/one run` and `/one runs` human commands. */
import { OneError } from '../types.js';
import { splitFirstToken } from '../util.js';
function serviceOf(ctx) {
    return ctx.get('oneRuns');
}
/** `/one runs [limit]` */
export function handleRuns(rest, ctx) {
    const service = serviceOf(ctx);
    if (service === undefined)
        return { kind: 'error', text: 'runs are not mounted (dsh-one-delegate row is disabled)' };
    const limit = Number.parseInt(rest.trim() === '' ? '20' : rest.trim(), 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return { kind: 'error', text: 'runs limit must be 1..100' };
    const runs = service.list().slice(0, limit);
    if (runs.length === 0)
        return { kind: 'success', text: 'no runs' };
    return { kind: 'success', text: runs.map(runLine).join('\n') };
}
/** `/one run <goal>`, `/one run show|pause|resume|cancel <runId>`, `/one run resume <runId>`. */
export function handleRun(rest, invocation, ctx) {
    const service = serviceOf(ctx);
    if (service === undefined)
        return { kind: 'error', text: 'runs are not mounted (dsh-one-delegate row is disabled)' };
    const { token, rest: body } = splitFirstToken(rest);
    if (token === '')
        return { kind: 'error', text: 'usage: /one run <goal> [--cwd <path>] [--deadline <min>] [--max-tasks <n>]' };
    const { token: maybeId, rest: reasonText } = splitFirstToken(body);
    if ((token === 'show' || token === 'pause' || token === 'resume' || token === 'cancel') && maybeId.startsWith('run-')) {
        if (token === 'show') {
            const run = service.get(maybeId);
            if (run === undefined)
                return { kind: 'error', text: `run "${maybeId}" was not found` };
            return { kind: 'success', text: showRun(run, service) };
        }
        return service.control({
            runId: maybeId,
            action: token,
            ...(reasonText.trim() === '' ? {} : { reason: reasonText.trim() }),
        }).then(run => ({ kind: 'success', text: `${run.runId}: ${run.status}${run.paused ? ' (paused)' : ''}` }));
    }
    const flags = extractFlags(rest);
    if (flags.text === '')
        return { kind: 'error', text: 'goal must not be empty' };
    return (async () => {
        try {
            const result = await service.start({
                goal: flags.text,
                ...(flags.title === undefined ? {} : { title: flags.title }),
                ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
                ...(flags.maxTasks === undefined ? {} : { maxTasks: flags.maxTasks }),
                ...(flags.deadlineMinutes === undefined ? {} : { deadlineMs: flags.deadlineMinutes * 60_000 }),
                origin: 'human',
                callerSessionId: invocation.agent.id,
                ...(invocation.agent.session.header.cwd === undefined ? {} : { callerCwd: invocation.agent.session.header.cwd }),
            });
            return {
                kind: 'success',
                text: `${result.observed ? 'observed' : 'started'} ${result.run.runId}: ${result.run.title} (${result.run.steps.length} steps; /one run show ${result.run.runId})`,
            };
        }
        catch (error) {
            if (error instanceof OneError)
                return { kind: 'error', text: `${error.code}: ${error.message}` };
            return { kind: 'error', text: String(error) };
        }
    })();
}
function showRun(run, service) {
    return [
        runLine(run),
        `goal ${run.goal}`,
        `workspace ${run.cwd} (${run.mode})`,
        ...run.steps.map(step => `  ${step.index + 1}. [${step.status}] ${step.title}${step.latestReport === undefined ? '' : ` — ${step.latestReport}`}`),
        ...(run.attention === undefined ? [] : [`attention ${run.attention.reason}`]),
        ...(run.verdict === undefined ? [] : [`verdict ${run.verdict}`]),
        'recent:',
        ...service.activities(run.runId, 8).map(activity => `  ${activity.at} ${activity.kind} ${activity.title}`),
    ].join('\n');
}
function runLine(run) {
    return `${run.runId}  ${run.status}${run.paused ? ' (paused)' : ''}  ${run.progress.done}/${run.progress.total}  ${run.title}${run.attention === undefined ? '' : `  ! ${run.attention.reason}`}`;
}
function extractFlags(text) {
    const tokens = text.split(/\s+/u);
    const kept = [];
    let title;
    let cwd;
    let maxTasks;
    let deadlineMinutes;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        const next = tokens[index + 1];
        if (token === '--title' && next !== undefined) {
            title = next;
            index += 1;
            continue;
        }
        if (token === '--cwd' && next !== undefined) {
            cwd = next;
            index += 1;
            continue;
        }
        if (token === '--max-tasks' && next !== undefined) {
            const value = Number.parseInt(next, 10);
            if (Number.isInteger(value) && value >= 1)
                maxTasks = value;
            index += 1;
            continue;
        }
        if (token === '--deadline' && next !== undefined) {
            const value = Number.parseInt(next, 10);
            if (Number.isInteger(value) && value >= 1)
                deadlineMinutes = value;
            index += 1;
            continue;
        }
        kept.push(token);
    }
    return {
        text: kept.join(' ').trim(),
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(maxTasks === undefined ? {} : { maxTasks }),
        ...(deadlineMinutes === undefined ? {} : { deadlineMinutes }),
    };
}
