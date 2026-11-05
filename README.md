# DSH One

A single DeepSeek Harness (DSH) bundle plugin that adds:

- a durable session registry and cross-session messaging;
- a delegated task runtime with worker sessions, workspace leases, slots, reports, token budgets, recovery, and retry;
- a durable background-run ledger (goal → steps → assistant wakeups) with async start, an in-chat status strip, a header badge, and a right-side panel grouped by workspace;
- a source intake layer with trigger dedupe, a deterministic gate, rule assessment, policies, mandates, and idempotent acceptance;
- a Web panel and an optional DSH Go native panel.

The package is one npm package with internal modules. It mounts as three independent profile rows plus one browser half, so a missing optional host service can break at most its own row.

## Target and compatibility declaration

Verified against the installed DSH CLI `0.2.1-rc.5` (Node `>=24.9`).

```json
"engines": {
  "node": ">=24.9.0",
  "dsh": ">=0.2.1-rc.4 <0.3.0-0"
}
```

DSH's bundle compatibility check reads top-level `engines` and `peerDependencies`; when `engines.dsh` exists, the peer range is not used for the gate. The plugin therefore declares the DSH range once, and `peerDependencies` contains only the package it imports at runtime (`@deepseek-ai/schemastery`). There is no `peerDependenciesMeta` list, and no `0.2.1-rc.4` pin on the host packages.

The plugin imports no DSH package at runtime. Host services are reached through `ctx.get(name)` (or `ctx.inject([...], child => ...)`), so a profile without `storageDomain`, `sessionController`, `webServer`, `llm`, `permissionPresets`, or `dshGo` still loads and reports the missing capability.

## Rows

| Row | Package entry | Purpose | Default |
|---|---|---|---|
| `dsh-one` | `dsh-one` | registry, outbox, audit, `/one`, `one_sessions`/`one_send`/`one_model`/`one_session_create`, panel API | on |
| `dsh-one-delegate` | `dsh-one/delegate` | task state machine, run ledger, watchdog, wake policy, worker sessions, leases, slots, budgets, report and run tools | on, `taskMode: observe` |
| `dsh-one-ingress` | `dsh-one/ingress` | GitHub webhook/poll, trigger/thread/eval/policy/mandate | **disabled** |
| client half | `dsh-one/client` | assistant entry, in-chat run strip, header badge, right-side background panel, and its own Settings tab | web profiles only |

Each row has its own `Config` and its own `inject` list. The profile row's `disabled` flag is the only enable switch; there is no second `enabled` key inside a row. Ingress is disabled because it has no safe default: repository, actor, mention, and secret must be configured first.

## Install

From this repository:

```sh
npm install
npm run build
dsh plugin --profile web add .
```

Restart the profile. The bundle patch inserts the three rows. A Web profile also picks up the client half through `dsh.client.platform: "web"`. Non-Web profiles do not load it.

For a disposable smoke profile:

```sh
DSH_HOME=/tmp/dsh-one-smoke dsh plugin --profile smoke add /path/to/dsh-one
DSH_HOME=/tmp/dsh-one-smoke dsh --profile smoke --no-open
```

## First use

1. Configure the core row. Keep `mode: observe` until the audit trail is understood.
2. Configure `dsh-one-delegate` with `defaultWorkspaceRoot` (or pass `--cwd` per task). Keep `taskMode: observe` if agents should not create tasks without a human.
3. Create a task as a human: `/one task add Fix the failing test | Run the suite and report evidence` then `/one task assign <taskId>`.
4. The worker reports through `one_task_report`; `ready` appears in the panel's attention column. `/one task complete <taskId>` closes it.
5. Enable ingress only after setting the webhook secret, repository allowlist, actor allowlist, mention login, and workspace.

## Commands

`/one` never opens a model turn. It runs against host services and the shared store.

```text
/one name [<name> | reset]
/one sessions [all]
/one sessions add <sessionId> [cwd]
/one send [--steer] [--id <requestId>] <sessionId> <text>
/one model <sessionId> <provider>/<model> [reasoningEffort]
/one status <requestId>
/one audit [limit]
/one tasks [limit]
/one task add <title> | <goal> [--cwd <path>] [--priority <n>] [--budget <n>]
/one task assign <taskId>
/one task show <taskId>
/one task retry <taskId> [reason]
/one task cancel <taskId> [reason]
/one task complete <taskId>
/one runs [limit]
/one run <goal> [--cwd <path>] [--deadline <min>] [--max-tasks <n>]
/one run show|pause|resume|cancel <runId> [reason]
/one help
```

