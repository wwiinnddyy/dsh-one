/**
 * dsh-one host plugin: a resident session registry, cross-session outbox, and
 * per-session model selector for DeepSeek Harness.
 *
 * MVP scope: no Super Agent orchestration, no DSH Go native panel, no
 * autonomous execution. Model-initiated tools are observe-only by default.
 */
import z from '@deepseek-ai/schemastery';
import { OneCore } from './core.js';
import { OneStore } from './store.js';
import { registerOneCommand } from './command.js';
import { registerOneTools } from './tools.js';
/** Cordis plugin name. */
export const name = 'dsh-one';
/** Required services. `sessionController` and `storageDomain` are optional at runtime. */
export const inject = ['tools', 'commands'];
/** Deployment configuration. */
export const Config = z.object({
    mode: z.union([z.const('observe'), z.const('active')]).default('observe')
        .description('Agent-initiated tools: observe records only; active delivers and applies.'),
    allowAllSessions: z.boolean().default(false)
        .description('Allow every non-subagent session. Keep false on shared hosts.'),
    allowedSessionIds: z.array(String).default([])
        .description('Explicit session ids that agent-initiated tools may operate.'),
    allowedWorkspaceRoots: z.array(String).default([])
        .description('Workspace roots that agent-initiated tools may reach.'),
    allowSessionCreation: z.boolean().default(true)
        .description('Create a registered session when session/list no longer has it.'),
    maxSendAttempts: z.natural().min(1).max(10).default(3)
        .description('Maximum attempts for one cross-session send.'),
    retryDelayMs: z.natural().default(1000)
        .description('Base backoff for writer-held and busy retries.'),
    maxMessageChars: z.natural().min(1).max(1_000_000).default(10_000)
        .description('Maximum text length for one cross-session message.'),
    commandTimeoutMs: z.natural().min(1_000).max(600_000).default(30_000)
        .description('Deadline for session/list, send, and model operations.'),
    modelFallback: z.boolean().default(true)
        .description('Fall back to another catalog route when the requested model is unavailable.'),
    auditLimit: z.natural().min(10).max(10_000).default(1_000)
        .description('Retained audit rows.'),
});
/**
 * Open storage, reconcile the registry, and register the command and tools.
 * @param ctx - Cordis context carrying `tools`, `commands`, and optional
 * `sessionController` / `storageDomain`.
 * @param config - validated deployment configuration.
 */
export async function apply(ctx, config) {
    const resolved = Config(config);
    const store = await OneStore.open(ctx, resolved);
    const core = new OneCore(ctx, resolved, store);
    await core.start();
    ctx.effect(() => {
        const disposeTools = registerOneTools(ctx, core, resolved);
        const disposeCommand = registerOneCommand(ctx, core, resolved);
        return async () => {
            disposeCommand();
            disposeTools();
            await core.dispose();
        };
    }, 'dsh-one: command, tools, storage');
}
