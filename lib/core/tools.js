/** The `one_sessions`, `one_send`, `one_model`, and `one_session_create` model-facing tools. */
import { OneError } from '../types.js';
import { agentSessionId } from './registry.js';
import { defaultCoreConfig } from './defaults.js';
import { senderLabelFor } from './sender.js';
import { settingsService } from './settings.js';
import { asBoolean, asRecord, asString } from '../util.js';
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
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionId: { type: 'string' },
                    title: { type: 'string' },
                    cwd: { type: 'string' },
                    running: { type: 'boolean' },
                    blank: { type: 'boolean' },
                    subagent: { type: 'boolean' },
                    registered: { type: 'boolean' },
                    trusted: { type: 'boolean' },
                    model: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            provider: { type: 'string' },
                            model: { type: 'string' },
                            reasoningEffort: { type: 'string' },
                        },
                        required: ['provider', 'model'],
                    },
                    status: { type: 'string', enum: ['active', 'missing', 'error'] },
                    lastSeenAt: { type: 'integer' },
                },
                required: ['sessionId', 'running', 'blank', 'subagent', 'registered', 'trusted'],
            },
        },
        degraded: { type: 'boolean' },
        reconciledAt: { type: 'integer' },
        error: { type: 'string' },
    },
    required: ['items', 'degraded'],
};
const sendParameters = {
    type: 'object',
    properties: {
        sessionId: { type: 'string', description: 'Target ordinary DSH session id.' },
        text: { type: 'string', description: 'User message text delivered to the target session.' },
        requestId: {
            type: 'string',
            description: 'Optional idempotency key. Reusing it returns the earlier outcome instead of sending twice.',
        },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue for the next turn, steer for the nearest step.' },
    },
    required: ['sessionId', 'text'],
    additionalProperties: false,
};
const sendOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        requestId: { type: 'string' },
        targetSessionId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'sending', 'sent', 'observed', 'failed', 'unknown', 'cancelled'] },
        accepted: { type: 'boolean' },
        observed: { type: 'boolean' },
        attempts: { type: 'integer' },
        error: { type: 'string' },
    },
    required: ['requestId', 'targetSessionId', 'status', 'accepted', 'observed', 'attempts'],
};
const modelParameters = {
    type: 'object',
    properties: {
        sessionId: { type: 'string', description: 'Target ordinary DSH session id.' },
        provider: { type: 'string', description: 'Provider route id from session/modelCatalog.' },
        model: { type: 'string', description: 'Model id from the selected provider.' },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort id advertised by the model.' },
    },
    required: ['sessionId', 'provider', 'model'],
    additionalProperties: false,
};
const modelOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        sessionId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        selected: { type: 'boolean' },
        observed: { type: 'boolean' },
        fallbackUsed: { type: 'boolean' },
        error: { type: 'string' },
    },
    required: ['sessionId', 'provider', 'model', 'selected', 'observed', 'fallbackUsed'],
};
/**
 * Resolve the assistant identity from explicit options, else from the settings
 * service the core row provides. A profile that mounted neither still works:
 * no caller is the assistant, so no send is tagged.
 */
