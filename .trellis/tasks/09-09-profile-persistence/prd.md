# Student Profile & Persistence (M4)

## Goal

把"学习记录"变成"学习档案"：棋谱库落 SQLite（重启不丢）、批量分析整库棋谱并持久化结果、从分析增量（每手 `winrateLoss`）+ 棋盘几何启发式**纯函数**推导学生弱项画像（EMA 评分 + 证据链接），训练建议由 LLM 教师在对话中基于画像数据给出。这是产品差异化核心（M1 PRD：两个对标项目都没有已验证的画像驱动教练功能）。

## Background（代码证据，2026-09-09 检查）

- **M1 PRD 已定调**：M4 = "Batch-analyse library, surface three weakest areas with evidence links, track improvement, generate training plans"（"generate" 的呈现形态经用户确认为**教师对话式**，不做专用计划 UI）；"SQLite schema, EMA weakness scoring"；头号风险 = 分类可信度——"categories are derived from analysis deltas plus board-geometry heuristics, kept pure and unit-testable. The LLM only *explains* categories, never assigns them — non-determinism in the profile would destroy trust"。
- **数据源就绪**：`winrateLoss` 已在共享分析契约（M2 铺垫）；sweep 层证明 main 可并发跑多位置分析；M3 `analyzeOnce` 提供一次性独立查询先例；benchmark（b6c96，311 v/s 聚合）给出批量预算依据（100 手局 ≈ 32s）。
- **持久化缺口**：library 是内存 `Map`（`library/store.ts`，接口 `GameStore` 稳定）；分析结果为会话内存；`database-guidelines.md` 自 M1 留白。
- **教师集成先例**：M3 工具注册表（`main/llm/agent/tools.ts`）可扩 `get_profile`；`teacher.ts` 明言判定损失归 `profile/weakness`（纯、可测），不是模型的职责。
- **better-sqlite3 风险**：M1 因 native-rebuild 变量刻意推迟；打包链已有 `@electron/rebuild`（M2 日志可见），CI 三平台 + 打包门禁是验证面。
- **无既有 profile 模块**——全新领域，归 `packages/core/src/profile/`（纯逻辑、Electron-free）。

## 用户已确认的范围决策

1. **训练建议形态**：教师对话式——教师经 `get_profile` 工具读画像后在对话中给建议；不做专用训练计划 UI（留待后续里程碑）。
2. **画像数据源**：名字匹配 + 手动覆盖——设置维护"我的名字"列表，对局任一方棋手名匹配（大小写不敏感）即计入画像；手动逐局标记优先于名字推断；职业棋默认不误入。规则为纯函数。

## Requirements

- **R1 SQLite 持久化**：`db/` 模块（WAL、编号事务迁移）；`GameStore` 接口不变、实现换 DB 底座（handlers/tools 零改动）；分析结果按局按手落库；游戏内容变更（contentHash）使旧结果失效；首启空库即新库（M1–M3 从未持久化，无迁移负担）。
- **R2 批量分析**：整库（或"我的棋"子集）排队分析；独立查询命名空间（不劫持用户光标/不与 sweep 冲突）；进度事件可见、可取消、崩溃后按账本续跑；低 visit 预算（sweep 级）+ 有界并发；用户打开棋局进行交互分析时让路（M2 的并发与线程分配先例）。
- **R3 弱项画像（纯）**：`packages/core/src/profile/`——分类器（分析增量 + 几何启发式 → 少量原则性类别）、EMA 时间衰减评分、证据装配（局/手/损失值）；仅从已记录分析推导，无 LLM 参与；"我的棋"判定谓词纯函数。
- **R4 画像呈现 + 教师集成**：三弱项 + 证据链接（点开证据 → 打开对应棋局跳到对应手）+ 改善趋势；`get_profile` 进 M3 工具注册表；教师提示词补"解释类别、引用数字、禁止自行归类"约束；设置增"我的名字"列表。
- **R5 新 IPC 面走全量门禁**：batch/profile 通道 + 事件进 A9 双向元测试（M3 零新增面，M4 恢复新增——元测试会强制覆盖，这是特性不是负担）。

## Acceptance Criteria

- **C1 库持久化**：import → 退出 → 重启，棋谱仍在且可打开（e2e，隔 profile 真实重启）。
- **C2 批量分析**：对含多局的库发起批量：进度事件推进、可取消；崩溃后重启能从账本续跑不重算已完成局（集成，fake 引擎）；结果落库且重启后直接可读（不再重分析）。
- **C3 画像纯度**：分类/评分仅由记录的分析数据 + 规则推导（单测 + 变异锚定"LLM 无法参与"的边界——分类器输入只有分析行与元数据）；EMA 衰减可测（旧局权重低于新局）。
- **C4 "我的棋"判定**：名字匹配 + 手动覆盖的优先级语义（单测 + 变异）；职业棋默认不入画像。
- **C5 弱项呈现与证据**：面板呈现三弱项；点证据打开对应棋局并跳到对应手（e2e）。
- **C6 教师读画像**：教师回答引用画像真实数字（e2e，A2 式数字交叉核对）。
- **C7 门禁**：新通道 A9 元测试全覆盖；纯逻辑（分类器/EMA/判定谓词/账本）变异覆盖；lint/typecheck/test/e2e/format/i18n/licenses/trellis 全绿；构建 + 启动 `out/`。
- **C8 打包与平台**：better-sqlite3 三平台原生构建通过；打包启动门禁照常（引擎面无回退）；CI 三平台绿。

## Out of scope

- 专用训练计划 UI（教师对话式建议已确认；计划面板留待后续里程碑）
- Fox 同步、遥测、macOS 签名（M5）；多模态；画像云同步
- ownership 张量持久化（批量分析不带 ownership——M2 sweep 同例；焦点会话的 ownership 维持会话内存）
- 弱项类别的外部强手验证（M1 风险记录在案；M4 交付原则性小类别集 + 证据链接，校准留待真实使用）

## Open questions

（无——两项范围决策均已确认）
