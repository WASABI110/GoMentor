# Design: Student Profile & Persistence (M4)

需求与验收见 `prd.md`。本文记录技术设计与权衡。

## 架构总览

```
renderer                          main
┌──────────────────┐   invoke   ┌─────────────────────────────────────┐
│ LibraryPanel     │──────────►│ ipc/library.handlers.ts（不变）       │
│ ProfileSection   │◄──────────│ ipc/profile.handlers.ts  ← 新        │
│ BatchControls    │  events   │ ipc/batch.handlers.ts    ← 新        │
└──────────────────┘           │   ├─ library/store.ts（接口不变，     │
                               │   │   DB 底座）                       │
                               │   ├─ db/  ← 新：连接/WAL/迁移          │
                               │   ├─ katago/batch.ts ← 新：批量调度    │
                               │   │   （batch:<n> 命名空间 + 账本）     │
                               │   └─ llm/agent/tools.ts +get_profile  │
                               │ packages/core/src/profile/ ← 新（纯）  │
                               │   分类器 / EMA / 证据装配 / 我的棋判定  │
                               └─────────────────────────────────────┘
```

## 1. `main/db/` — SQLite 底座

- **better-sqlite3，同步 API**：main 是唯一持库者，同步调用契合 Electron main 的请求-响应风格（无连接池、无 async 陷阱）；WAL 模式；`foreign_keys` 开。
- **迁移**：`migrations/0001_init.sql` 起编号，事务内逐个应用，`user_version` 记录位点；启动时在 `app.ready` 后、handler 注册前跑。迁移只增不改（既有列不重命名不删除——append-only 同错误码哲学）。
- **表**：
  - `games(id TEXT PK, content_hash, sgf BLOB, meta…, is_mine_override INT NULL, imported_at)`——`StoredGame` 的直接落库；`collection`（序列化用原始 SGF）就是 sgf 列本身。
  - `analysis(game_id, move_number, player, winrate, score_lead, winrate_loss, top_candidate_coord, top_candidate_winrate, PRIMARY KEY(game_id, move_number))`——批量产物为紧凑行，非全量 JSON；candidates/ownership 不落库（R5 out of scope）。
  - `batch_state(game_id PK, status, updated_at)`——账本：pending/done/failed。
- **`GameStore` 接口不变**：`put/get/has/list/delete/clear` 换 DB 实现，`list()` 的"最近优先"用 `imported_at DESC`；handlers、M3 工具、e2e 选择器零改动——持久化是底座替换，不是功能面变化。
- **原生模块风险**：`electron-builder` 的 `@electron/rebuild` 已在链上（M2 打包日志）；CI 三平台 + 打包门禁是验证面；`pnpm rebuild` 语义写入 implement.md 的门禁命令。

## 2. `main/katago/batch.ts` — 批量调度

- **独立命名空间 `batch:<n>`**：与 `focus:`/`sweep:`/`agent:` 并列的第四层；直接走 `analyzeOnce` 式的一次性查询通道（probe 先例第三次复用），不触碰 desired/sweep/光标去抖。
- **预算**：每手 100 visits（sweep 级）、无 ownership、并发 = `analysisThreadSplit` 已分配给并行位置的份额（复用线程模型，不新增进程/线程配置）。
- **让路（CPU 争用）**：用户打开棋局（focus 会话激活）时批量暂停发新查询、在飞查询自然完成；focus 清空后恢复。信号取自 engine service 的会话状态，不是新配置。
- **可取消/可恢复**：账本即 `batch_state` 表——每局 done 即提交；取消 = 停发新查询；崩溃后重启按表续跑（pending 的局重跑，done 的不重算——C2 的断言点）。
- **失效**：`games.content_hash` 变更（同 id 重导入不同内容）时删除该局 analysis 行与账本项。

## 3. `packages/core/src/profile/` — 纯画像核心

三个模块，全部纯函数 + 变异覆盖：

