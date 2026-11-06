# DSH One

DSH One 是一个面向 DeepSeek Harness 的**通用工作区助手**：一个属于自己的页面，进来就能直接和助手对话，同时它能跨工作区拆工单、复用或新建执行会话、推进目标，需要人决定时再回来找你。

> 版本：`0.3.0`（完整重写版，旧实现保留在 git tag `legacy-0.2.0`）。
> 架构依据：DeepSeek Harness 的 Super-agent 设计（Router/Worker 双层、事件驱动、Effect 持久队列、单一写者）。
> 评审与决策记录：[docs/architecture-review.md](docs/architecture-review.md)。

## 它是什么

- **助手页面**：左侧「助手」打开的是一个**插件自绘的整页**——自己的标题栏、自己的对话气泡、自己的输入框、对话/工单/设置三个标签。它**不是** the agent harness 的会话，也不会弹「选择工作区」。
- **身份联动**：侧栏入口的名字和图标、页面标题、每条助手消息的头像都来自同一份设置——名字 + 上传的头像图片（没上传时自动用名字首字生成字母头像）。改名或换头像会立刻同步到侧栏。
- **对话引擎**：页面直接调用宿主的 `ctx.llm`（用 profile 的默认模型），聊天记录持久化在 `dsh_one_v3` 域的 `chat` 表。系统提示词用同一套 persona，只对助手生效。
- **Ticket（工单）**：唯一工作单元。`Goal` 只是工单的分组，不拥有调度器。
- **Effects**：所有「提交后要做的事」（派发、投递、回传、回复）都走持久队列，统一重试与顺序。
- **Worker**：助手自己决定复用其他工作区里已有的会话，或选一个文件夹新建工作区/会话。

## 使用

安装到 DSH profile 后重启：

1. 左侧「助手」打开助手页面，直接输入目标，例如：
   > 在 `C:\work\demo` 里看看测试为什么挂了，修好并告诉我结果。
2. 页面立即显示你的话和助手的回复；助手会通过 `one_work` 建工单、挑/建执行会话、派活。回复支持宿主 Markdown 渲染（表格、代码块、KaTeX 数学公式、Mermaid 图表）、时间戳和复制；等待时有打字指示。
3. 「工单」标签看各工单阶段、可停止；「设置」改助手名字、上传头像、编辑行为文本。
4. 这是一个长期留存的对话框，没有「新对话」入口；`/one status`、`/one name`、`/one persona`、`/one send`、`/one workspace` 是人类命令入口。

## 工具面

| 工具 | 作用 |
|---|---|
| `one_work` | 统一入口：`create` / `create_goal` / `assign` / `report` / `answer` / `complete` / `stop` / `create_workspace` / `message` |
| `one_status` | 只读：工单按阶段统计、会话、工作区 |

## 架构

```
助手页面(自绘) ── /one/api/chat ──▶ ctx.llm ──▶ 回复写回 chat 表
      │
      └── /one/api/tickets ──▶ Engine(唯一写者) ──▶ Ticket
                                      │
                                      └── Effects ──▶ Executor ──▶ Worker 会话
```

- `src/core/`：领域模型、阶段表、Engine。零 I/O，可单测。
- `src/app/`：`dsh_one_v3` 存储域、Effects、Sessions、Executor、AssistantChat、Settings、HTTP、工具与命令。
- `src/client.ts`：整页助手 UI（一个侧栏入口 + 一个 `main` 面板 + 一个设置页）。

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
| `assistantHomeRoot` | `""` | 助手自己的目录根 |
| `mode` | `active` | `observe` 则拒绝工具动作 |
| `allowedWorkspaceRoots` | `[]` | 允许的工作区根；空表示全部 |
| `maxWorkers` | `4` | 并发执行会话数 |
| `commandTimeoutMs` | `30000` | 单次会话操作超时 |

助手对话默认使用 profile 的默认模型；可用 `/one` 设置或 `one.chatModel`（`provider/model`）覆盖。
