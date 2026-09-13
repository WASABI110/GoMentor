# M5: Release Milestone（发布里程碑）

## Goal

把 GoMentor 从"功能完整的开发期应用"变成"可发布的产品"：补齐四个 PRD 一致 defer 到 M5 的发布向范围（macOS 引擎层、遥测、自动更新、GPU tier-2、Fox 同步、营销站），以 1.0.0 发布收尾。

M1–M4 交付后用户已能：打谱、KataGo 实时分析、LLM 教师对话、批量分析、持久化棋谱库、学生弱项画像。M5 不增加教学核心功能，解决的是"别人装得上、崩了能查、更得了新、Mac 有引擎"的发布问题。

## Background（代码证据，2026-09-13 检查）

- **四个 PRD 的 Out-of-scope 一致指向**：M1 PRD（遥测接线、apps/web）、M2 PRD（Fox sync、auto-update wiring、code signing M5、telemetry beyond no-op、GPU tier-2/full-offline defer 绑定）、M3 PRD（Fox/遥测 M5）、M4 PRD（Fox 同步、遥测、macOS 签名 M5；多模态与画像云同步不在 M5）。
- **M1 预留的缝全部还在**：`telemetry.ts` no-op stub（closed-union 事件、scalar-only、`enabled` 恒 false）；`update:status` 事件名在 M1 design.md 预留；`electron-updater ^6.3.9` 已在 desktop 依赖里；`settings.telemetryConsent` 已存在；spec `directory-structure.md` 已规划 `integrations/fox/`（"inherently fragile, isolated — own rate limiter, recorded-fixture tests"）。
- **仓库 public**：GitHub Releases 可作为自动更新源（免密拉取）；营销站可挂 GitHub Pages。
- **Fox 协议已核实可移植**（research/fox-protocol.md）：lizzieyzy-next（GPL-3.0，同许可）`GetFoxRequest.java` 含未混淆端点——nickname→uid、分页拉 SGF、chessid 单局，纯 HTTPS GET，无登录。历史版 FoxRequest 端点刻意打码，新版未打码。
- **macOS 引擎可行**（research/macos-engine-tier.md）：无官方二进制，但 KataGo v1.18.1 源码含 METAL（arm64）/OpenCL（Intel）后端；GitHub 现提供 macos-15 arm64 与 macos-13 Intel 免费 runner；KaTrain/brew 有成熟先例。M2 research 已存 ad-hoc 深签知识。
- **tier-1 资产不进 git**：CI 按 manifest 哈希键缓存拉取引擎/权重（architecture.md L348）——macOS 自编译二进制与 tier-2 GPU 后端走同一模式（发 Release asset + fetch 脚本扩展），不污染仓库。

## 用户已确认的范围决策（2026-09-13）

1. **小语种 ja/ko/th/vi 取消**：应用只保留 zh-CN + en。M1 PRD 的 "remaining locales deferred to M5" 就此关闭、不再排期；i18n 门禁维持现状（zh-CN 为作者语言、en 为基准，key 互齐）。营销站同为中英双语。
2. **macOS 不购买 Apple Developer 账号**：交付 CI 自编译引擎（arm64 METAL + Intel OpenCL）+ ad-hoc 深签 + 文档化 Open Anyway 流程；**macOS 自动更新随签名缺席禁用**（菜单项隐藏 + 文档说明）；notarization 不在 M5，但 CI 留输入接缝（secrets 注入点），后续补账号可无损升级。
3. **遥测仅本地落盘，零账号零网络**：`telemetryConsent`（默认关）继续作为收集闸门；同意后 `crashReporter.start({ uploadToServer: false })` 只写本地 minidump，事件 closed-union 追加本地滚动日志；菜单加 "Reveal crashes"。**任何状态下无任何网络调用**——比 M1 "consent 前不联网"的承诺更强，A10 式验证照旧（检查 + 断言双管）。
4. **GPU tier-2 范围**：官方 CUDA 构建（win/linux）为主 + OpenCL 通用回退（AMD/Intel 核显可用）；TensorRT 跳过（边际收益小、依赖重）；与 tier-1 同版 v1.18.1。
5. **Fox 同步范围**：仅公开棋谱（nickname→uid→分页拉取）；私有谱（需登录，TencentKifuDownload 路径）不做；readboard 不做。
6. **多模态、画像云同步、训练计划 UI**：维持未排期，不进 M5。
7. **营销站构建不部署**（2026-09-13，出门前批量决策）：站点代码与构建测试照常交付，但**不激活任何对外部署**——无 Pages/外网发布；交付形态为可本地（局域网）服务的静态构建（`astro build` + preview 冒烟）。上线与否等用户回来审过内容再定。
8. **执行应急政策 = 全自主降级**：遇计划外情况（端点不可达、编译失败、依赖破坏、命名差异），按"保进度降级 + 完整记录"处理（例：Fox 不可达→fixture-only 交付并标 live 验证 pending；METAL 失败→Eigen 回退；CUDA 命名不符→按实际调整），所有降级逐条记入 final-gate 残余风险供用户回来过目。
9. **M6 方向已预定 = 对弈模式**：人机对弈（GTP 路径、让子、计时），对局自动入画像管线。M5 归档后立新任务，不再需要方向决策。

