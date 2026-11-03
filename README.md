# DSH One

A resident DeepSeek Harness (DSH) bundle plugin for Phase 1 MVP:

- a durable session registry;
- cross-session user messages through the host's `session/prompt` path;
- per-session model selection through `session/modelCatalog` and `session/selectModel`;
- an outbox with idempotent request ids and bounded retries;
- an audit trail.

It does not implement Super Agent orchestration, a DSH Go native panel, or autonomous execution. Agent-initiated tools default to `observe`: they record intended actions without delivering or applying them.

## Target

- DSH `0.2.1-rc.4` (the version pinned by DSH Go)
- Node.js `>=24.9`

The plugin uses DSH host services rather than private RPC. It has no runtime dependency on DSH packages; `@deepseek-ai/schemastery` and `zod` are its only dependencies. A profile without `sessionController` still loads, but cross-session actions report `one/unavailable`.

## Install

From this repository:

```sh
dsh plugin --profile web add .
```

Restart the profile after installation. The bundle patch inserts the `dsh-one` row into the profile composition.

For a local checkout without a build, run:

```sh
npm install
npm run build
```

## Configuration

The bundle patch ships a conservative default:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `observe` | Agent-initiated `one_send` / `one_model` record only. `active` delivers and applies. |
| `allowAllSessions` | `false` | Operate any non-subagent session. Keep false on shared hosts. |
| `allowedSessionIds` | `[]` | Explicit target ids for agent-initiated tools. |
| `allowedWorkspaceRoots` | `[]` | Workspace roots agent-initiated tools may reach. |
| `allowSessionCreation` | `true` | Recreate a registered session missing from `session/list`. |
| `maxSendAttempts` | `3` | Bounded retries for `session/writer-held` and non-subagent `session/agent-busy`. |
| `retryDelayMs` | `1000` | Base exponential backoff. |
| `maxMessageChars` | `10000` | One message limit. |
| `commandTimeoutMs` | `30000` | Deadline for list, send, and model operations. |
| `modelFallback` | `true` | Fall back when the requested model route is unavailable. |
| `auditLimit` | `1000` | Retained audit rows. |

`/one` commands are explicit human actions and are not blocked by `observe`. The tools are the agent-initiated path and are blocked.

## Commands

`/one` never opens a model turn. It runs directly against the host services.

```text
/one sessions [all]                      list registered and host sessions
/one sessions add <sessionId> [cwd]      explicitly trust a session
/one send [--steer] [--id <requestId>] <sessionId> <text>
/one model <sessionId> <provider>/<model> [reasoningEffort]
/one status <requestId>
/one audit [limit]
/one help
```

## Tools

| Tool | Purpose |
|---|---|
| `one_sessions` | Read-only session list with workspace, run state, registration, trust, and selected model. |
| `one_send` | Send a user message to another ordinary session. Duplicate `requestId` returns the earlier outcome. |
| `one_model` | Select a model for another ordinary session. The result reports `fallbackUsed`. |

All three declare JSON Schema parameters and output schemas. `one_send` and `one_model` declare a cooperative timeout.

## Delivery semantics

- `one_send` uses the host's `sessionController.prompt`, the implementation behind the `session/prompt` Remote method. It does not call the HTTP API and does not open a UI session.
- Requests are persisted before delivery. A process stop while `sending` becomes `unknown` and is never retried automatically; use a fresh request id after checking the target session.
- `session/writer-held` and non-subagent `session/agent-busy` are retried with exponential backoff up to `maxSendAttempts`.
- Subagent sessions are rejected; their messages belong to `subagents/prompt` through the parent session.
- A failed send is recorded with its error; the tool returns the failed status rather than hiding it.

## Storage

The `dsh-one` domain uses `ctx.storageDomain` when present. It stores `sessions`, `outbox`, and `audit` tables. Without that service the plugin falls back to process memory and reports `degraded: true` from `one_sessions`.

## Security boundary

This plugin runs in the DSH host process. It can read the host session list and prompt sessions that pass its own registry/allowlist checks. It does not read provider keys, write arbitrary files, or bypass DSH tool approvals. The host's plugin trust model still applies: install only plugins you trust.

The default allows only the calling session and sessions explicitly added with `/one sessions add`. Set `allowAllSessions` or add workspace roots only when the host is single-user and trusted.

## Tests

```sh
npm test
```

The suite uses a fake Cordis context and fake host services. It covers registry reconciliation, idempotent send, observe mode, model selection and fallback, bounded retries, subagent rejection, and command behavior. It does not require a provider key.

A real `0.2.1-rc.4` integration test is not included; run it against a disposable DSH profile when that host is available.

## Known limitations

- No Super Agent loop, ticket DAG, Eval, or quality gate.
- No DSH Go native panel or notification protocol.
- No workspace lock; concurrent writers to one workspace are not serialized.
- No global token or cost budget.
- No cross-process outbox worker; delivery happens in the DSH host process.
