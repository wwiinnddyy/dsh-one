# DSH One

DSH One 是一个面向 DeepSeek Harness 的**通用工作区助手**：聊天是主入口，助手可以跨工作区观察、派活、推进目标，并在需要人决定时回来找你。

> 版本：`0.3.0`（完整重写版，旧实现保留在 git tag `legacy-0.2.0`）。
> 架构依据：DeepSeek Harness 的 Super-agent 设计（Router/Worker 双层、事件驱动、Effect 持久队列、单一写者）。
> 评审与决策记录：[docs/architecture-review.md](docs/architecture-review.md)。

## 它是什么

- **Router（助手会话）**：一个普通的 DSH 会话，但只有它拥有助手身份提示词。它负责理解目标、拆工单、挑执行会话、汇总结果。
- **Worker（执行会话）**：可以是某个工作区里**已有的会话**，也可以由助手选一个文件夹新建工作区后开会话。会话自己的 cwd 就是隔离单位。
- **Ticket（工单）**：唯一的工作单元。`Goal` 只是工单的分组，不拥有调度器。
- **Effects**：所有"提交后要做的事"（派发、投递、回传、回复）都走持久队列，统一重试与顺序。

## 使用

安装到 DSH profile 后重启：

1. 左侧「助手」打开助手会话；「工作台」打开工单/设置面板。
2. 直接对助手说目标，例如：
   > 在 `C:\work\demo` 里看看测试为什么挂了，修好并告诉我结果。
3. 助手会：
   - `one_work create` 建工单；
   - 复用或新建一个该工作区的执行会话（`assign` 带 `sessionId` 或 `cwd`）；
   - 执行会话收到带 `[来自助手「鲸宝」]` 的派工消息，完成后用 `one_work report` 汇报；
   - 需要人决定时，助手被唤醒并在对话里问你。
4. `/one status` 随时看工单；工作台面板可以停止工单、改助手名字与行为文本。

## 工具面

| 工具 | 作用 |
|---|---|
| `one_work` | 统一入口：`create` / `create_goal` / `assign` / `report` / `answer` / `complete` / `stop` / `create_workspace` / `message` |
| `one_status` | 只读：工单按阶段统计、会话、工作区 |

人类命令：`/one status`、`/one name [新名字|reset]`、`/one persona [文本|reset]`、`/one send <sessionId> <text>`、`/one workspace <path> [name]`、`/one assistant`。

## 架构

```
Router(助手会话) ── one_work ──▶ Engine(唯一写者) ──▶ Ticket
                                      │
                                      ├── Effects ──▶ Executor ──▶ Worker 会话
                                      │                              │
                                      └──────────── Report ◀─────────┘
```

- `src/core/`：领域模型、阶段表、Engine。零 I/O，可单测。
- `src/app/`：Store（`dsh_one_v3` 存储域）、Effects、Sessions、Executor、Settings、HTTP、工具与命令。
- `src/client.ts`：助手/工作台两个侧栏入口、助手身份条、工作台面板、设置页。

## 开发

```bash
npm run build
npm test
npm run typecheck
```

## 配置（核心行）

| Key | 默认 | 含义 |
|---|---|---|
| `displayName` | `鲸宝` | 助手名字；用户可在设置里覆盖 |
| `assistantHomeRoot` | `""` | 助手自己的目录根；空则 `<DSH home>/super-mind` |
| `mode` | `active` | `active` 才真正执行工具动作；设为 `observe` 则只拒绝并记录 |
| `allowedWorkspaceRoots` | `[]` | 允许的工作区根；空表示全部 |
| `maxWorkers` | `4` | 并发执行会话数 |
| `commandTimeoutMs` | `30000` | 单次会话操作超时 |
