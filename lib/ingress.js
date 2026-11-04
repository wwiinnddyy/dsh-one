/**
 * dsh-one ingress row: source adapters, webhook route, trigger/thread/eval,
 * policy, mandate, decision, and acceptance. Disabled by default.
 */
import z from '@deepseek-ai/schemastery';
import { OneError } from './types.js';
import { OneCore } from './core/registry.js';
import { defaultCoreConfig } from './core/defaults.js';
import { acquireStore } from './store/index.js';
import { IntakeRuntime } from './intake/runtime.js';
import { GithubSource, jsonResponse, readBody } from './source/github.js';
import { classifyError, now as systemNow, preview } from './util.js';
/** Cordis plugin name. */
export const name = 'dsh-one-ingress';
/** No required surface beyond the optional host services read through `ctx.get`. */
export const inject = [];
const ruleSchema = z.object({
    id: z.string().required(),
    text: z.string().required(),
    required: z.boolean().default(true),
    denyPattern: z.string(),
});
/** Ingress row configuration. */
export const Config = z.object({
    acceptMode: z.union([z.const('off'), z.const('observe'), z.const('auto')]).default('off')
        .description('off ignores events; observe records would-accept; auto accepts when every required rule passes.'),
    maxBodyBytes: z.natural().min(1024).max(32 * 1024 * 1024).default(1_000_000)
        .description('Maximum webhook body size.'),
    confirmReply: z.boolean().default(true)
        .description('Post an acceptance comment back to the source thread.'),
    taskWorkspaceRoot: z.string().default('')
        .description('Workspace given to accepted source tasks. Acceptance fails closed while empty.'),
    taskBudgetTokens: z.natural().default(200_000)
        .description('Token budget for one accepted source task.'),
    policyStrength: z.union([z.const('advisory'), z.const('standard'), z.const('strict')]).default('standard')
        .description('Recorded mandate strength.'),
    policyScope: z.string().default('*')
        .description('Scope a mandate covers; * covers every repository.'),
    policyRules: z.array(ruleSchema).default([
        {
            id: 'actionable',
            text: 'The request asks for concrete repository work with an observable outcome.',
            required: true,
        },
        {
            id: 'safe',
            text: 'The request contains no credentials, secret exfiltration, or destructive shell instructions.',
            required: true,
            denyPattern: '(api[_-]?key|secret|password|token)\\s*[:=]|rm\\s+-rf|curl\\s+.*\\|\\s*(?:sh|bash)|git\\s+push\\s+--force',
        },
    ])
        .description('Ordered assessment rules. Each rule is checked by the model or by its denyPattern.'),
    assessment: z.object({
        enabled: z.boolean().default(false)
            .description('Use the host model for rule-by-rule assessment. Disabled uses deterministic denyPattern checks.'),
        provider: z.string().default(''),
        model: z.string().default(''),
        maxTokens: z.natural().min(1).max(4096).default(1024),
        timeoutMs: z.natural().min(1_000).max(120_000).default(20_000),
    }),
    github: z.object({
        enabled: z.boolean().default(false)
            .description('Mount the GitHub webhook route and poller.'),
        webhookPath: z.string().default('/one/webhook/github'),
        secretEnv: z.string().default('DSH_ONE_GITHUB_WEBHOOK_SECRET')
            .description('Environment variable holding the webhook HMAC secret. Never stored in the domain.'),
        tokenEnv: z.string().default('DSH_ONE_GITHUB_TOKEN')
            .description('Environment variable holding the API token used for polling and replies.'),
        repositories: z.array(String).default([])
            .description('Allowed owner/name repositories. Empty rejects every event.'),
        allowedActors: z.array(String).default([])
            .description('Allowed GitHub logins. Use ["*"] to allow every non-bot actor.'),
        botLogins: z.array(String).default(['dependabot[bot]', 'github-actions[bot]']),
        requireMention: z.boolean().default(true),
        mentionLogin: z.string().default('')
            .description('Bot login an event must mention when requireMention is true.'),
        eventTypes: z.array(String).default(['issues', 'issue_comment', 'pull_request', 'pull_request_review_comment']),
        pollEnabled: z.boolean().default(false)
            .description('Poll issue comments as a low-frequency backstop.'),
        pollIntervalMs: z.natural().min(30_000).max(3_600_000).default(60_000),
        apiBaseUrl: z.string().default('https://api.github.com'),
        requireHostAuth: z.boolean().default(false)
            .description('Additionally require the DSH host credential on the webhook route. GitHub cannot send it; enable only behind a proxy that adds it.'),
    }),
});
function coreConfig() {
    return defaultCoreConfig();
}
/**
 * Mount source intake. The row is disabled in the shipped patch; enabling it
 * requires a webhook secret, repository list, and actor allowlist.
 * @param ctx - Cordis context with optional `webServer`, `connection`, and `oneCore`.
 * @param config - validated ingress configuration.
 */