`/one task ...` is the human path and is not blocked by `taskMode: observe`.

## The assistant name

The plugin's user-facing name is a preference, not a package identity. The
package id stays `dsh-one`; only the label the user sees changes.

- `displayName` in the core row is the deployment default (24 characters,
  `鲸宝` out of the box).
- A name chosen by the user is persisted in the `settings` table and wins over
  the row default from then on.
- `/one name` prints the effective name and its reset target, `/one name <text>`
  sets it, and `/one name reset` restores the row default.
- In the Web shell the name is edited on the plugin's own **Settings → 助手**
  tab, which writes `PUT /one/api/settings` and `DELETE /one/api/settings`.
- Every surface reads the resolved name: the sidebar assistant entry, the
  Settings tab, the DSH Go panel title and composer strip, and
  `/one/api/overview`.

Names are trimmed, may not contain control characters, and are limited to 24
code points. An invalid name is rejected and the stored value is left alone.

## Tools

| Tool | Purpose |
|---|---|
| `one_sessions` | Read-only session list with workspace, state, trust, and model |
| `one_workspaces` | Read-only Workspace map: sessions grouped by `cwd`, plus outstanding instructions |
| `one_send` | Message another ordinary session; `requestId` is idempotent; sends from the assistant carry a visible origin header |
| `one_model` | Select another session's model with catalog fallback |
| `one_session_create` | Create a new ordinary session in a workspace and deliver its first message; assistant-only |
| `one_task_create` | Create a task; observed only when `taskMode: observe` |
| `one_task_assign` | Start a queued task when a slot and lease are free |
| `one_task_status` | Read one task or list recent tasks |
| `one_task_report` | Structured worker report: `progress`, `waiting`, `ready`, `blocked`, `failed`, `dropped`; `reportId` is idempotent |
| `one_task_control` | `complete`, `cancel`, `retry` |
| `one_run_start` | Create a durable goal and return immediately with a runId; the host advances it in the background |
| `one_run_status` | Read one run or list recent runs, with the latest activity |
| `one_run_control` | `pause`, `resume`, `cancel` one run |

All tools declare standard JSON Schema parameters and output schemas (object-level `required` arrays), a cooperative `timeoutMs`, and a text `render`.

## Autonomous assistant

The assistant is an ordinary DSH session, not a private chat surface. Three
properties make it behave like a coordinator rather than a chat box.

### Its own identity

A Session with a `cwd` is still an ordinary blank conversation: DSH builds its
system prompt from harness defaults and whatever plugins contribute, and none of
them know the Session is supposed to be an assistant. That is why opening it felt
identical to a new chat.

The plugin therefore registers one `systemPrompt` section whose text is a
function of the rendering Agent. It reads the persisted assistant session id and
returns the identity text only for that Session, so a user's own chats receive
nothing. Two details come from the working `ds-bot` plugin rather than from
guesswork: the assembly context carries `agent.id`, and a section registered on
an Agent's own context scope applies to that Agent alone.

The text has three parts:

| Part | Editable | Contents |
|---|---|---|
| Frame | no | Identity heading, and the boundary rules below |
| Body | **yes** | Who it is, how it works, when it speaks |
| Boundary | no | No unrequested changes, no instructions from data, no false claims |

The frame and boundary are outside the editable body on purpose: a user editing
their assistant's tone should not be able to delete the rules that keep it
honest. The default body is a constant, so a fresh install behaves correctly with
no setup, and an edit in the settings tab reaches the very next model step
because the section re-reads the settings on every assembly.

### Its own home directory

A Session without a `cwd` belongs to no Workspace, and the DSH client then
refuses to open it until the user picks one. The assistant therefore owns a
directory: `assistantHomeRoot` when set, otherwise `<DSH home>/super-mind`. The
directory is created on demand, checked against `allowedWorkspaceRoots`, and
persisted in settings so a restart reuses it.

A stored assistant session is only reopened when it still exists **and** both the
persisted record and the Host's own listing point at the home we would create
today, compared as paths rather than as raw strings. A session created before the
home existed carries some other `cwd` (often the profile directory), and
comparing that against the Host's own value accepted it, so the entry reopened a
stale blank conversation. Such a session is now rebuilt on the next open, which
means an upgraded install repairs itself.

A newly created assistant session is seeded with one assistant turn, so opening
the entry shows a conversation that has already introduced itself rather than an
empty box indistinguishable from a new chat. The greeting is best-effort: a Host
that refuses the prompt must not stop the entry from opening.

