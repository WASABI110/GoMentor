# LLM Agent Loop (M3)

## Goal

让 AI 老师从"单轮问答"升级为"会使用工具的多步代理"：模型在回答过程中可以调用只读工具（查局面、查引擎分析、查棋谱库），用真实数据回答"这手棋为什么不好""换个下法会怎样""帮我找某棋手的对局"这类需要多次取数的问题。这是产品既定方向（M1 PRD D9：agent loop 属于 main 进程；对标 GoAgent 的 "AI-agent learning workbench" 定位），也是 M4 学生画像/教练层的直接前置。

## Background（代码证据，2026-09-07 检查）

- **Wire 层已就绪**（M1 铺垫）：`packages/core/src/llm/provider.ts` 的 `ChatRequest.tools` 已定义；`openai-compatible.ts` 已解析分片到达的 `tool_calls` delta（`#toolCallsByIndex` 累积）并映射 `finish_reason: tool_calls`。
- **类型层已就绪**：`packages/shared/src/types/chat.ts` —— `ChatMessage` 支持 `role: 'tool'`、`toolCalls`、`toolResult`；`ChatChunk` 判别联合含 `tool_call`/`tool_result`；`RunStatus` 含 `awaiting_tool`；`chatContextSchema`（gameId + moveNumber）已存在。
- **主进程聊天流已就绪**：`apps/desktop/src/main/llm/service.ts` 持有 runId 语义、`llm:delta` 事件扇出、`cancel(runId)`（AbortSignal 贯穿 provider）。
- **提示词是纯函数**：`packages/core/src/llm/prompts/teacher.ts`（locale 参数化；"分析数字只引用、禁止编造"的产品约束已写进系统提示词）。
- **能力探测已就绪**：`probeCapabilities` 实测各模型 tool 支持（按模型而非按服务器），`toolsSupported: boolean | null` 三态（M1 铺垫：M3 依赖"无工具"与"未知"的区分来决定降级或先探测）。
- **工具数据源**：engine service（`setGame`/`setCursor` 绑定用户光标会话；M2 sweep 层证明 main 可并发发起独立查询）；library store 内存 Map（`get(id)` / `list(): GameSummary`），`GameMeta` 含棋手/段位/日期/赛事/结果，可支撑检索。
- **既定边界**（M1 D9）：agent loop 在 main 进程——工具需要引擎/库访问；渲染层重载不得孤儿化运行中的多步执行。

## Requirements

- **R1 主进程 agent loop**：模型返回 tool_call → zod 校验参数 → 执行工具 → 结果回传模型 → 继续生成，循环直到 `finish_reason: stop` 或触达步数上限。复用现有 `llm:sendMessage` / `llm:delta` / `llm:cancel` IPC 面，runId 语义不变。
- **R2 MVP 工具集（用户已确认：三件套，全部只读）**：
  - `get_position(gameId?, moveNumber)` — 返回指定手数的局面与着法序列（缺省 gameId 取当前打开的棋局）；
  - `get_analysis(gameId?, moveNumber)` — 返回该位置的 KataGo 分析（胜率/候选点/归属摘要），**不得劫持用户光标的分析会话**（独立查询，复用 M2 的独立查询机制）；
  - `search_library(player?, event?, date?)` — 按元数据子串检索棋谱库，返回摘要列表。
- **R3 无工具降级**：`toolsSupported === false` 时自动回退到现有单轮教师行为（不发 `tools` 参数）；`null`（未探测）时先探测再决策。降级对用户不可见地发生（教师面板正常回答）。
- **R4 生命周期安全**：cancel 终止整个 run（含正在执行的工具与底层流）；渲染层重载不孤儿化多步执行（run 归 main 所有）；步数硬上限（设计定为 8，超限以明确错误结束，应用保持可用）。
- **R5 UI 透明度**：工具调用过程在教师面板可见——每个工具调用显示为步骤（名称 + 参数摘要 + 结果摘要），渲染层消费现有 `tool_call` / `tool_result` chunk 类型。

## Acceptance Criteria

- **A1 工具闭环（真实路径）**：在工具支持的 provider 上，问"第 N 手为什么不好"，模型调用 `get_analysis` 并基于返回的真实数字作答；教师面板显示该工具步骤。e2e 用受控 fake LLM（返回脚本化 tool_calls）走真实 main 循环验证。
- **A2 检索工具**：问"帮我找 XYZ 的棋"，模型调用 `search_library` 并引用返回的对局摘要作答。
- **A3 降级不变**：`toolsSupported === false` 时，教师行为与 M2 完全一致（wire 层无 `tools` 参数）；单轮路径的既有测试全部保持绿。
- **A4 上限与可用性**：脚本化模型无限要求工具时，run 在上限处结束并给出可翻译的明确错误；应用其余功能不受影响。
- **A5 取消与重载**：cancel 立即终止（流中断 + 工具执行中断）；渲染层重载后进行中的 run 不孤儿化（main 继续持有或终止，重启后状态一致）。
- **A6 契约与变异**：所有新 IPC 通道/事件有 A9 式双向元测试覆盖；新纯逻辑（工具参数 schema、循环步进、检索过滤）有变异测试。
- **A7 平台门禁不回退**：三平台 CI 绿，打包启动门禁照常执行（引擎行为不被 M3 改动破坏）。

## Out of scope

- 写类工具（导出/修改 SGF、写棋谱库）——MVP 只读，导出工具明确推迟（用户已确认）
- Fox 同步（M5）、学生画像与弱点分析（M4）、遥测（M5）
- 多模态输入（棋盘截图）、并行工具调用（单步一个工具调用批次内串行执行即可）
- 本地知识库检索（GoAgent 的 local KB 方向，未排期）

## Open questions

（无——工具集范围已确认，其余设计决策见 design.md）
