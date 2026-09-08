# Design: LLM Agent Loop (M3)

需求与验收见 `prd.md`。本文记录技术设计与权衡。

## 架构总览

```
renderer (TeacherPanel)          main
┌────────────────────┐    ┌──────────────────────────────────────┐
│ 消息流 + 工具步骤卡 │◄───│ llm:delta (text | tool_call | tool_result │
└────────────────────┘    │           | done) — 通道不变            │
        │ llm:sendMessage │ ┌────────────────────────────────────┐ │
        ▼                 │ │ llm/service.ts (runId, cancel, fanout)│
└────────────────────┘    │ │   └─ agent/runner.ts  ← 新：循环状态机 │
   IPC 不变               │ │        └─ agent/tools.ts ← 新：注册表  │
                          │ │             ├─ get_position           │
                          │ │             ├─ get_analysis → service │
                          │ │             │     的一次性查询通道       │
                          │ │             └─ search_library → store │
                          └──────────────────────────────────────┘
```

核心原则：**IPC 面零新增**。runId 语义、`llm:delta` 判别联合、`llm:cancel` 全部沿用；agent 循环对渲染层表现为"带工具步骤的流"。这是 M1 类型铺垫（`ChatChunk` 已含 tool chunk、`RunStatus` 已含 `awaiting_tool`）的直接兑现。

## 组件与边界

### 1. `main/llm/agent/runner.ts` — 循环状态机（纯逻辑核心 + 薄 IO 壳）

与 M2 的模式一致：决策核心纯函数化（`planNextStep(history, finished, stepCount)` 之类），IO（provider 调用、工具执行）走注入 seam，变异测试只打纯核。

- 输入：用户消息 + 历史 + ChatContext（gameId/moveNumber，渲染层已发送）。
- 循环：`chat(messages, tools)` → 消费 chunk 流（文本直通扇出；tool_call 增量累积——`openai-compatible.ts` 已按 index 碎片累积，runner 收 `done(finishReason: tool_calls)` 后得到完整调用集）→ zod 校验参数 → 逐个执行 → 追加 `role:'tool'` 消息 → 下一轮。
- 上限：8 步（`MAX_AGENT_STEPS` 常量）。超限 runner 抛 `AppError('LLM_AGENT_LIMIT')`，`service.ts` 捕获后以 `llm:error` 事件收尾——与本节初稿写的 "`done(finishReason: 'error')` + 本地生成系统消息" 是有意偏离：`done` chunk 不携带错误载荷，要承载就得新增 chunk 种类，直接违反"IPC 面零新增"；且错误由渲染层按 `code` 经 `errors` 命名空间翻译本就是 error-handling spec 的既定路径（该码进 `errors.ts` + i18n en/zh-CN）。
- 取消：现有 `AbortSignal` 贯穿——流中断时循环退出；工具执行体接收同一 signal（引擎查询可中断、库过滤可检查 signal）。
- 重载安全：run 状态只存在于 main（现状即如此，渲染层仅凭 runId 关联）；渲染层重载后重新 `llm:getState` 类通道？——不新增：现有行为已约定 run 事件按 runId 扇出、重载丢事件不孤儿化进程，M3 保持同一约定（重载后教师面板显示"该回答已丢失"级别的现状语义，不升级为需求）。

### 2. `main/llm/agent/tools.ts` — 工具注册表

每个工具：`{ name, description, parametersJsonSchema, zodSchema, execute(args, ctx, signal) }`。`ToolSchema`（wire 层）从注册表派生，单一事实源。参数校验失败返回 `isError: true` 的 toolResult（模型可自纠），不中断 run。

- **get_position**：gameId 缺省取 ChatContext.gameId（再缺省报错）；moveNumber 边界校验（0..moves.length，含 setup 石）。数据从 library store `get(id)` 取，返回精简 JSON（棋手/手数/该手着法/最近几手），**不返回全谱 SGF**（省 token）。
- **get_analysis**：见下节。返回 winrate / top 候选（coord+winrate+scoreLead+pv）/ ownership 摘要，引用 `perspective.ts` 归一化后的契约形状——教师提示词"数字只引用"的约束原样适用。
- **search_library**：`store.list()` 上按 blackName/whiteName/event/date 子串过滤（大小写不敏感），返回 ≤10 条摘要（id/棋手/日期/赛事/结果）。纯过滤函数单独导出，变异覆盖。