function assistantIdentity(ctx, options) {
    const settings = settingsService(ctx);
    const readSession = options?.assistantSessionId ?? (() => settings?.assistantSessionId());
    const readName = options?.assistantName ?? (() => settings?.displayName() ?? defaultCoreConfig().displayName);
    return {
        sessionId: readSession,
        name: readName,
        owns(callerSessionId) {
            if (callerSessionId === undefined)
                return false;
            return readSession() === callerSessionId;
        },
        label: () => senderLabelFor(readName()),
    };
}
/** Register the session, send, model, workspace, and session-create tools. */
export function registerOneTools(ctx, core, config, options) {
    const identity = assistantIdentity(ctx, options);
    const disposers = [
        ctx.tools.register(sessionsTool(core, config)),
        ctx.tools.register(sendTool(core, config, identity)),
        ctx.tools.register(modelTool(core, config)),
        ctx.tools.register(workspacesTool(core, config)),
        ctx.tools.register(sessionCreateTool(core, config, identity)),
    ];
    return () => {
        for (const dispose of disposers.reverse())
            dispose();
    };
}
const workspacesParameters = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Optional case-insensitive Workspace path fragment; omit for every Workspace.',
        },
        includeInstructions: {
            type: 'boolean',
            description: 'Include outstanding cross-session instructions. Defaults to true.',
        },
    },
    additionalProperties: false,
};
const workspacesOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        workspaces: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string' },
                    label: { type: 'string' },
                    running: { type: 'number' },
                    unregistered: { type: 'number' },
                    lastActivityAt: { type: 'number' },
                    sessions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                sessionId: { type: 'string' },
                                title: { type: 'string' },
                                running: { type: 'boolean' },
                                registered: { type: 'boolean' },
                                blank: { type: 'boolean' },
                            },
                        },
                    },
                },
            },
        },
        homeless: { type: 'array', items: { type: 'object', additionalProperties: true } },
        instructions: { type: 'array', items: { type: 'object', additionalProperties: true } },
        totals: { type: 'object', additionalProperties: true },
    },
};
/**
 * List the Workspaces the assistant can command, their Sessions, and the
 * instructions it already sent. Read-only, like `one_sessions`.
 */
