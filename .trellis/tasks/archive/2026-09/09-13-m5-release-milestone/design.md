# Design: M5 Release Milestone

技术设计。需求编号 R1–R6、设计决策编号 D1–D6 引用 `prd.md`。范围决策（小语种取消 / macOS 不公证 / 遥测本地 / CUDA+OpenCL / Fox 仅公开谱）见 prd.md"用户已确认的范围决策"，本文件不再重复论证。

## 总体形状

六个 Stage 各自独立可交付、独立可门禁，顺序按"CI 迭代成本前置"排：S1 macOS 引擎（CI 最长迭代环，最先启动）→ S2 遥测 → S3 自动更新 → S4 GPU tier-2 → S5 Fox → S6 营销站 → 终局门禁。每个 Stage 结束即提交、CI 监控至绿，再进下一个（M2–M4 既定节奏）。

所有新 IPC 面走 A9 双向元测试；所有可纯逻辑进 `packages/core`（Electron-free，lint 强制）；所有新外部资产进 manifest/TOFU sidecar 链（M2 既定，不重造）。

## D1 macOS 引擎层（R1）

- **manifest 扩展**：`EngineTarget` 增 `'darwin-arm64' | 'darwin-x64'`；新增 `engine.sourceBuilds` 段（区别于 release assets 段）——`{ ref: 'v1.18.1', backend: 'METAL' | 'OPENCL', cmakeFlags, asset: 'katago-darwin-<arch>-v1.18.1.tar.gz' }`，sha256 走同一 TOFU sidecar（asset id `engine:darwin-arm64` 等）。
- **CI**：新 workflow（path 过滤：仅 engine 输入变更时跑）：
  - `macos-15`（arm64）`cmake -DUSE_BACKEND=METAL`；`macos-13`（Intel）`-DUSE_BACKEND=OPENCL`；依赖走 brew（M2 research/bundled-binary-packaging.md 已有知识回填）；ccache 按 `katago-manifest.ts` 哈希键缓存（复用 tier-1 缓存模式）。
  - 产物 `codesign --deep -s -`（ad-hoc 深签，KaTrain 先例：Apple Silicon 子进程不签会被杀），随后 `./katago version` 探针必须应答。
  - 发布：上传为 Release asset（`katago-darwin-*`），**不进 git**（tier-1 同样不进，CI 缓存拉取）。
- **运行时**：`locate.ts` 增 darwin 资源目录解析；`currentEngineTarget()` 三平台返回非 null；`EngineStatus` 语义不变（macOS 从永久 `unavailable` 变为真实探测——M1 不变式"引擎缺席时其余功能照常"保持，因为缺席仍会发生：未 fetch 的开发检出等）。
- **打包门禁**：electron-builder mac 产物启动 + 探针 e2e 在 macos runner 上跑（win/linux 打包门禁同例）。
- **notarization 接缝**：workflow 接受可选 secrets（`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` 等），未配置时跳过并输出说明——补账号后无需改代码。

## D2 遥测本地接线（R2）

- `createTelemetry()` 从"丢弃"改为两实现：`createNoopTelemetry()`（测试与未 consent 时用）/ `createLocalTelemetry({ crashDumpsDir, logPath, consented })`。
- consent=true：`crashReporter.start({ companyName: 'GoMentor', productName, uploadToServer: false, ignoreSystemCrashHandler: true })`——minidump 落 crashDumps 目录，**Electron 不上传**（uploadToServer:false 是硬保证）；`track()` 事件（closed-union 不变）append 到 `telemetry.jsonl`（滚动：7 天/1MB，先到先滚）。
- 菜单 "Reveal crashes"（zh-CN/en 文案）：`shell.openPath(crashDumpsDir)`；未 consent 时菜单项存在但点开提示未开启（状态可见，不是隐藏）。
- **不变式测试**：(a) 任何状态下无网络——`session.defaultSession.webRequest` 计数断言零请求（A10 先例）；(b) `uploadToServer` 恒 false（源码断言 + 变异：改为 true 必失败）；(c) 未 consent 无 crashReporter 启动（`crashReporter.isStarted()` 假引擎式 stub）；(d) 事件负载无内容字段（类型层面 closed-union 已保证，运行时快照兜底）。

## D3 自动更新（R3）

- `main/update.ts`：`electron-updater` 的 `autoUpdater`，provider `github`（owner `WASABI110`，repo `GoMentor`，public 免密拉取 feed）。
- `update:status` 事件（M1 预留名）：`{ state: 'idle'|'checking'|'available'|'downloading'|'downloaded'|'error'|'disabled', version?: string, progress?: number, error?: string }`，经 `ipc/events.ts` emit——渲染层 toast + 设置页状态行。
- 触发：启动时一次（`app.whenReady` 后，dev 模式跳过——`app.isPackaged` 判定）+ 菜单 "Check for updates"。
- **macOS 禁用**：`process.platform === 'darwin'` 且未签名构建（无 notarization seam 的 secrets）→ 状态 `disabled`，菜单隐藏，文档说明。判定逻辑集中一处（`updateEligibility.ts` 纯函数），可单测。
- **CI 发布链**：`v*` tag push → 三平台 build + `electron-builder --publish always`（GH_TOKEN secret，**用户行动项**）；PR/普通 push 不发布（`--publish never`）。latest.yml/blockmap 生成纳入打包门禁断言。
- 更新重启语义：electron-updater 默认 quitAndInstall；渲染层在 `downloaded` 后提示"重启安装"。

## D4 GPU tier-2（R4）