export async function apply(ctx, config) {
    const resolved = Config(config);
    const lease = await acquireStore(ctx, coreConfig());
    const existingCore = ctx.get('oneCore');
    const core = existingCore ?? new OneCore(ctx, coreConfig(), lease.store);
    if (existingCore === undefined)
        await core.start();
    const github = new GithubSource(resolved.github, lease.store);
    const intake = new IntakeRuntime(ctx, resolved, lease.store, core, {
        reply: resolved.confirmReply && resolved.github.enabled
            ? async (thread, text, key) => { await github.reply(thread, text, key); }
            : undefined,
        poll: resolved.github.enabled && resolved.github.pollEnabled
            ? async (signal) => await github.poll(signal)
            : undefined,
    });
    await intake.start();
    const provide = ctx.provide?.('oneIntake', intake);
    const disposers = [];
    if (resolved.github.enabled) {
        if (!resolved.github.webhookPath.startsWith('/')) {
            throw new OneError('github/webhook-path', 'webhookPath must start with "/"', { path: resolved.github.webhookPath });
        }
        const server = ctx.get('webServer');
        if (server === undefined) {
            await core.audit({ action: 'webhook_route_unavailable', outcome: 'error', detail: 'webServer is absent' });
        }
        else {
            disposers.push(server.register({
                kind: 'exact',
                path: resolved.github.webhookPath,
                handler: (req, res) => handleWebhook(ctx, resolved, github, intake, lease.store, core, req, res),
            }));
        }
    }
    ctx.effect(() => {
        const timer = resolved.github.enabled && resolved.github.pollEnabled
            ? setInterval(() => { void intake.pollNow(); }, resolved.github.pollIntervalMs)
            : undefined;
        timer?.unref?.();
        return () => {
            if (timer !== undefined)
                clearInterval(timer);
            for (const dispose of disposers.reverse())
                dispose();
            provide?.();
            void lease.release();
        };
    }, 'dsh-one: ingress');
}
async function handleWebhook(ctx, config, github, intake, store, core, req, res) {
    if (req.method !== 'POST') {
        jsonResponse(res, 405, { error: 'method not allowed' });
        return;
    }
    if (config.github.requireHostAuth) {
        const connection = ctx.get('connection');
        const rejection = connection === undefined ? 503 : connection.requestRejection(req);
        if (rejection !== undefined) {
            jsonResponse(res, rejection, { error: rejection === 503 ? 'authentication unavailable' : 'unauthorized' });
            return;
        }
    }
    let raw;
    try {
        raw = await readBody(req, config.maxBodyBytes);
    }
    catch (error) {
        const status = error.status ?? 400;
        jsonResponse(res, status, { error: classifyError(error).message });
        return;
    }
    let envelope;
    try {
        envelope = github.verify(req.headers, raw);
    }
    catch (error) {
        const code = error instanceof OneError ? error.code : classifyError(error).code;
        const status = code === 'github/bad-signature' ? 401 : code === 'github/secret-missing' ? 503 : 400;
        jsonResponse(res, status, { error: classifyError(error).message });
        return;
    }
    const inboundId = `in:github:${envelope.deliveryId}`;
    if (store.getDelivery(inboundId) !== undefined) {
        jsonResponse(res, 202, { ok: true, delivery: envelope.deliveryId, duplicate: true, events: 0, statuses: [] });
        return;
    }
    const statuses = [];
    let failed = false;
    for (const event of envelope.events) {
        try {
            const result = await intake.handle(event);
            statuses.push(result.status);
        }
        catch (error) {
            failed = true;
            statuses.push('error');
            await core.audit({
                action: 'webhook_event_failed',
                outcome: 'error',
                detail: `${envelope.deliveryId}: ${classifyError(error).message}`,
            });
        }
    }
    await store.putDelivery({
        deliveryId: inboundId,
        sourceId: 'github',
        direction: 'in',
        externalId: envelope.deliveryId,
        status: failed ? 'failed' : statuses.includes('accepted') ? 'accepted' : statuses.includes('declined') ? 'rejected' : 'received',
        at: systemNow(),
        detail: preview(statuses.join(',') || 'no supported events', 200),
    });
    jsonResponse(res, 202, { ok: true, delivery: envelope.deliveryId, events: envelope.events.length, statuses });
}
