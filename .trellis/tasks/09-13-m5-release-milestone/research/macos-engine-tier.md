# macOS 引擎层调研 — 2026-09-13（Stage 1 前提已验证）

## 结论

无官方 macOS KataGo 二进制（manifest 已记录），但 **CI 自编译可行且官方文档一等公民支持**：KataGo v1.18.1 `Compiling.md` 有专门 MacOS 节（本文件所有事实来自该文档在 tag `92ee95c` 的原文，2026-09-13 经 GitHub API 拉取验证）。

## 已验证的编译事实（Compiling.md §MacOS）

| 项 | 值 |
|---|---|
| 后端 | `cmake . -G Ninja -DUSE_BACKEND=METAL`（推荐）或 `OPENCL` / `EIGEN` |
| Metal 额外依赖 | `brew install ninja protobuf abseil` |
| 通用依赖 | brew、cmake ≥3.18.2、`xcode-select --install`（AppleClang+Swift）、`brew install libzip` |
| Metal 构建 | `ninja`；OpenCL/EIGEN 构建 | `make` |
| AVX2 | **Apple Silicon 不支持**（Intel Mac 可选；darwin 构建统一不带 `-DUSE_AVX2`，兼容优先） |
| tarball 构建 | 加 `-DNO_GIT_REVISION=1`（编译默认跑 git 命令嵌 hash，源码 zip 无 .git） |
| BUILD_DISTRIBUTED | 仅公共训练贡献需要——**不加** |

## 构建矩阵

| arch | runner | 后端 | 备注 |
|---|---|---|---|
| arm64 | `macos-15` | METAL | runner 预装 Xcode/brew；Metal 只需编译期 Swift 工具链，无需 GPU |
| x64 | `macos-13` | OPENCL | GitHub 最后一代 Intel runner；KaTrain Intel 用 OpenCL；KataGo issue #1175 报 Intel Metal 回归 |

**Intel runner 退役风险**：macos-13 是 GitHub 最后的 Intel 镜像，若执行时已退役 → 按应急政策降级：darwin 仅交付 arm64 METAL tier，Intel 回到"unavailable by construction"（M1–M4 原状），记 final-gate 残余风险。

## 签名（无 Apple 账号路线，用户已确认）

- `codesign --deep -s - <katago>`：ad-hoc 深签。**Apple Silicon 子进程必须签**（KaTrain CI 先例：不签会被 macOS 杀）。
- 用户侧：首次启动 Gatekeeper Open Anyway 流程，文档化（KaTrain 同例）。
- **notarization 接缝**：workflow 接收可选 secrets（APPLE_ID / APPLE_ID_PASSWORD / TEAM_ID），未配置跳过——补账号后零代码改动升级。
- 自动更新：electron-updater 在 macOS 要求签名 app（Squirrel 硬约束）→ 未签名构建禁用（Stage 3 的 `updateEligibility` 处理）。

## CI 成本与缓存

- KataGo 源码编译 ~15–25min/arch（首次）；ccache 按 manifest 哈希键缓存（tier-1 既定模式）。
- workflow path 过滤：仅 `scripts/katago-manifest.ts`、`scripts/katago-checksums.json`、workflow 自身变更时触发。
- 产物发布为 Release asset（`katago-darwin-arm64-v1.18.1.tar.gz` 等），**不进 git**（tier-1 同例：CI 按 manifest 哈希缓存拉取）。

## Stage 4 前提（顺手验证，2026-09-13 GitHub API 实测 v1.18.1 资产列表，66 个）

tier-2 选型与精确字节数（实施时照抄，无需再查）：

| 后端 | 资产名 | bytes |
|---|---|---|
| CUDA（默认选） | `katago-v1.18.1-cuda12.8-cudnn9.8.0-windows-x64.zip` | 10,135,501 |
| CUDA | `katago-v1.18.1-cuda12.8-cudnn9.8.0-linux-x64.zip` | 51,344,405 |
| OpenCL（回退） | `katago-v1.18.1-opencl-windows-x64.zip` | 6,004,137 |
| OpenCL（回退） | `katago-v1.18.1-opencl-linux-x64.zip` | 41,325,151 |

- CUDA 选 cuda12.8 的理由：12.x 驱动装机量远大于 13.x（2026-09 时点），cudnn9.8.0 是该 cuda 版本最新搭配。更老的 cuda12.1/12.5 组合存在但无必要。
- linux opencl zip 体积与 tier-1 linux eigenavx2（41,821,245，AppImage 包装）同量级 → `appImage: true` 可能适用，Stage 4 实施时以 unzip 列表核实。
- `+bs50` 变体存在（大 batch 构建）——与 tier-1 同理不选（CPU/单用户场景非 batch bound）。

## 可复现性实测（2026-09-13，M5 Stage 1）

**KataGo 源构建在这些 runner 上不可逐字节复现**：同一 ref、同一 recipe、暖 ccache、固定 mtime 的 zip，跨 run 仍产出不同字节（实测 4c75db7 与 cf5af0c 两轮，arm64/x64 双双漂移：9f370f30→cb44e431、8233eb4f→376f503a）。代码生成随 runner 镜像状态漂移，非本管线可控制。

**对策 = publish-once 语义**：Release 冻结首次发布的字节；manifest 钉死那一次的 bytes/sha256（自回执实测）；重建相同则上传为 no-op，不同则 `::warning::` 跳过上传（绝不静默 clobber——任何已记录的 TOFU 哈希都不会被脚底下换掉）。更新引擎 = 有意的版本 bump（KATAGO_REF + manifest 同提交），新版本落全新 tag。工作流保持绿，TOFU 链稳定。

守卫演进史（同日三轮）：对比"已发布字节"（堵死合法重钉）→ 对比"manifest 钉扎"（引号 bug 使 grep 双双落空、守卫空转——`grep` 模式不得带引号字符）→ publish-once（最终形态）。

## M2 research 回填说明

implement.md 原计划回填 `09-03-katago-analysis-engine/research/bundled-binary-packaging.md`——该文件在已归档任务内（按惯例冻结不改），macOS ad-hoc 签名与 Gatekeeper 知识已完整并入本文件，指向归档件即可。
