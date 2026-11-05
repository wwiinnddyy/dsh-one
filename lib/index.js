/**
 * dsh-one core row: session registry, cross-session outbox, audit, `/one`,
 * the session tools, and the read-only Web panel routes.
 */
import z from '@deepseek-ai/schemastery';
import { OneCore } from './core/registry.js';
import { registerOneCommand } from './core/command.js';
import { registerOneTools } from './core/tools.js';
import { acquireStore } from './store/index.js';
import { OneSettings } from './core/settings.js';
import { registerAssistantPersona } from './core/identity.js';
import { registerPanelApi } from './panel/api.js';
import { registerDshGoPanel } from './panel/dsh-go.js';
/** Cordis plugin name. */
export const name = 'dsh-one';
/** Required services. `sessionController`, `storageDomain`, and `webServer` are optional. */
export const inject = ['tools', 'commands'];
/** Core row configuration. */
export const Config = z.object({
    displayName: z.string().min(1).max(24).default('鲸宝')
        .description('User-facing assistant name. A user-chosen override in settings wins over this default.'),
    assistantHomeRoot: z.string().default('')
        .description('Directory the assistant owns; "super-mind" is created inside it. A Session without a cwd cannot be opened without a Workspace prompt, so this must resolve to a real path.'),
    mode: z.union([z.const('observe'), z.const('active')]).default('observe')
        .description('Agent-initiated session tools: observe records only; active delivers and applies.'),
    assistantSendMode: z.union([z.const('observe'), z.const('active')]).default('active')
        .description('The assistant session is the user\'s proxy: active delivers its sends even while mode is observe. Set observe to record them too.'),
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
    panelEnabled: z.boolean().default(true)
        .description('Register the read-only /one/api panel routes and the optional DSH Go panel.'),
});
/**
 * Open storage, reconcile the registry, and register the core surfaces.
 * @param ctx - Cordis context carrying `tools`, `commands`, and optional host services.
 * @param config - validated deployment configuration.
 */
export async function apply(ctx, config) {
    const resolved = Config(config);
    const lease = await acquireStore(ctx, resolved);
    const core = new OneCore(ctx, resolved, lease.store);
    await core.start();
    ctx.inject?.(['sessionController'], () => {
        void core.start();
    });
    const settings = new OneSettings(lease.store, resolved.displayName);
    const provide = ctx.provide?.('oneCore', core);
    const provideSettings = ctx.provide?.('oneSettings', settings);
    ctx.effect(() => {
        const disposeTools = registerOneTools(ctx, core, resolved, {
            assistantSessionId: () => settings.assistantSessionId(),
            assistantName: () => settings.displayName(),
        });
        const disposeCommand = registerOneCommand(ctx, core, resolved, settings);
        const disposeApi = resolved.panelEnabled
            ? registerPanelApi(ctx, core, settings)
            : () => { };
        const disposeDshGo = resolved.panelEnabled
            ? registerDshGoPanel(ctx, core, settings)
            : () => { };
        const disposePersona = registerAssistantPersona(ctx, core, settings, resolved);
        return () => {
            disposePersona();
            disposeDshGo();
            disposeApi();
            disposeCommand();
            disposeTools();
            provideSettings?.();
            provide?.();
            void lease.release();
        };
    }, 'dsh-one: core surfaces');
}