### 3. 引擎独立查询通道 — 不劫持用户光标（design 关键点）

M2 的 `service.setGame/setCursor` 绑定用户光标会话（焦点查询终止-被取代）。agent 的 `get_analysis` 必须独立：

- 复用 probe 的先例：service 已有一次性的独立查询机制（`PROBE_ID` 通道）。新增 `analyzeOnce(game, moveNumber, visits)`：用自己的 id 前缀（`agent:<n>`）发独立查询，await 完整结果，不触碰 desired/sweep 状态，不参与光标去抖。
- 与用户会话并发的代价已由 M2 验证过（sweep 与 focus 并发；CPU 线程预算由 `analysisThreadSplit` 分配）。agent 查询用小 visit 预算（固定 128，工具结果够教师引用即可），避免与用户分析争抢延迟。
- 引擎不可用（`unavailable`/`failed`）时工具返回 `isError: true` + 可读原因，模型据此告知用户——不是 crash 路径。

### 4. 降级决策（R3）

`send()` 入口处：`capabilities.toolsSupported` 三态——
- `true` → 带工具启动 agent 循环；
- `false` → 单轮（不发 `tools`）。单轮不是另一条代码路径：由同一个 `runAgentLoop` 承载（无 toolContext，收到 `tool_calls` 也按结束处理），循环对降级 run 退化为 M2 的单轮直通——"降级路径 wire 逐字节一致"由此靠构造成立，而非靠两份实现保持同步；core 编码器、集成层 `ChatRequest`、e2e 收到的 HTTP body 三层断言请求不含 `tools`。
- `null` → 先 `probeCapabilities()`（结果缓存于 provider，M1 已实现探测与缓存），再按结果分流。探测失败的兜底 = 视为 false（宁可降级不可死锁）。附带后果：全新 provider 的第一次 send 先探测后作答，HTTP 层面是两个请求——`smoke.spec` 的请求断言因此从"单个含 prompt 的请求"改为有序对（第一个是探测，第二个才载 prompt 且不含 `tools`；探测消失或探测顶替真实回合，两者都应在此失败）。

### 5. 渲染层（R5）

`TeacherPanel` 消息流中，`tool_call` chunk 渲染为步骤行（工具名 + 参数摘要），`tool_result` 到达时填充结果摘要（前 ~120 字符，可展开）。复用现有消息列表虚拟结构，不新增面板。i18n：`teacher.json` 增工具步骤相关键（zh-CN + en 实译）。

## 权衡记录

| 决策 | 备选 | 取舍 |
|---|---|---|
| IPC 面零新增，工具步骤走 `llm:delta` | 新开 `llm:tool` 事件 | 判别联合已存在，新事件=两套关联语义；零新增让 A9 元测试面不变 |
| 上限 8 步、固定常量 | 用户可配 | MVP 无配置面压力；常量 + 变异锚点，M4 若需要再进 settings |
| agent 查询固定 128 visits | 复用用户 maxVisits 设置 | 教师引用不需要 500 遍；小预算保住用户光标分析的延迟（B3 承诺） |
| 参数校验失败→isError 结果回给模型 | 直接终止 run | 模型自纠一次成功则 run 存活；这是 agent 循环的常规语义 |
| 工具串行执行（单轮内） | Promise.all 并行 | 模型一次多工具调用时并行会放大引擎争抢；MVP 串行，上限 8 步本身限流 |

## 兼容与回滚

- 无持久化 schema 变更、无 settings 变更——回滚 = revert 单个提交序列。
- `errors.ts` 新增 `LLM_AGENT_LIMIT` 一个码（append-only，符合既有错误码门禁）。
- 单轮教师路径（A3）保持逐字节不变：`tools` 参数在降级路径完全不出现。

## 测试策略概要（细节在 implement.md）

- 纯核变异：循环步进/上限、检索过滤、工具参数 zod 边界。
- 集成：fake LLM（脚本化 tool_calls 序列——现有 fake-katago 同款思路的 LLM 版）驱动真实 runner：闭环、上限、取消、降级、参数自纠。
- e2e：`GOMENTOR_LLM_FAKE` 式注入（env seam，模拟 M2 的 `GOMENTOR_KATAGO_BINARY` 模式），教师面板可见工具步骤；引擎用 M2 的 fake analysis child。
- 门禁：A9 元测试（IPC 未新增，跑既有面确认不回退）、三平台 CI + 打包门禁。