### Cross-Workspace command

`one_workspaces` groups every non-subagent session by its canonical `cwd` and
reports, per Workspace, its sessions, how many are running, and the outstanding
instructions already sent. Grouping is derived on every call from the Host's own
session list, so it cannot drift; a session without a `cwd` is reported as
"no workspace" rather than guessed into a bucket.

### Its visible identity

The assistant's conversation is still a normal DSH conversation — that is the
point, not an accident. But it must be *recognizable*: a chat that looks
exactly like every other chat gives no sign that this one can plan, delegate,
and keep working after the turn ends.

Two seats carry that, and both are scoped to the assistant's own Session:

- **The composer dock** (`conversation.input.dock`) is always present in the
  assistant conversation. When idle it reads `鲸宝 · 常驻助手 · 待命`; when a run
  exists it turns into the progress strip (`后台推进中 · 2/5 · 3m`).
- **The header chip** (`conversation.session.header.actions`) shows `助手` while
  idle and the attention count (`需要你 1`) when a run needs a decision.

Every other session renders neither. A profile without the right-sidebar services
still gets both; the dock's `后台` button just has nowhere to open.

### The origin tag

A message from the assistant must be visibly distinguishable from one the user
typed. It cannot ride on a structured field: `sessionController.prompt` is a
strict schema with no sender, and a `user/message` event whose `source.kind` is
not `user` renders as a `context` row — which the desktop's `ds-bot` plugin
hides. So the origin travels as a text header inside the body:

```text
[来自助手「鲸宝」]

<the message>
```

- Only the assistant's own session is tagged. Another agent's `one_send`, the
  human `/one send` command, and run wake-ups are delivered verbatim.
- The header is applied to `deliveredText`; the outbox still stores the raw
  `text`, so conflict detection, audit rows, and the panel read what the caller
  actually wrote.
- `senderLabel` is honored only for `source: 'assistant'`. A tool path that
  passes one is ignored, so the tag cannot be forged.
- Idempotency is by `requestId`: a retry returns the first outcome, including
  the name that was current when the send was recorded.

The tag is a label, not a security control. What actually bounds the assistant
is `assertOperable` (trusted or allowed targets), the audit trail, and the modes.

### Starting a session

`one_session_create` lets the assistant open a new ordinary DSH session and
speak first. It is gated twice: `allowSessionCreation` must be on, and the
caller must be the assistant's own session — a worker cannot grow the session
list. The order is fixed:

```text
create (controller.create with cwd)
  -> trust (sessions row, audit session_created)
  -> send  (first message, tagged with the origin header)
```

`idempotencyKey` makes the whole operation replay-safe: the key hashes to a
deterministic request id, and an existing outbox row returns the session that
was already created instead of making a second one. A host that picks a
different session id is accepted — the outbox is the idempotency authority. A
send that fails still returns the session id with `messageStatus: "failed"`, so
the caller never loses a session it just made.

`title` is this plugin's own label. `sessionController.create` has no title
field and DSH derives the conversation title itself, so the new session appears
in the sidebar under a host-generated name.

### Async runs

A run is one durable goal. The assistant calls `one_run_start`, which records
the plan, creates one task per step, kicks off dispatch, and **returns at once**
with a `runId`. This is the Super-agent async ReAct shape: the turn ends with
"started", not with a loop that blocks on workers.

```text
one_run_start
  -> runs row (goal, cwd, steps, bounds, deadline)
  -> one TaskRuntime task per step
  -> dispatch without awaiting the worker prompt
  -> return { runId, status: "started" }
```

The host, not the model turn, advances the run:

- a 15 s watchdog re-projects step states from the task ledger, enforces the
  deadline, and re-dispatches queued steps;
- task transitions are filtered in two levels — a deterministic transition
  filter (terminal or attention states only, deduped, coalesced for 1.5 s), then
  the `done` / `needs-you` / `failed` speaking policy;
- a decision that survives the filter is delivered as a wake to the assistant's
  own DSH session through the outbox, with a deterministic request id, so a
  restart cannot deliver the same wake twice;
- everything else (progress, retries, waiting) is written to the activity feed;
  the assistant stays quiet.

Completion is judged from **task states**, never from a self-assessment, so a
model claiming success cannot turn a failed task into a success. A run ends as
`done`, `failed`, `cancelled`, `exhausted` (deadline), and can be paused or
resumed at any point. Bounds are `runMaxTasks` (default 5), `runDeadlineMs`
(default 30 minutes), the per-task token budget, and `maxWorkers`.

