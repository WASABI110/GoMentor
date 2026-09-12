# Implement: Student Profile & Persistence (M4)

执行计划。需求（R1–R5）、验收（C1–C8）、设计决策见 `prd.md` / `design.md`。

M1–M3 惯例沿用：每阶段末尾 `trellis-check` → `gomentor-verify`（只读）→ 主会话处置 FAIL 项。每道门禁构建并启动 `out/`。新纯逻辑随行变异覆盖。

## 标准验证命令（每阶段门禁）

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm check:i18n && pnpm check:licenses && pnpm check:trellis && pnpm format:check
pnpm e2e
pnpm build                                   # + 启动 out/
pnpm exec tsx scripts/mutate-profile.mts     # Stage 2 新建
pnpm exec tsx scripts/mutate-llm.mts         # M3 面 + get_profile 锚点（Stage 4）
pnpm exec tsx scripts/mutate-katago.mts      # batch 层若触碰 katago 面（Stage 2）
pnpm exec tsx apps/desktop/scripts/sqlite-abi.ts node   # 原生绑定探测（真实自检；`pnpm rebuild` 在 neverBuiltDependencies 下是 no-op，已验证不算数——见 database-guidelines.md）
```

## Stage 1 — SQLite 底座与库持久化（R1；C1）

- [x] `main/db/`：连接（WAL、foreign_keys）、`migrations/0001_init.sql`（games/analysis/batch_state 三表）、事务迁移器、`paths.ts` 增 `dbFile()`；启动序（ready 后、handler 前）
- [x] `library/store.ts` 换 DB 底座：`GameStore` 接口逐方法不变；`list()` 最近优先 = `imported_at DESC`；`is_mine_override` 列暴露最小读写面
- [x] settings 增 `profile.playerNames`（zod default `[]`，向后兼容加载）
- [x] 测试：真实 DB 文件（temp dir）——迁移幂等/事务性、store 全方法行为等价（对照既有内存测试）、contentHash 重导入语义、损坏 DB 的可读错误（非崩溃）
- [x] e2e：import → 退出 → 重启（同 profile）→ 棋谱在且可打开（C1）

**门禁证据**：`out/` 构建 + 启动；既有 e2e 全绿（store 底座替换对它们透明——这是接口不变性的直接证明）。验收：C1。

## Stage 2 — 批量分析与结果持久化（R2；C2）

- [x] `main/katago/batch.ts`：`batch:<n>` 命名空间、100 visits/手、无 ownership、有界并发、账本（batch_state 表）驱动的排队/续跑
- [x] 让路：focus 会话激活 → 停发新查询、在飞自然完成、恢复
- [x] 失效：contentHash 变更清该局 analysis + 账本项
- [x] IPC：`batch:start`（scope: all|mine）/`batch:cancel`/`batch:status`（invoke）+ `batch:progress` 事件；A9 元测试全覆盖（M4 恢复新增面——双向 + 非空虚）
- [x] 集成（fake 引擎）：多局库进度推进、取消即停、崩溃重启续跑不重算、让路时序、结果行落库与重启直读
- [x] `scripts/mutate-profile.mts` 建立（基线门禁 + 非零退出，沿用两 harness 的统一惯例）——首批锚点：账本状态机、批量预算/并发边界

**门禁证据**：集成全绿 + e2e 批量进度（fake 引擎确定性）。验收：C2、C7（面覆盖）。

## Stage 3 — 画像纯核心（R3；C3/C4）

- [ ] `core/profile/mine.ts`：判定谓词（名字匹配大小写不敏感任一方 + override 三态优先）
- [ ] `core/profile/categories.ts`：四类别分类器（阈值常量集中）+ 几何推导（棋盘重放取接触距离/候选距离——复用 core 既有 board 模块，不复制）
- [ ] `core/profile/profile.ts`：EMA（半衰期常量）+ 三弱项 + 证据装配
- [ ] 单测 + 变异：阈值边界、优先级、半衰期、"LLM 无法参与"的输入面（分类器签名只吃分析行与几何——类型层面锁死）
- [ ] `ipc/profile.handlers.ts` + `profile:get`（A9 覆盖）

**门禁证据**：变异全捕获；纯核毫秒级（benchmark 注释记录量级）。验收：C3、C4。

## Stage 4 — 呈现、教师集成、最终门禁（R4；C5–C8）

- [ ] ProfileSection：三弱项卡（类别 + 趋势 + score）+ 证据行点击 → 打开棋局跳手；批量按钮与进度；设置面板"我的名字"编辑
- [ ] `get_profile` 工具（M3 注册表扩展，≤3 证据/类别精简 JSON）；教师提示词补"只引用不归类"约束；`mutate-llm.mts` 增锚点
- [ ] i18n：`profile.json` 命名空间（zh-CN authored + en 实译）；类别名键
- [ ] e2e：C5 证据跳转、C6 教师引用画像数字（A2 式交叉核对）
- [ ] 文档：`architecture.md`（SQLite 段落改写"still no SQLite"、批量层、画像）、`ipc-contract.md`（新通道）；`database-guidelines.md` 填实（M1 留白兑现）；spec 沉淀教训
- [ ] 最终门禁：C1–C8 逐条 `gomentor-verify` 只读判定记录到 `final-gate.md`；CI 三平台绿（含原生模块构建 + 打包门禁）

## 风险文件 / 回滚点

| 文件 | 为什么小心 |
|---|---|
| `apps/desktop/src/main/library/store.ts` | 底座替换；接口漂移会静默改变 handlers/tools 行为——接口等价测试是承重墙 |
| `apps/desktop/src/main/katago/service.ts` | batch 复用一次性查询通道；不得触碰 desired/sweep/光标（M2 B3 承诺第三次适用） |
| `packages/shared/src/ipc.ts` | M4 恢复新增面；A9 元测试会强制覆盖——新通道无测试会红（特性） |
| `packages/shared/src/types/settings.ts` | `playerNames` 必须带 default，旧 settings 文件加载即兼容 |
| `apps/desktop/package.json` | better-sqlite3 引入原生依赖；锁版本，rebuild 链是 C8 的验证面 |

回滚：DB 文件是 userData 下的运行时产物（不入库）；代码回滚 = revert 提交序列；删除 DB 文件即回空库。

## Pre-start 检查

- [ ] `implement.jsonl` / `check.jsonl` 策展真实条目
- [ ] 最终规划总结经用户明确批准后 `task.py start`