## Requirements

- **R1 macOS 引擎层**：CI 自编译 KataGo v1.18.1（macos-15 arm64 METAL / macos-13 Intel OpenCL）+ ad-hoc 深签 + 探针验证；manifest `EngineTarget` 扩展 `darwin-arm64`/`darwin-x64`；fetch/locate/probe 链路三平台对齐；macOS 的 EngineStatus 从永久 `unavailable` 变为真实状态；打包门禁扩展到 mac。
- **R2 遥测本地接线**：consent 闸门 → crashReporter 本地落盘 + 事件 JSONL 滚动日志；"Reveal crashes" 菜单项；无网络断言进 CI。
- **R3 自动更新**：electron-updater + GitHub Releases provider；`update:status` 事件进 A9 元测试面；启动时检查 + 菜单手动检查；macOS（未签名）禁用并说明；CI 打 `v*` tag 构建三平台并发布 Release（**需用户在 repo secrets 配置 GH_TOKEN——用户行动项**）。
- **R4 GPU tier-2 + 完整离线包**：manifest tier-2 资产（CUDA win/linux + OpenCL）；后端探测顺序 cuda→opencl→eigen（逐个试启动答一题，胜者持久化进 settings）；设置页按需下载带进度；CI 产出完整离线包 asset。
- **R5 Fox 同步**：`main/integrations/fox/`（spec 已规划位置）——纯协议层（注入 fetch、可录 fixture）+ 服务层（限速器 1req/2s、缓存）+ IPC 面（A9 元测试）；棋谱入 library 走既有 store；Fox 挂掉不影响任何核心流程（spec 原文要求）。
- **R6 营销站（本地构建，不对外部署）**：apps/web Astro 静态站（zh-CN + en）：产品页/下载页（→ GitHub Releases 外链）/文档（快速上手、隐私、遥测说明）/GPL 许可页；`astro build` 绿 + preview 本地冒烟（局域网可服务）；外链存活探测测试（离线跳过，katago-provenance 同例）；**无部署 workflow**（决策 7）。

## Acceptance Criteria

- **C1 遥测**：未 consent 时 crashReporter 未启动、无文件写入；consent 后崩溃产生本地 minidump + 事件日志只含 scalar 字段（单测 + 变异 + 无网络断言）。
- **C2 自动更新**：`update:status` 通道 A9 覆盖；对着脚本化 feed 服务器的检查/下载/重启安装流程（集成）；打包产物含 latest.yml；macOS 未签名禁用状态可测。
- **C3 macOS 引擎**：CI 两 arch 编译绿；`codesign -dv` 验证 ad-hoc 签名；macos runner 上打包启动 + 引擎探针 e2e（EngineStatus 走出 `unavailable`）；win/linux 零回归。
- **C4 GPU tier-2**：CUDA/OpenCL 拉取校验（TOFU sidecar 同例）；后端探测顺序单测 + 变异；按需下载进度 e2e（假后端）；完整离线包 CI asset 产出。
- **C5 Fox**：协议层对录制的 lizzieyzy 派生 fixture 全绿（端点、分页、payload 规范化）；限速器可测；脚本化 HTTP 下 nickname→入库 e2e；Fox 端点失败时核心流程无感（故障注入）。
- **C6 营销站**：astro build 绿；preview 本地冒烟（起服务、首页/下载页 200、关键断言）；下载链接指向真实 Release（存活探测，离线跳过）；确认仓库内无激活的对外部署路径。
- **C7 终局门禁**：lint/typecheck/test/e2e/format/i18n/licenses/trellis 全绿；三平台打包 + 启动门禁；版本 1.0.0；C1–C6 逐条 gomentor-verify 判定记录 final-gate.md。

## Out of scope

- **小语种 ja/ko/th/vi**（用户 2026-09-13 明确取消，不再排期）
- **营销站对外部署**（Pages/自定义域名/公网托管——用户明确"局域网内运行，不做外网部署"）
- Apple 公证/付费签名（接缝保留）；macOS 自动更新（随签名缺席禁用）
- Fox 私有谱登录同步；readboard 实体棋盘桥
- TensorRT 后端；多模态 LLM；画像云同步；训练计划 UI
- Sentry 等任何网络遥测（用户已决策：仅本地）

## Open questions

（无——三项资源/范围决策已确认；唯一用户行动项：R3 的 GH_TOKEN secret，不阻塞规划批准，阻塞最终发布）