- **`mine.ts`**——我的棋判定：`(summary, playerNames, override?) => boolean`。名字匹配大小写不敏感、匹配任一方；`override` 三态（true/false/未设）优先于名字。变异锚定优先级与大小写。
- **`categories.ts`**——分类器：输入一局的逐手分析行（move_number, player, winrate_loss, top_candidate…）+ 几何信息（该手与上一手/接触石的距离——由 core 的棋盘重放推导），输出每手 0..n 个类别标记。**类别集（MVP，原则性小集）**：
  1. `opening-direction`（前 25 手内的重大损失 ≥5% winrate）
  2. `middlegame-fighting`（中盘接触战区域的损失：落点距最近对方棋子 ≤2 线）
  3. `endgame-precision`（150 手后的小额累计损失 ≥3×1.5%）
  4. `whole-board-blindspot`（损失手的候选点与实际落点距离 ≥5 线——"没看到另一边"）
  阈值常量集中定义、进 benchmark 记录校准依据；类别可扩展（append-only）。
- **`profile.ts`**——EMA + 装配：按局的类别损失汇总 → 以 `imported_at`（或棋谱 date）为时间轴的 EMA（半衰期常量，如 10 局）→ 每类别 `{score, trend, evidence[]}`；取分最高的三个为弱项；evidence 含 gameId/moveNumber/loss（C5 的跳转参数）。
- **快照策略**：**不存派生快照**——画像从 analysis 行按需推导（纯函数毫秒级）；无失效问题。若未来量大变慢再加缓存（YAGNI，记录于此）。

## 4. 教师集成

- `get_profile` 工具：返回三弱项 + 各自 score/trend/代表证据（≤3 条/类别，精简 JSON 同 M3 风格）；教师提示词增一条："弱点分类与数字来自学生画像工具，只引用与解释，禁止自行发明类别"（teacher.ts 既有"数字只引用"约束的同类扩展）。
- M3 降级不变：无工具 provider 拿不到画像——画像面板本身不依赖 LLM。

## 5. 渲染层

- **ProfileSection**（Library 面板下或独立区）：三弱项卡（类别名 + 趋势箭头 + score）+ 证据列表（"第 37 手 −7.2%"，点击 → `gameStore.open` + seek——复用既有跳转路径）+ "分析我的棋库"批量按钮与进度。
- **设置**：`profile.playerNames: string[]`（settings schema 增量，zod default `[]`）。
- i18n：zh-CN authored + en 实译；类别名进 `profile.json` 命名空间。

## 权衡记录

| 决策 | 备选 | 取舍 |
|---|---|---|
| better-sqlite3 同步 API | sql.js / 异步驱动 | main 单持库者，同步无连接池陷阱；异步包装只会把事务边界搞糊 |
| `GameStore` 接口不动换底座 | 新 repository 面 | handlers/tools/e2e 零改动，持久化不改功能面 |
| 画像按需推导不落快照 | 快照表 | 纯函数毫秒级；快照引入失效问题（分析更新/重导） |
| batch 复用 analyzeOnce 式通道 | 复用 sweep 层 | sweep 绑定"当前打开的棋局"语义；批量对象是全库，独立命名空间更直白，probe 先例已两次复用 |
| focus 激活时批量让路 | 恒优先级/配置 | B3 延迟承诺（用户光标分析）优先；批量本就异步慢任务 |
| 类别 4 个起步 | 大而全分类学 | 分类可信度是头号风险；小集合 + 证据链接 + append-only 扩展比一次性大分类学可信 |

## 兼容与回滚

- settings 增量（`profile.playerNames`，default `[]`）——旧 settings 文件加载即得默认，无迁移。
- DB 文件落在 `userData`（paths.ts 增 `dbFile()`）；删除文件 = 回到空库（灾难恢复路径简单）。
- 回滚 = revert 提交序列；M3 的会话内行为不依赖 DB（store 底座替换对它们透明）。

## 测试策略概要（细节在 implement.md）

- 纯核变异：分类器阈值/边界、EMA 半衰期、我的棋优先级、账本状态机。
- 集成：真实 DB 文件（temp dir）跑迁移 + store 读写 + 账本续跑；fake 引擎跑批量全链路（进度/取消/让路/崩溃恢复）。
- e2e：C1 重启持久化、C5 证据跳转、C6 教师引用画像数字（A2 式交叉核对）；批量进度对 fake 引擎确定性推进。
- 平台：C8 的原生模块构建在 CI 三平台 + 打包门禁验证（本地 Windows 必过）。