- **manifest**：`engine.tier2Targets` 段——`win32-x64`/`linux-x64` 各增 CUDA 资产（官方 release asset 命名：`katago-v1.18.1-cuda12.x-{windows,linux}-x64.zip`，实施时以 release asset 列表核实，含 `bytes`）；OpenCL 作为 `tier2Fallback`（`katago-v1.18.1-opencl-*`，同样官方）。sha256 同走 sidecar。
- **后端选择**：`selectBackend(candidates)` 纯函数（packages/core）——给定已下载后端列表 + 探测结果返回优先级 cuda→opencl→eigen；探测 = 逐后端启动答 `maxVisits:1` 空盘查询，应答成功者胜出，结果持久化 `settings.engine.backend`（用户可手动改回）。Electron 侧 `main/katago/backend-probe.ts` 实现探测循环（复用 process.ts 生命周期）。
- **下载流**：设置页引擎区"启用 GPU 加速"按钮 → 进度事件（复用下载器既有进度通道，M2 fetch 已有）→ 校验 → 探针 → 状态落库。e2e 用假后端 zip（GOMENTOR_KATAGO_BINARY 同例）。
- **完整离线包**：CI job 打 `full-offline-<os>` zip（core + CUDA + OpenCL + 双权重），挂 Release asset；不影响常规安装包。
- 打包体积不变：tier-2 不进安装包（D6 分级原则延续）。

## D5 Fox 同步（R5）

- **位置**：`apps/desktop/src/main/integrations/fox/`（spec 已规划）。协议纯层 `protocol.ts`（无 Electron、fetch 可注入）+ 服务层 `service.ts`（限速、缓存、重试——**零无界重试**，spec 强制）+ `handlers.ts`（薄）。
- **端点**（research/fox-protocol.md，源自 lizzieyzy-next `GetFoxRequest.java`，GPL-3.0 同许可可移植）：
  - `GET https://newframe.foxwq.com/cgi/QueryUserInfoPanel?srcuid=0&username=<enc>` → uid
  - `GET https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?uid=<enc>&lastcode=<enc>` → 分页 JSON（SGF 在 payload 内，规范化函数移植 `normalizeFoxSgfPayload`）
  - `GET .../YHWQFetchChess?chessid=<enc>` → 单局
  - 失败回退链 TXWQFetchChess CGI（两个 host 轮询）——照抄其顺序
- **Fixture**：录制 lizzieyzy-next 自带 `scripts/fetch_fox_sgf_samples.py` 抓的样例 + 实施时对端点实测录制（JSON 落 `test/fixtures/fox/`，脱敏：uid/昵称替换）。端点含 HTTP（非 HTTPS）回退链——记录风险，主链 HTTPS。
- **IPC 面**：`fox:lookupUser {nickname}`、`fox:listGames {uid, cursor?}`、`fox:import {chessid}`（直接入 library store，content-hash 去重由 store 保证）+ 事件 `fox:progress`。全进 A9 元测试。
- **故障隔离**：spec 原文——"No core flow may depend on it succeeding"。Fox 超时/改协议 → 该次操作报错，library/引擎/画像零影响（故障注入 e2e 断言核心面板可用）。限速：令牌桶 1 req/2s，可注入时钟测试。

## D6 营销站（R6）

- `apps/web`：Astro 5 静态输出（M1 已留占位），零 JS 基线（产品页不需要 hydrate；下载卡片是静态链接）。
- 页面：`/`（产品定位 + 中英文产品名 + 截图位）、`/download`（三 OS 卡片 → GitHub Releases 最新版直达链接）、`/docs`（快速上手/引擎与权重/隐私政策——含"遥测仅本地落盘、默认全关"说明/许可与致谢）、`/privacy` 独立页（遥测与隐私是发布审查重点）。
- 双语：zh-CN + en（astro 路由 `/` `/en/`）。
- **交付形态：本地构建、不对外部署**（决策 7：用户"局域网内运行，不做外网部署"）。无 Pages/部署 workflow；验收 = `astro build` 绿 + `astro preview` 冒烟（起服务、首页/下载页 200、内容断言）。外链（GitHub Releases）照常指向公网 Release。
- 测试：build 绿 + preview 冒烟 + 下载链接存活探测（HEAD 请求，离线跳过——katago-provenance 同例）+ 站内链接无死链（astro 构建期已查）。

## 数据与迁移

- settings 新增键：`engine.backend`（探测结果，string|null）、`autoUpdate.enabled`（默认 true，dev 无意义）、fox 无持久键（nickname 历史留内存即可）。全部 forward-compatible：settings schema 已有 unknown-key 存活测试（M1 既定），新增键无迁移负担。
- 无 DB schema 变更（Fox 棋谱入 library 走既有 content-hash 流）。
- 版本：Stage 6 收尾时 desktop `0.1.0` → `1.0.0`；首版 Release `v1.0.0` 由 CI 发布链产出。

## 风险登记

| 风险 | 缓解 |
|---|---|
| Fox 端点改协议/封禁（spec 已标 fragile） | 录制 fixture 锁当前形状；故障隔离 e2e；端点失败给用户可读错误 |
| macOS CI 编译时长（KataGo 源码 ~20min×2 arch） | path 过滤 + ccache 按 manifest 哈希键；只在引擎输入变更时跑 |
| GH_TOKEN secret 未配 | 不阻塞开发门禁，阻塞 v1.0.0 发布——终局门禁前用户行动项 |
| CUDA asset 官方命名与假设不符 | 实施第一步：GitHub API 拉 v1.18.1 asset 列表核实（memory：先验证前提再写论据） |
