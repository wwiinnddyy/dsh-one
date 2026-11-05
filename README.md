# DSH One

DSH One 是一个面向 DeepSeek Harness 的**通用工作区助手**：聊天是主入口，助手可以跨工作区观察、派活、推进目标，并在需要人决定时回来找你。

> 当前状态：**0.3.0-alpha.0 基座**。旧实现（0.2.x）完整保留在 git tag `legacy-0.2.0`。
> 架构决策与迁移路线见 [docs/architecture-review.md](docs/architecture-review.md)。

## 这一版有什么

- **领域核心**（`src/core/`）：Ticket 是唯一工作单元，Engine 是唯一写者；Goal 只是分组，不拥有调度器。
- **Ticket 阶段表**（`src/core/stage.ts`）：`person/* / working/* / idle / ended` 由事实推导，不存冗余状态。
- **Effects 持久副作用队列**（`src/app/effects.ts`）：先落库、提交后执行，统一重试与顺序。
- **两个模型工具**：
  - `one_work` — 统一入口：create / assign / report / answer / complete / stop
  - `one_status` — 只读的阶段统计

## 还没做的（按阶段推进）

1. 把 Store 从内存绑定到 `ctx.storageDomain`
2. DSH Session 适配器（Router / Executor 两种角色）
3. Source 协议与聊天 Source
4. 工作台面板
5. 助手会话身份与常驻标识

## 开发

```bash
npm run build
npm test
npm run typecheck
```

## 目录

```
src/
  core/       领域模型、阶段表、Engine（零 I/O）
  app/        存储、Effects、模型工具
  index.ts    插件行入口
tests/        Node test 套件
docs/         架构评审与迁移方案
```