Runs started from the assistant session execute by default
(`assistantRunMode: execute`) because the user is the one talking to it. Other
agent sessions still respect `taskMode: observe`; `/one run` is always the human
path. Set `assistantRunMode: observe` to record plans without dispatching.

The Web client shows the same ledger in three places: a status strip above the
assistant composer, a header badge that opens a right-side panel, and the panel
itself, grouped by canonical workspace `cwd`. The panel is read/control only; it
is not a second chat, and closing it does not stop the background work.

### When it speaks

The policy lives in `src/run/filter.ts` (which transitions are candidates) and
`src/task/notify.ts` (mute and quiet hours), and admits exactly three reasons to
interrupt:

| Reason | Raised when |
|---|---|
| `done` | The whole plan finished |
| `needs-you` | Something is blocked and only a person can unblock it |
| `failed` | The run failed and cannot recover on its own |

Progress, retries, and intermediate steps are deliberately not reasons to speak;
they stay visible in the task list for anyone who looks. Quiet hours hold back a
finished plan but never hold back `needs-you`, and notification selection is
idempotent so a reported event cannot notify twice across recovery.

## Task runtime

### State machine

```text
queued -> assigned -> running -> waiting / ready / blocked / failed -> done / cancelled
```

Every transition is a single-key atomic `update(taskId, fn)` on the `tasks` table. `assignments[]`, `inputs[]`, `latestReport`, `attention`, `mandate`, and `usage` live in that one row.

### Worker sessions

Each assignment creates one ordinary DSH session (not a subagent) through `sessionController.create`:

- `workerAgentPreset` composes the session when configured.
- `workerPermissionPreset` narrows the permission preset when the host offers it.
- `agent.ctx.tools.restrict` applies `workerToolAllow` or `workerToolDeny`.
- The plugin registers the worker session as trusted, so the default session allowlist keeps working.
- The dispatch prompt uses a deterministic request id `one:<taskId>:<inputId>`. DSH persists that id on the accepted user message and dedupes a repeated prompt across restart, which gives idempotent delivery without a new message id.
- A task the assistant ordered carries its origin header on every prompt it sends. The label is frozen on the task row at creation (`assistantLabel`), so a retry after the assistant is renamed still says the name the work was ordered under. A human task, another agent's task, and a source-intake task keep the plain prompt.

### Leases

`workspaceMode: lease` is the default. A task holds one active lease per canonical workspace (`canonicalWorkspace(cwd)`, case-insensitive on Windows). A second task on the same root stays `queued` until the first releases. Leases carry owner, heartbeat, and expiry; the heartbeat timer renews them. A process stop marks them expired.

### Slots

`maxWorkers` limits active assignments. One additional slot opens while human-origin work is queued or active, and human tasks sort before machine tasks. A terminal report releases a slot and pumps the queue.

### Reports and turn ends

`one_task_report` is the authoritative result. `turn/end` is only a fallback:

- a terminal report from the current assignment settles the task;
- a progress report leaves the task running;
- a completed turn with no report blocks the task with `turn-ended-without-report`;
- `error`, `aborted`, or `max-tokens` closes the assignment as failed.

`reportId` is stored under `<taskId>:<reportId>`, so a repeated report is a no-op.

### Token budget

Usage is accumulated from `assistant/message` events as `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. `lastUsageSeq` prevents counting one event twice. The runtime checks the budget before dispatch and after each turn. Exceeding it calls `agent.cancel({ kind: 'hook', reason: 'dsh-one: task stopped' })`, marks the task `blocked` with `budget-exceeded`, and never retries automatically. It does not reject at `agent/pre-step`, which would drop an already claimed input.

### Recovery and retry

On startup:

- `outbox` rows in `sending` become `unknown`;
- active assignments become `unknown`;
- affected tasks become `blocked` with `host-restarted`;
- active leases expire;
- nothing is resent automatically.

`/one task retry` or `one_task_control retry` creates a new assignment with a recovery prompt that asks the worker to inspect the directory, `git status`, and the PR/issue state before repeating any external action. Only `blocked` and `failed` tasks are retryable, up to `retryLimit`.

## Intake

### Data

One `dsh_one` domain holds `trigger`, `thread`, `eval`, `decision`, `policy`, `mandate`, `delivery`, `cursor`, and `subscription` rows in addition to the core tables. Tables are aggregated by key; there is no cross-table transaction.

### Flow

```text
source event
  -> trigger dedupe by source event id
  -> thread upsert
  -> gate (deterministic)
  -> at most one active eval per thread
  -> assessment (model or deterministic rules)
  -> decision
  -> accept: mandate + task + assignment + subscription + confirmation reply