function workspacesTool(core, config) {
    return {
        name: 'one_workspaces',
        description: 'List Workspaces with the sessions inside each, plus outstanding cross-session instructions. '
            + 'Sessions are grouped by their cwd, so this is the map to choose a target before calling one_send. Read-only.',
        parameters: workspacesParameters,
        timeoutMs: config.commandTimeoutMs,
        output: {
            schema: workspacesOutput,
            render(_args, value) {
                const result = value;
                const lines = [];
                for (const workspace of result.workspaces) {
                    lines.push(`${workspace.label}  (${workspace.sessions.length} sessions, ${workspace.running} running)  ${workspace.path}`);
                    for (const session of workspace.sessions) {
                        const title = session.title === undefined ? '' : `  ${session.title}`;
                        lines.push(`  ${session.sessionId}${session.registered ? '' : ' (unlisted)'}${title}`);
                    }
                }
                if (result.homeless.length > 0)
                    lines.push(`no workspace: ${result.homeless.length} session(s)`);
                const pending = result.instructions.filter(item => item.status === 'pending' || item.status === 'sending');
                for (const item of pending)
                    lines.push(`outstanding ${item.requestId} -> ${item.targetSessionId} (${item.status})`);
                return [{
                        type: 'text',
                        text: [
                            `dsh-one workspaces: ${result.workspaces.length} workspaces, ${result.totals.sessions} sessions, `
                                + `${result.totals.running} running, ${result.totals.pendingInstructions} outstanding`,
                            ...lines,
                        ].join('\n'),
                    }];
            },
        },
        async execute(args) {
            const record = asRecord(args) ?? {};
            const needle = asString(record['path'])?.toLowerCase();
            const includeInstructions = asBoolean(record['includeInstructions']) ?? true;
            const overview = await core.workspaceOverview();
            const workspaces = needle === undefined
                ? overview.workspaces
                : overview.workspaces.filter(group => group.path.toLowerCase().includes(needle));
            return {
                workspaces: workspaces.map(group => ({
                    path: group.path,
                    label: group.label,
                    running: group.running,
                    unregistered: group.unregistered,
                    ...(group.lastActivityAt === undefined ? {} : { lastActivityAt: group.lastActivityAt }),
                    sessions: group.sessions.map(session => ({
                        sessionId: session.sessionId,
                        ...(session.title === undefined ? {} : { title: session.title }),
                        running: session.running,
                        registered: session.registered,
                        blank: session.blank,
                    })),
                })),
                homeless: overview.homeless.map(session => ({ ...session })),
                instructions: includeInstructions ? overview.instructions.map(item => ({ ...item })) : [],
                totals: { ...overview.totals },
            };
        },
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
function sendTool(core, config, identity) {
    return {
        name: 'one_send',
        description: 'Send a user message to another ordinary DSH session. Messages sent from the assistant session carry a visible origin header; other callers do not. In observe mode this records the intended send without delivering it. Reuse requestId for idempotent retries.',
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
            const callerSessionId = agentSessionId(agent);
            // Only the assistant's own session speaks with the assistant posture; any
            // other agent, and the human `/one send` path, keeps the plain tool source.
            const isAssistant = identity.owns(callerSessionId);
            return core.send({
                targetSessionId: sessionId,
                text,
                ...(requestId === undefined ? {} : { requestId }),
                ...(mode === undefined ? {} : { mode }),
                callerSessionId,
                source: isAssistant ? 'assistant' : 'tool',
                ...(isAssistant ? { senderLabel: identity.label() } : {}),
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
const sessionCreateParameters = {
    type: 'object',
    properties: {
        cwd: { type: 'string', description: 'Absolute workspace directory the new session lives in.' },
        message: {
            type: 'string',
            description: 'First message the new session receives. Delivered with the assistant origin header.',
        },
        title: {
            type: 'string',
            description: 'Label kept in this plugin\'s registry only. DSH derives the conversation title itself.',
        },
        agentPreset: { type: 'string', description: 'Optional agent preset id used to compose the new session.' },
        idempotencyKey: {
            type: 'string',
            description: 'Reusing this key returns the session created earlier instead of making another.',
        },
    },
    required: ['cwd', 'message'],
    additionalProperties: false,
};
const sessionCreateOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
        sessionId: { type: 'string' },
        title: { type: 'string' },
        cwd: { type: 'string' },
        created: { type: 'boolean' },
        messageStatus: {
            type: 'string',
            enum: ['pending', 'sending', 'sent', 'observed', 'failed', 'unknown', 'cancelled'],
        },
        requestId: { type: 'string' },
        observed: { type: 'boolean' },
        error: { type: 'string' },
    },
    required: ['sessionId', 'cwd', 'created', 'messageStatus', 'observed'],
};
/**
 * Create a new ordinary session on the assistant's behalf.
 *
 * Gated twice: the deployment must allow creation, and the caller must be the
 * assistant's own session. A worker or another agent cannot use this to grow
 * the session list.
 */
function sessionCreateTool(core, config, identity) {
    return {
        name: 'one_session_create',
        description: 'Create a new ordinary DSH session in a workspace and deliver its first message with the assistant origin header. '
            + 'Only the assistant session may call this. Reuse idempotencyKey to retry without creating a second session.',
        parameters: sessionCreateParameters,
        timeoutMs: config.commandTimeoutMs,
        output: {
            schema: sessionCreateOutput,
            render(_args, value) {
                const result = value;
                const state = result.observed ? 'observed (not delivered)' : result.messageStatus;
                const title = result.title === undefined ? '' : ` "${result.title}"`;
                return [{
                        type: 'text',
                        text: `one_session_create ${result.sessionId}: ${result.created ? 'created' : 'existing'}${title}, first message ${state}${result.error === undefined ? '' : `, error=${result.error}`}`,
                    }];
            },
        },
        async execute(args, exec) {
            const agent = requireAgent(exec);
            const record = asRecord(args);
            const cwd = asString(record?.['cwd']);
            const message = asString(record?.['message']);
            if (cwd === undefined || message === undefined) {
                throw new OneError('one/invalid-argument', 'cwd and message are required');
            }
            if (identity.sessionId() === undefined) {
                throw new OneError('one/assistant-unavailable', 'no assistant session is set up yet; open the assistant first');
            }
            const callerSessionId = agentSessionId(agent);
            if (!identity.owns(callerSessionId)) {
                throw new OneError('one/assistant-only', 'only the assistant session may create sessions');
            }
            const title = asString(record?.['title']);
            const agentPreset = asString(record?.['agentPreset']);
            const idempotencyKey = asString(record?.['idempotencyKey']);
            return core.createSession({
                cwd,
                message,
                ...(title === undefined ? {} : { title }),
                ...(agentPreset === undefined ? {} : { agentPreset }),
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                ...(callerSessionId === undefined ? {} : { callerSessionId }),
                senderLabel: identity.label(),
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
