/** The `one_sessions`, `one_send`, and `one_model` model-facing tools. */
import { OneError } from './types.js';
import { agentSessionId } from './core.js';
import { asBoolean, asRecord, asString } from './util.js';
const sessionsParameters = {
    type: 'object',
    properties: {
        all: {
            type: 'boolean',
            description: 'Include every session from session/list. False returns only registered sessions.',
        },
        workspace: {
            type: 'string',
            description: 'Optional absolute or prefix path used to filter sessions by cwd.',
        },
    },
    additionalProperties: false,
};
const sessionsOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        items: {
            type: 'array',
            required: true,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionId: { type: 'string', required: true },
                    title: { type: 'string' },
                    cwd: { type: 'string' },
                    running: { type: 'boolean', required: true },
                    blank: { type: 'boolean', required: true },
                    subagent: { type: 'boolean', required: true },
                    registered: { type: 'boolean', required: true },
                    trusted: { type: 'boolean', required: true },
                    model: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            provider: { type: 'string', required: true },
                            model: { type: 'string', required: true },
                            reasoningEffort: { type: 'string' },
                        },
                    },
                    status: { type: 'string', enum: ['active', 'missing', 'error'] },
                    lastSeenAt: { type: 'integer' },
                },
            },
        },
        degraded: { type: 'boolean', required: true },
        reconciledAt: { type: 'integer' },
        error: { type: 'string' },
    },
};
const sendParameters = {
    type: 'object',
    properties: {
        sessionId: { type: 'string', required: true, description: 'Target ordinary DSH session id.' },
        text: { type: 'string', required: true, description: 'User message text delivered to the target session.' },
        requestId: {
            type: 'string',
            description: 'Optional idempotency key. Reusing it returns the earlier outcome instead of sending twice.',
        },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue for the next turn, steer for the nearest step.' },
    },
    additionalProperties: false,
};
const sendOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        requestId: { type: 'string', required: true },
        targetSessionId: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['pending', 'sending', 'sent', 'observed', 'failed', 'unknown', 'cancelled'] },
        accepted: { type: 'boolean', required: true },
        observed: { type: 'boolean', required: true },
        attempts: { type: 'integer', required: true },
        error: { type: 'string' },
    },
};
const modelParameters = {
    type: 'object',
    properties: {
        sessionId: { type: 'string', required: true, description: 'Target ordinary DSH session id.' },
        provider: { type: 'string', required: true, description: 'Provider route id from session/modelCatalog.' },
        model: { type: 'string', required: true, description: 'Model id from the selected provider.' },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort id advertised by the model.' },
    },
    additionalProperties: false,
};
const modelOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        sessionId: { type: 'string', required: true },
        provider: { type: 'string', required: true },
        model: { type: 'string', required: true },
        reasoningEffort: { type: 'string' },
        selected: { type: 'boolean', required: true },
        observed: { type: 'boolean', required: true },
        fallbackUsed: { type: 'boolean', required: true },
        error: { type: 'string' },
    },
};
/** Register the three tools. */
export function registerOneTools(ctx, core, config) {
    const disposers = [
        ctx.tools.register(sessionsTool(core, config)),
        ctx.tools.register(sendTool(core, config)),
        ctx.tools.register(modelTool(core, config)),
    ];
    return () => {
        for (const dispose of disposers.reverse())
            dispose();
    };
}
function sessionsTool(core, config) {
    return {
        name: 'one_sessions',
        description: 'List DSH sessions with their workspace, run state, registration, and selected model. Read-only.',
        parameters: sessionsParameters,
        timeoutMs: config.commandTimeoutMs,
        output: {
            schema: sessionsOutput,
            render(_args, value) {
                const result = value;
                const lines = result.items.map(item => {
                    const flags = [item.running ? 'running' : 'idle', item.registered ? 'registered' : 'unlisted', item.subagent ? 'subagent' : 'ordinary'];
                    const model = item.model === undefined ? '' : ` model=${item.model.provider}/${item.model.model}`;
                    return `${item.sessionId}  ${flags.join(',')}${model}${item.cwd === undefined ? '' : `  ${item.cwd}`}`;
                });
                const head = `dsh-one sessions: ${result.items.length}${result.degraded ? ' (memory storage)' : ''}`;
                return [{ type: 'text', text: [head, ...lines, ...(result.error === undefined ? [] : [`error: ${result.error}`])].join('\n') }];
            },
        },
        async execute(args, exec) {
            const record = asRecord(args) ?? {};
            const all = asBoolean(record['all']) ?? true;
            const workspace = asString(record['workspace']);
            const listed = await core.listSessions();
            const items = listed.items.filter(item => {
                if (!all && !item.registered)
                    return false;
                if (workspace !== undefined && item.cwd !== undefined && !item.cwd.startsWith(workspace))
                    return false;
                return true;
            });
            return {
                items: items.map(toJsonSession),
                degraded: listed.degraded,
                ...(listed.reconciledAt === undefined ? {} : { reconciledAt: listed.reconciledAt }),
                ...(listed.error === undefined ? {} : { error: listed.error }),
            };
        },
    };
}
function sendTool(core, config) {
    return {
        name: 'one_send',
        description: 'Send a user message to another ordinary DSH session. In observe mode this records the intended send without delivering it. Reuse requestId for idempotent retries.',
        parameters: sendParameters,
        timeoutMs: config.commandTimeoutMs,
        output: {
            schema: sendOutput,
            render(_args, value) {
                const result = value;
                const state = result.observed ? 'observed (not sent)' : result.status;
                return [{ type: 'text', text: `one_send ${result.requestId} -> ${result.targetSessionId}: ${state}, attempts=${result.attempts}${result.error === undefined ? '' : `, error=${result.error}`}` }];
            },
        },
        async execute(args, exec) {
            const agent = requireAgent(exec);
            const record = asRecord(args);
            const sessionId = asString(record?.['sessionId']);
            const text = asString(record?.['text']);
            const requestId = asString(record?.['requestId']);
            const mode = asString(record?.['mode']);
            if (sessionId === undefined || text === undefined) {
                throw new OneError('one/invalid-argument', 'sessionId and text are required');
            }
            if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
                throw new OneError('one/invalid-argument', 'mode must be queue or steer');
            }
            return core.send({
                targetSessionId: sessionId,
                text,
                ...(requestId === undefined ? {} : { requestId }),
                ...(mode === undefined ? {} : { mode }),
                callerSessionId: agentSessionId(agent),
                source: 'tool',
                signal: exec.signal,
            });
        },
    };
}
function modelTool(core, config) {
    return {
        name: 'one_model',
        description: 'Select the model used by another ordinary DSH session from session/modelCatalog. In observe mode this records the intended selection without applying it.',
        parameters: modelParameters,
        timeoutMs: config.commandTimeoutMs,
        output: {
            schema: modelOutput,
            render(_args, value) {
                const result = value;
                const state = result.observed ? 'observed (not applied)' : result.selected ? 'selected' : 'not selected';
                return [{ type: 'text', text: `one_model ${result.sessionId}: ${state} ${result.provider}/${result.model}${result.fallbackUsed ? ' (fallback)' : ''}${result.error === undefined ? '' : `, error=${result.error}`}` }];
            },
        },
        async execute(args, exec) {
            const agent = requireAgent(exec);
            const record = asRecord(args);
            const sessionId = asString(record?.['sessionId']);
            const provider = asString(record?.['provider']);
            const model = asString(record?.['model']);
            const reasoningEffort = asString(record?.['reasoningEffort']);
            if (sessionId === undefined || provider === undefined || model === undefined) {
                throw new OneError('one/invalid-argument', 'sessionId, provider, and model are required');
            }
            return core.selectModel({
                targetSessionId: sessionId,
                provider,
                model,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                callerSessionId: agentSessionId(agent),
                source: 'tool',
                signal: exec.signal,
            });
        },
    };
}
function requireAgent(exec) {
    if (exec.agent === undefined) {
        throw new OneError('one/no-agent', 'this tool requires a calling agent session');
    }
    return exec.agent;
}
function toJsonSession(item) {
    return {
        sessionId: item.sessionId,
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        running: item.running,
        blank: item.blank,
        subagent: item.subagent,
        registered: item.registered,
        trusted: item.trusted,
        ...(item.model === undefined ? {} : { model: item.model }),
        ...(item.status === undefined ? {} : { status: item.status }),
        ...(item.lastSeenAt === undefined ? {} : { lastSeenAt: item.lastSeenAt }),
    };
}
