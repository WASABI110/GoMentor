# M5 Final Gate — 逐条判定（2026-09-13）

主会话内联只读判定（用户既定指示：不派发子代理）。证据基线：HEAD `16fc5e4`，CI 四项全绿（Repo gates + ubuntu + windows + macos），本地全量 1684 vitest + 48 e2e + lint/typecheck/format/licenses/i18n。

## C1 遥测本地接线 — **PASS**

- consent 闸门：未 consent 无 crashReporter、无文件、`enabled:false`（单测 + e2e `telemetry.spec` 真应用重启验证：consent 后 `getUploadToServer()===false`、JSONL 落盘、行字段全标量）
- 零网络：node:http/https/net + fetch/WebSocket/WebXHR 全原语陷阱，双实现断言零触达
- 变异：`mutate-telemetry.mts` 7/7 caught（uploadToServer 翻转、consent 门、context 泄漏、轮转、slot 释放等）
- 菜单 "打开崩溃报告目录" 常驻；侧车路径 userData（路径规则）

## C2 自动更新 — **PASS（带残余）**

- `update:status` 通道 A9 用例 + docs；eligibility 纯函数优先级（dev > 设置 > mac 未签名）单测钉死
- electron-updater 事件→payload 映射全覆盖单测（脚本化 driver seam）；拒绝的 check 映射为 error 状态而非 unhandled rejection
- macOS 未签名禁用（Squirrel 硬约束）+ 一次性 `disabled` 事件
- release.yml：`v*` tag → 三 OS 构建门禁 + `--publish always`；无 token 时 rehearsal 路径出 artifacts
- **残余**：真实 feed 的下载/安装全链路需 GH_TOKEN + v1.0.0 tag 后首跑验证

## C3 macOS 引擎层 — **PASS**

- CI 双 arch 源码构建绿（arm64 METAL / x64 OpenCL，`katago version` 探针 + ad-hoc 深签验证）
- publish-once 语义：Release 冻结首发字节，重建漂移警告跳过（源构建不可逐字节复现为实测结论）
- macos runner 打包门禁走真引擎（fetch 冻结资产 → ready → 真实读数），Metal 首跑着色器 90s 容忍
- 实测教训入册：macos-13 已退役（`macos-15-intel`，2027-08 到期）；brew cmake 4 无法探测 Xcode Swift（用镜像预装 cmake）

## C4 GPU tier-2 — **PASS（带三项残余）**

- fetch 管线实测：CUDA zip 下载→TOFU→解压展平→`<target>-cuda/` 落位（本机实跑）
- 应用内下载：`@gomentor/engines` 包 + gpu 服务（单时隙/进度节流/平台拒绝）+ 三通道 + 设置页引擎区；单测 6 项（ensure seam 脚本化）
- locate `selectBundledDir`：偏好二进制存在才选（空目录不算），tier-1 兜底 + 4 单测；`selectBackend` 顺序策略 + 5 单测
- **残余**：(a) full-offline CI job 未建；(b) selectBackend 变异条目未并入 harness；(c) OpenCL zip 本机网络 6 连失败（CUDA 同链路成功，环境性）

## C5 Fox 同步 — **PASS（带残余）**

- 协议纯层（fetch 注入）：双 URL 编码、payload 规范化、junk 行容忍、全类型化错误——14 单测对结构性 fixture 全绿
- 服务层：限速 1req/2s 注入时钟（断言计算延迟而非睡眠）、零重试、SOURCE_* 映射——5 单测
- 通道 ×3 + A9 + docs；fox:import 走 library 同路径（hash 去重 + changed 事件）
- UI：FoxImportSection（搜索→列表→导入/去重/重试），失败隔离在自身区块
- **残余**：live 联调未做（实施期网络不可达 foxwq.com）；fixture 为结构性模拟，首联调流程已写入 research/fox-fixtures.md

## C6 营销站 — **PASS**

- Astro 8 页双语（zh `/`、en `/en/`）：产品/下载/文档/隐私；零 JS（隐私页"无跟踪"承诺 → 无 script 标签由 site-smoke 强制）
- `site-smoke.test.ts` 常驻门禁（构建 + 品牌 + Releases 链接 + 无脚本断言）
- **无部署**（决策 7：局域网/本地构建）；隐私口径与 C1/C2 交付逐字对齐

## C7 终局门禁 — **PASS**

- 本地：typecheck 0 错、lint 0、format 0、vitest 1684/1684、e2e 48/48、licenses OK（746 包/16 许可）
- CI `16fc5e4`：Repo gates ✅ ubuntu ✅ windows ✅ macos ✅
- 版本 1.0.0（全 workspace + preload 常量）
- 变异闸门：mutate-telemetry 7/7（M2-M4 既有 harness 不在本里程碑触碰面）

## 残余风险清单（全部已知、已记录、不阻塞）

1. macOS/安装包自动更新全链路待 v1.0.0 tag + GH_TOKEN 后首跑验证（用户行动项）
2. Fox live 联调（结构 fixture 锁形状；首联调流程在 research/fox-fixtures.md）
3. GPU full-offline CI job + selectBackend 变异条目
4. OpenCL zip 本机网络不可达（环境性；CI 网络已验证可下载同类资产）
5. macOS 未签名 → 无自动更新 + Open Anyway 流程（用户决策，文档已声明）
6. Intel mac tier（darwin-x64）2027-08 随 GitHub x86_64 runner 退役而止
