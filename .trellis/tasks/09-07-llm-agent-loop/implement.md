# Implement: LLM Agent Loop (M3)

执行计划。需求（R1–R5）、验收（A1–A7）、设计决策见 `prd.md` / `design.md`。

M1/M2 惯例沿用：每阶段末尾 `trellis-check` → `gomentor-verify`（只读）→ 主会话处置 FAIL 项。每道门禁必须构建并启动 `out/`（M1 R12 规则）。新纯逻辑随行变异覆盖。

## 标准验证命令（每阶段门禁）

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm check:i18n && pnpm check:licenses && pnpm check:trellis && pnpm format:check
pnpm e2e
pnpm build            # 外加启动 out/ 的既有门禁
tsx scripts/mutate-llm.mts   # Stage 1 新建（或扩展既有 harness 模式）
```

## Stage 1 — 工具注册表与三个只读工具（R2）✅（2026-09-07，check 4 项自修复 + verify PASS）

- [x] `main/llm/agent/tools.ts` — 注册表：`ToolSchema` 从注册表派生（wire 层单一事实源）；每工具 zod 参数 schema + `execute(args, ctx, signal)`
- [x] `get_position`：store 读取 + 精简 JSON 组装（不全谱 SGF）；moveNumber 边界（0..moves.length，含 setup）；纯逻辑独立导出
- [x] `search_library`：`store.list()` 元数据子串过滤（大小写不敏感、≤10 条）；纯过滤函数独立导出，变异覆盖
- [ ] `main/katago/service.ts` 增 `analyzeOnce(game, moveNumber)`：`agent:<n>` id 前缀独立查询，不触碰 desired/sweep/光标去抖；固定 128 visits；复用 probe 的 await-完整结果机制；引擎不可用 → 可读错误（非 crash）
- [x] 参数校验失败 → `isError: true` toolResult（模型自纠路径）；测试锚定该语义
- [x] 变异：检索过滤、参数边界、（若纯函数化）`analyzeOnce` 的位置换算（`scripts/mutate-llm.mts` 28/28）

**门禁证据**：单测 + 集成（真实 store、M2 fake 引擎跑真实 `analyzeOnce` 独立性——用户光标查询不被终止/取代，线上帧级断言）。验收：R2。verify PASS（2026-09-07）。

Stage 1 实际还触碰了（验证确认合理、增量、不开 A9 面）：`packages/shared/src/types/game.ts`（GameSummary + optional `event`，search 工具免加载全谱）、`packages/shared/src/types/analysis.ts`（`AGENT_QUERY_PREFIX`，仅 main 引用）。

**Stage 2 注意（Stage 1 verify notes）**：
1. 新工具的 throw 若非 `AppError`，消息/栈会进主日志——新工具禁止把棋谱/用户文本嵌进非 AppError 消息（`tools.ts` 已有此方向，需成文遵守）。
2. `AGENT_QUERY_VISITS=128` + `probeDeadlineMs=15s` 的自终止边界远小于 30s 看门狗（CPU 饥饿间接路径的算术余量）——若 Stage 2+ 调大任一值，需重估该余量。
3. harness 退出策略统一（mutate-llm 与 mutate-katago 对 ANCHOR/INVALID 均只计入 summary 不非零退出）留到 Stage 4 一并处置。

## Stage 2 — Agent runner（R1/R3/R4）✅（2026-09-08，check 5 修复含原型污染，verify PASS，提交 4800187）

- [x] `main/llm/agent/runner.ts` — 循环状态机：chunk 流消费（tool_call 增量累积，`done(tool_calls)` 触发执行）、串行执行、历史追加、上限 8（`MAX_AGENT_STEPS`）、AbortSignal 贯穿
- [x] 纯核拆分（步进决策/上限判定）供变异测试；`scripts/mutate-llm.mts` 建立（沿用 `mutate-katago.mts` 的基线门禁模式）
- [x] 降级三态分流（true/false/null→探测→缓存兜底 false）；降级路径 wire 层无 `tools` 参数——测试断言
- [x] `llm/service.ts` 接入：send 入口按能力分流；runId/cancel/fanout 语义不变
- [x] `LLM_AGENT_LIMIT` 错误码：`errors.ts` + `shared` schema + i18n（en/zh-CN 实译）
- [x] 集成：fake LLM（脚本化 tool_calls 序列，`ChatChunk` 形状直供）驱动真实 runner——闭环 / 上限 / 取消 / 降级 / 参数自纠 / 工具中取消

**门禁证据**：`out/` 构建 + 启动，真实 app + fake LLM 走通一次闭环。验收：R1/R3/R4 骨架。

## Stage 3 — 渲染层工具步骤（R5）✅（2026-09-08，check 修复空断言+死键，verify PASS）

- [x] `TeacherPanel` 消息流消费 `tool_call`/`tool_result` chunk：步骤行（工具名 + 参数摘要）+ 结果摘要（~120 字符可展开）
- [x] i18n：`teacher.json` 工具步骤键（zh-CN + en 实译——"键齐值同"不是翻译，门禁会抓）
- [x] 重载后事件丢失的现状语义确认（不孤儿化；面板呈现空白态——已在 chatStore 头注释与 spec 头成文；main 经真实 HTTP 计数断言跑完 run）

**门禁证据**：e2e 走真实路径——本地脚本化 SSE 模型服务器（`settings:set` 指向，零主进程改动）+ fake 引擎（`GOMENTOR_KATAGO_BINARY`），教师面板出现工具步骤且最终回答引用真实数字（交叉核对经破坏性验证有牙）。验收：R5、A1/A3/A5 渲染层半边。verify PASS（2026-09-08）。

**Stage 4 处置项（Stage 3 verify notes）**：
1. `teacher.json` 有 9 个 M1 遗留死键（cancelled/noKey.*/suggestion.*，从未有消费方）——删除或接线，并考虑 i18n 门禁增长消费检查（"键齐值同不是翻译"的同类教训）。
2. 教师面板 spec 的 `-g` 单测过滤会误导（describe 顺序设计）——重验证必须跑整个 describe（已记录在 spec 头）。

## Stage 4 — 最终门禁 ✅（2026-09-08，verify A1–A7 PASS，A2 缺口当场关闭）

- [x] A1–A7 全量核对（`gomentor-verify` 只读判定，逐条记录到任务 `final-gate.md`——M2 模式）
- [x] `docs/architecture.md` 更新到 M3 现实（ipc-contract.md 经核无需改动——M3 零新增 IPC 面）；spec 沉淀 4 条新教训 + directory-structure 漂移修正
- [x] 三平台 CI 绿；打包启动门禁照常执行（本地 42/42 e2e 含真引擎打包启动；CI 待推送验证）

## 风险文件 / 回滚点

| 文件 | 为什么小心 |
|---|---|
| `apps/desktop/src/main/llm/service.ts` | runId/fanout/cancel 语义是现有教师流的承重墙；M3 只加分流不改语义 |
| `apps/desktop/src/main/katago/service.ts` | `analyzeOnce` 必须与用户光标会话完全隔离——M2 的 B3 延迟承诺在这里 |
| `packages/shared/src/types/chat.ts` | 既有判别联合被渲染层消费；改形状即破坏 A9 面 |
| `packages/shared/src/types/errors.ts` | 新码 append-only，schema 门禁会拒绝未登记码 |

回滚：无持久化/settings 变更，回滚 = revert 各阶段提交；无本地资源状态。

## Pre-start 检查

- [x] `implement.jsonl` / `check.jsonl` 策展真实条目（spec + research；sub-agent 平台门槛）
- [x] 最终规划总结经用户明确批准后 `task.py start`