```

Gate checks: source enabled, accept mode, repository allowlist, actor allowlist, bot denylist, event type allowlist, and an `@mention`. Empty repository or actor lists reject everything; `allowedActors: ["*"]` is the explicit allow-all.

`acceptMode`:

- `off` records a trigger and does nothing;
- `observe` runs the gate and assessment and records `would-accept` without creating a task;
- `auto` accepts only when every required rule passes.

Assessment uses `ctx.llm.stream` when `assessment.enabled` and provider/model are set. If the model is unavailable, invalid JSON, or fails a required rule, auto mode fails closed. With assessment disabled, each rule is checked by its `denyPattern` (a deterministic stand-in).

### Policy and mandate

A policy is immutable and versioned by a hash of strength, scope, and rules. When the configured policy changes:

- running evals are re-queued against the new version;
- affected tasks receive a `policy-changed` input; running mandates are not revoked;
- on startup, a mandate whose scope is no longer covered by the current policy blocks its task with `mandate-invalid`.

A mandate records the policy version, strength, scope, and the rule basis. It is insert-once and never updated.

### Acceptance idempotency

Acceptance is split into idempotent steps and reconciled at startup:

- deterministic task id from `(sourceId, externalId)`;
- deterministic mandate id from the thread and task;
- subscription id from the task;
- decision id from the trigger and outcome;
- confirmation delivery key `out:<taskId>:accept`.

A crash between steps is repaired by the startup reconciliation: an existing task and mandate without a decision gets the decision and thread link filled in.

## GitHub source

Configuration:

- `secretEnv` holds the webhook HMAC secret (default `DSH_ONE_GITHUB_WEBHOOK_SECRET`). Secrets are read from the environment on each request and never stored in the domain.
- `tokenEnv` holds the API token used for polling and replies (default `DSH_ONE_GITHUB_TOKEN`).
- `repositories`, `allowedActors`, `botLogins`, `requireMention`, `mentionLogin`, and `eventTypes` gate every event.
- `pollEnabled` adds a low-frequency issue-comment poller with a stored `since` cursor and ETag.

The webhook route is registered through `ctx.webServer.register` at `webhookPath`. It verifies `X-Hub-Signature-256` with a constant-time comparison and dedupes `X-GitHub-Delivery` in the `deliveries` table. Delivery is at-least-once; exactly-once is not promised. Polling is a backstop and only reads issue comments.

`/one/api/*` routes are different: they call `connection.requestRejection(req)` themselves, because raw Web routes do not inherit the `/api` authentication fence. The webhook route uses its HMAC source check. `requireHostAuth: true` additionally applies the host credential, but GitHub cannot send it unless a proxy injects it, so the default is false.

## Panel

### Web

`/one/api/overview`, `/one/api/tasks`, and `/one/api/decisions` are read-only and call the module read services; they never open `storageDomain` themselves. The run surface adds `GET /one/api/runs` (assistant identity, cwd-grouped runs, totals), `GET /one/api/run?id=` (one run plus its activity tail), `POST /one/api/runs` (create a human run), `POST /one/api/run/control` (pause/resume/cancel), and `GET /one/api/activity?after=` (activity cursor). Every route sits behind `connection.requestRejection`.

`/one/api/settings` is the settings write endpoint: `GET` reads the name, persona, session, home, `notifyMuted`, `runsPaused`, quiet hours, and the effective `assistantRunMode`; `PUT` accepts `displayName`, `persona`, `resetPersona: true`, `notifyMuted`, `runsPaused`, `quietFrom` + `quietTo` (minutes 0-1439, or both `null`), or `reset`; `DELETE` restores the row default name.

The client polls `/one/api/runs` every 5 seconds only while a run surface is mounted and the page is visible. SSE remains a documented future option; the raw Web route can already hold a stream open.

`/one/api/assistant` backs the assistant entry. `GET` reports the stored session id without creating anything, `POST` resolves the assistant's session and creates it on first use, and `DELETE` forgets it so the next open starts a fresh conversation. A stored id the host no longer lists is replaced rather than returned, because opening a dropped id would render an empty conversation instead of failing visibly. It is fenced like the write routes.

The client half is chat-first and draws no chat surface of its own:

- `sidebar.panellist` — the assistant entry, ordered `-100` so it sorts above the
  shipped Plugins and Schedules icons, i.e. above the workspace list. DSH owns the
  row's click and reduces it to `layout.selectPanel(id)`.
- `main` (keyed by `dsh-one-assistant`) — the paired central panel. It resolves
  the assistant's real session and calls `uiWorkspace.openSession(sessionId)`,
  which navigates to the ordinary conversation and clears the panel selection.
  The panel body is therefore only the momentary "opening" state; the user lands
  on a normal DSH chat whose conversation DSH renders itself.
- `conversation.input.dock` (id `dsh-one-runs`) — the in-chat status strip above
  the composer, rendered only when the current session is the assistant. It shows
  one line (quiet/running/needs-you/paused), a pause control, and an expandable
  step list; `needs-you` uses an assertive live region.
- `conversation.session.header.actions` — a small “后台” / “需要你” badge. It
  carries the count even when no right-sidebar service is present; the click
  opens the right panel when that service is available.
- a right-sidebar tab (kind `dsh-one-runs`, body key `dsh-one-runs`) — the
  read/control “后台” panel grouped by workspace `cwd`, with per-run pause,
  resume, cancel, step dots, and an activity tail. It is not a second chat, and
  closing it does not stop the background work. The tab type registers on the
  first successful poll (or the first badge click), because the right-sidebar
  plugin may apply after this one.
- `settings.section` (id `dsh-one`) — the plugin's own Settings tab, which owns
  its label, unlike a `settings.general.item` row whose label is unused.

It does not import host implementation code. `dsh.client.inject` is informational; the slot declaration remains the real load gate.

### DSH Go

The package declares one panel (`Tasks`, ≤16 characters) and one composer strip (`One 0/0`, ≤24). The host half probes the optional service with `ctx.inject(['dshGo'], ...)` (or `ctx.get`) and skips everything when the bridge is absent. The panel and strip read the same overview snapshot and call `refresh('one')` after task or intake changes.

**Upstream gaps:** deep links from a DSH Go panel entry to a DSH session, and OS-level notifications, are not exposed by the documented DSH or DSH Go plugin APIs. This plugin does not fake them. The README limitation is the deliverable.

## Security posture

- `mode: observe` for agent session tools by default.
- `taskMode: observe` for agent task tools by default; `/one task` and `/one run` are human paths.
- `assistantRunMode: execute` treats the assistant session as the user's proxy, so a goal the user states in chat actually dispatches workers. Every other agent session keeps `taskMode`. Set `assistantRunMode: observe` to record plans only. Runs are audited and their workspaces are checked against `allowedWorkspaceRoots`.
- Wakes are host-originated, delivered through the outbox with deterministic request ids, and never retried when the outcome is unknown. Mute and quiet hours suppress `done` but never `needs-you` or `failed`.
- Session allowlist is closed by default; plugin-created worker sessions are registered as trusted explicitly.
- Workspace roots are checked for agent-initiated operations and task creation; cross-workspace access is audited and denied by default.
- Ingress is disabled; empty repository/actor lists reject everything; bots are ignored; mention is required.
- Webhook secrets and API tokens come only from environment variables and are not written to the domain.
- The panel API refuses unauthenticated requests when the host Connection service is present.

## Storage

```ts
defineDomain({
  name: 'dsh_one',
  version: 2,
  compatibleVersions: [1],
  tables: { sessions, outbox, audit, tasks, leases, reports, triggers, threads, evals,
            decisions, policies, mandates, deliveries, cursors, subscriptions, settings,
            runs, run_activities, run_wakes },
})
```

The domain identifier must match DSH's `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`), which does not allow a hyphen. A real storage backend rejects `dsh-one` at open. The plugin therefore keeps one domain named `dsh_one` (the display name is the user-chosen assistant name); the previous unchecked `dsh-one` spec could not have persisted on a real host. Record schemas validate at the durable boundary; tables use single-key `put`/`update`, and no cross-table transaction is assumed.

`settings` carries user preferences keyed by `<namespace>.<key>`. Adding a table does not bump `version`, because the single-document backend reads a table missing from an older document as empty and rejects a document whose version stamp does not match — so bumping the version would make an existing store unopenable for a change that needs no migration.

## Configuration

### Core row

| Key | Default | Meaning |
|---|---|---|
| `mode` | `observe` | Agent session tools record only; `active` delivers and applies |
| `assistantSendMode` | `active` | The assistant is the user's proxy: `active` delivers its sends even while `mode` is `observe`; `observe` records them too |
| `assistantHomeRoot` | `""` | Root for the assistant's own directory; empty derives `<DSH home>` |
| `allowAllSessions` | `false` | Operate any non-subagent session |
| `allowedSessionIds` | `[]` | Explicit trusted targets |
| `allowedWorkspaceRoots` | `[]` | Allowed roots for agent operations |
| `allowSessionCreation` | `true` | Recreate registered sessions missing from `session/list` |
| `maxSendAttempts` | `3` | Bounded retries for writer-held/busy |
| `retryDelayMs` | `1000` | Base backoff |
| `maxMessageChars` | `10000` | One message limit |
| `commandTimeoutMs` | `30000` | List/send/model deadline |
| `modelFallback` | `true` | Fall back when a requested model route is unavailable |
| `auditLimit` | `1000` | Retained audit rows |
| `panelEnabled` | `true` | Register `/one/api` and the optional DSH Go panel |

### Delegate row

| Key | Default | Meaning |
|---|---|---|
| `taskMode` | `observe` | Agent task tools record only |
| `assistantRunMode` | `execute` | Runs started from the assistant session execute; `observe` records plans only |
| `maxWorkers` | `4` | Base concurrent slots; humans add one |
| `workspaceMode` | `lease` | One writer per canonical workspace |
| `leaseTtlMs` | `120000` | Lease lifetime renewed by heartbeat |
| `defaultWorkspaceRoot` | `''` | Fallback workspace |
| `workerAgentPreset` | `''` | Preset for worker sessions |
| `workerPermissionPreset` | `''` | Permission preset for worker sessions |
| `workerToolAllow` | `[]` | If non-empty, only these global tools remain |
| `workerToolDeny` | `[subagent, workflow, schedule, job]` | Removed global tools |
| `tokenBudget` | `200000` | Per-task budget; zero is unlimited |
| `retryLimit` | `3` | Maximum retry assignments |
| `reportMaxChars` | `4000` | Truncation limit per report field |
| `commandTimeoutMs` | `60000` | Worker creation/prompt deadline |
| `defaultTaskPriority` | `100` | Default ordering priority |
| `runMaxTasks` | `5` | Maximum steps one run may create (1-20) |
| `runDeadlineMs` | `1800000` | Default run budget; expired runs cancel unfinished steps |
| `wakeCoalesceMs` | `1500` | Window that merges task transitions into one wake decision |
| `watchdogTickMs` | `15000` | Host period for run projection, deadlines, and wake delivery |

### Ingress row

| Key | Default | Meaning |
|---|---|---|
| `acceptMode` | `observe` | `off`, `observe`, or `auto` |
| `maxBodyBytes` | `1000000` | Webhook body limit |
| `confirmReply` | `true` | Post an acceptance comment |
| `taskWorkspaceRoot` | `''` | Workspace for accepted tasks; empty declines acceptance |
| `taskBudgetTokens` | `200000` | Budget for an accepted task |
| `policyStrength` / `policyScope` | `standard` / `*` | Mandate fields |
| `policyRules` | `actionable`, `safe` | Required rules and optional `denyPattern` |
| `assessment.enabled` | `false` | Use the host model; off uses denyPattern |
| `github.enabled` | `false` | Mount webhook/poller |
| `github.repositories` | `[]` | Allowed repositories; empty rejects all |
| `github.allowedActors` | `[]` | Allowed logins; `["*"]` allows all |
| `github.requireMention` / `mentionLogin` | `true` / `''` | Mention gate |
| `github.pollEnabled` / `pollIntervalMs` | `false` / `60000` | Comment polling backstop |
| `github.requireHostAuth` | `false` | Extra host credential on the webhook route |

## Tests and build

```sh
npm test
```

The suite is offline and uses a fake Cordis context, fake session controller, fake agents, fake storage domain, fake Web server, fake Connection, and fake LLM. It covers:

- dispatch → report → complete;
- report idempotency;
- lease mutual exclusion;
- slot queue and the human +1 slot;
- token budget blocking and cancellation;
- duplicate usage accounting;
- crash recovery and `unknown`;
- retry with a recovery prompt;
- trigger dedupe;
- observe mode not accepting;
- gate rejection;
- assessment unavailable failing closed;
- policy change and mandate revalidation;
- webhook HMAC and delivery dedupe;
- panel authentication and degraded reads;
- async run start returning before a worker prompt settles;
- progress staying quiet while `needs-you`, `done`, and `failed` each wake once;
- pause, mute, and quiet-hours suppression with the recorded reason;
- deadline cancellation and `exhausted`;
- restart reattachment without resending a settled wake;
- assistant-origin execution vs. observe-only agent sessions;
- run API grouping, control, validation, and degradation;
- client dock, badge, and right-panel registration and fallback;
- package/version/row/client manifest invariants.

`npm run build` cleans `lib/` and regenerates every runtime and declaration artifact. Commit the rebuilt `lib/` with `src/`.

### Real-host smoke

A disposable `0.2.1-rc.5` Web profile was created with `dsh plugin --profile smoke2 add .`:

- `--dump-config` composed all three rows (`dsh-one`, `dsh-one-delegate`, `dsh-one-ingress` disabled);
- `dsh --profile smoke2 --no-open` booted and printed a Web URL with no “entries did not activate” warning;
- `GET /one/api/overview` returned the plugin's own JSON `401 unauthorized` (the route was registered only after the core tool and command registration effect had succeeded).

Task dispatch and intake acceptance were exercised only with fakes. A real model turn, a real GitHub webhook, a real DSH Go bridge, and a real storage backend restart were not part of this smoke.

## What this took from DeepSeek-Bot

- **Deterministic identities before side effects:** DS Bot writes request receipts before delivery and treats an uncertain outcome as non-retryable. DSH One uses the same posture for `requestId`, `reportId`, `deliveryId`, mandate, subscription, and task ids.
- **A small module per concern, one runtime object:** DS Bot installs modules on a runtime and keeps registration order explicit. DSH One does the same with `core/`, `task/`, `intake/`, `source/`, and `panel/`.
- **Recovery is a state, not a resend:** DS Bot records `unknown`/`resent` and never silently repeats work. DSH One marks interrupted assignments and leases, then requires an explicit retry with a recovery prompt.
- **Structured results, not chat text:** DS Bot separates a Bot's reply from its recorded result. DSH One makes `one_task_report` authoritative and uses `turn/end` only as a fallback.
- **Transport metadata in the message:** DS Bot puts role, sender, and exchange identity into the message source. DSH One puts the deterministic task request id there through `sessionController.prompt`.
- **A read-only server surface:** DS Bot's browser half reads server-owned state. DSH One's panel does the same through `/one/api` and never opens storage.

## Known limitations and upstream gaps

- **Not fully verified on a real DSH host.** Boot, row activation, and panel route registration were verified on a disposable `0.2.1-rc.5` profile. Real worker turns, real intake delivery, a real storage backend restart, and a real DSH Go bridge were not.
- **DSH Go deep links and system notifications are upstream gaps.** No public API exposes them; this plugin does not fake either.
- **At-least-once, never exactly-once.** Webhook delivery dedupe, deterministic ids, and startup reconciliation reduce duplicates; they cannot make an external side effect transactional with the local store.
- **Assessment quality depends on the configured model.** Deterministic `denyPattern` rules are a safe fallback, not a semantic classifier.
- **Polling covers issue comments only.** It is a backstop for missed webhooks, not a full event mirror.
- **The assistant needs the Web shell's sidebar and settings slots.** A profile without `dsh-client-ui-sidebar` / `dsh-client-ui-layout` loads the host half but draws neither the entry nor the tab. The in-chat strip needs `conversation.input.dock`; the header badge and right panel additionally need the right-sidebar services, and degrade to the strip when those are absent.
- **No proactive idle and no IM yet.** A run advances only after the user states a goal; the assistant does not look for work on its own. The channel seam (`src/channel/`) is outbound-only and the QQ adapter is deferred.
- **Polling, not SSE.** The Web surfaces poll the run summary every 5 seconds while visible. A profile with many runs pays that small cost continuously; SSE is the next step if it matters.
- **The webhook route is authenticated by HMAC by default.** `requireHostAuth` is for deployments behind a proxy that adds the host credential; GitHub itself cannot.
- **Worker tool restriction can be partial.** `tools.restrict` rejects a whole list when one name belongs to the worker's own scope; the runtime retries individual denies and records a partial result.
- **The origin tag is a label, not a signature.** `[来自助手「名字」]` is plain text inside the message body. A profile that replaces the chat node (the desktop's `ds-bot` hides `context` rows) still shows it, but nothing verifies it and a human could type it by hand. The real controls are `assertOperable`, the audit trail, and the modes.
- **A new session's title is host-generated.** `one_session_create` accepts `title`, but `sessionController.create` has no title field, so the label lives only in this plugin's registry; the sidebar shows the name DSH derived. A rename tool would be a separate feature.
- **Renaming the assistant does not rewrite history.** Sends already recorded keep the name they were delivered under, and a retried `requestId` returns the first outcome. That is deliberate: a tag that changed after the fact would be a worse lie.
