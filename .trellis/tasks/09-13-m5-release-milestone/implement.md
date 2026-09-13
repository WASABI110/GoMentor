# Implement: M5 Release Milestone

执行计划。每 Stage：实现 → 质量门禁 → 提交 → CI 监控至绿 → 下一 Stage。检查/验证全程主会话内联执行（用户既定指示：不派发子代理）。

**应急政策（用户 2026-09-13 决策：全自主降级）**：遇计划外情况按"保进度降级 + 完整记录"处理——Fox 不可达→fixture-only 交付标 live 验证 pending；METAL 编译失败→Eigen 回退；CUDA/OpenCL 资产命名与假设不符→按实际名称调整并核实 bytes；依赖破坏→锁定可用版本。**每一次降级逐条记入 final-gate 残余风险**，用户回来逐条过目。

终局门禁逐条 C1–C7 判定记录 `final-gate.md`（gomentor-verify 只读判定，M4 同例）。M6 方向已预定：对弈模式（人机对弈、GTP、让子、计时、对局入画像）。

## Stage 1 — macOS 引擎层（R1, C3）

- [x] 实施第一步：GitHub API 核实 KataGo v1.18.1 编译事实（Compiling.md@92ee95c：METAL 用 ninja+protobuf+abseil；**macos-13 已退役** → `macos-15-intel`，2027-08 到期；Apple Silicon 无 AVX2；tarball 构建 `-DNO_GIT_REVISION=1`）；tier-2 资产命名与字节数一并核实（见 research/macos-engine-tier.md）
- [x] `katago-manifest.ts`：`EngineTarget` + `engine.sourceBuilds` 段 + darwin targets（bytes/sha256 自发布回执实测钉死）
- [x] CI workflow `katago-macos.yml`：macos-15 arm64 METAL + macos-15-intel x64 OPENCL（**brew cmake 4 无法探测 Xcode Swift——用镜像预装 cmake 3.x**）、in-source 构建、ad-hoc 深签、`katago version` 探针、ccache、path 过滤、确定性打包（touch 固定 mtime）+ **漂移守卫（构建哈希必须 ∈ manifest 钉扎；守卫 grep 不得带引号——4c75db7 实测引号 bug 使守卫空转）**、Release asset 发布；notarization 接缝（可选 secrets，未配置跳过）
- [x] `locate.ts` / `currentEngineTarget()` / fetch-katago / electron-builder darwin-arm64 支持；打包门禁 spec 删除 darwin `unavailable` 特例（mac 走真引擎路径，Metal 首跑着色器编译 90s 超时）
- [x] macos runner 打包启动 + 引擎探针 e2e（EngineStatus 走出 unavailable）——**cf5af0c 全绿**：macOS fetch 冻结资产 → e2e → 打包 → 真 Metal 引擎打包启动门禁通过
- **Verify（stage 范围）**：C3 ✓（macos CI 实证）；win/linux 零回归 ✓（cf5af0c windows/ubuntu/repo gates 全绿）；trellis 门禁随终局
- **提交**：`fd9b77c`(workflow) → `1816db2`/`f8f1702`(cmake 修复) → `ed62725`/`4c75db7`/`cf5af0c`(确定性打包+守卫) + `a3ef962`(应用侧 darwin) + `02754fe`(publish-once)
- **残余（记 final-gate）**：源构建不可逐字节复现 → publish-once 语义（research/macos-engine-tier.md）；Intel tier 无打包消费者且 runner 2027-08 退役；GH_TOKEN 未配前 mac 引擎资产已发布、不阻塞

## Stage 2 — 遥测本地接线（R2, C1）

- [ ] `createLocalTelemetry` / consent 闸门 / `crashReporter.start({uploadToServer:false})` / `telemetry.jsonl` 滚动
- [ ] "Reveal crashes" 菜单项（zh-CN/en 文案）
- [ ] 无网络断言（webRequest 计数零）+ uploadToServer 恒 false（含变异）+ 未 consent 不启动
- [ ] A10 既有 stub 验证升级为本地后端验证
- **Verify（stage 范围）**：C1；变异覆盖新边界；全量门禁
- **提交**：`feat(m5/stage2): local-only telemetry — consent-gated crash dumps, zero network`

## Stage 3 — 自动更新（R3, C2）

- [ ] `main/update.ts` + `updateEligibility.ts`（macOS 未签名禁用纯函数）+ `update:status` 事件 + 菜单/启动触发
- [ ] 渲染层：toast + 设置页状态行
- [ ] 集成测试：脚本化 feed 服务器全状态流转（checking→available→downloading→downloaded）
- [ ] A9 元测试登记新事件；打包产物 latest.yml 断言
- [ ] CI：`v*` tag 发布链 workflow（GH_TOKEN secret 注入点 + 未配置时跳过说明——用户行动项记录在 final-gate）
- **Verify（stage 范围）**：C2；门禁全绿
- **提交**：`feat(m5/stage3): auto-update — GitHub Releases feed, update:status channel`

## Stage 4 — GPU tier-2 + 完整离线包（R4, C4）

- [ ] 实施第一步：GitHub API 拉 v1.18.1 asset 列表核实 CUDA/OpenCL 命名与 bytes（先验证前提）
- [ ] manifest `tier2Targets` + fetch 脚本 + sidecar
- [ ] `selectBackend` 纯函数（core）+ `backend-probe.ts` 探测循环 + `settings.engine.backend`
- [ ] 设置页"启用 GPU 加速"下载流（进度事件复用）+ e2e（假后端 zip）
- [ ] CI full-offline asset job
- **Verify（stage 范围）**：C4；探测顺序变异；门禁全绿
- **提交**：`feat(m5/stage4): GPU tier-2 — CUDA/OpenCL backends, backend probe, full-offline asset`

## Stage 5 — Fox 同步（R5, C5）

- [ ] 录制 fixture（lizzieyzy 样例脚本 + 实施时实测，脱敏）
- [ ] `integrations/fox/`：protocol.ts（纯，fetch 注入）/ service.ts（限速器、缓存）/ handlers.ts
- [ ] IPC 面 `fox:lookupUser|listGames|import` + 事件，A9 登记
- [ ] LibraryPanel"从野狐导入"UI（nickname 搜索、列表、导入选中）
- [ ] 故障注入 e2e：Fox 挂 → 核心面板可用；限速器可注入时钟测试
- **Verify（stage 范围）**：C5；门禁全绿
- **提交**：`feat(m5/stage5): Fox game sync — nickname fetch, rate-limited, failure-isolated`

## Stage 6 — 营销站（R6, C6）

- [ ] apps/web Astro：产品页/下载页/文档（隐私+遥测说明）/许可；zh-CN + en
- [ ] 本地构建验收：`astro build` 绿 + `astro preview` 冒烟（首页/下载页 200、内容断言）；**无部署 workflow**（决策 7：不做外网部署）
- [ ] 链接存活探测测试（离线跳过）；版本 0.1.0 → 1.0.0（desktop）
- **Verify（stage 范围）**：C6；门禁全绿
- **提交**：`feat(m5/stage6): marketing site (local build, no deploy) + version 1.0.0`

## 终局门禁（C7）

- [ ] C1–C6 逐条只读判定记录 `final-gate.md`（含残余风险）
- [ ] 全量门禁：lint/typecheck/test/e2e/format/i18n/licenses/trellis + 三平台 CI + 打包启动
- [ ] GH_TOKEN secret 配置提醒（用户行动项，不阻塞判定）
- [ ] `task.py archive` + journal（add_session.py）

## 回滚

每 Stage 独立提交即回滚点；Stage 1/4 的 CI workflow 改动可独立 revert 不影响应用代码。无 DB schema 变更，无 settings 破坏性变更（全部新增键）。
