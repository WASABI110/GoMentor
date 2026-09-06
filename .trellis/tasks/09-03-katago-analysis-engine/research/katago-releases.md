# Research: KataGo Releases — latest version, Eigen CPU assets, checksums, packaging, prerequisites, license

- **Query**: latest lightvector/KataGo release; complete asset list; Eigen CPU builds per OS; SHA256 checksums; archive contents; runtime prerequisites; binary redistribution license
- **Scope**: external
- **Date**: 2026-09-04 (all fetches below performed this day; GitHub API JSON snapshots saved under `.research-tmp/`)

## Findings

### Latest releases (verified via GitHub API, 2026-09-04)

| Release | Published (UTC) | Assets | Notes |
|---|---|---|---|
| v1.18.2 "CUDA Speedup for Turing (RTX 20xx, etc)" | 2026-08-30T01:54:00Z | 24 | **CUDA-only.** Body: "For all other backends (AMD GPUs, etc) see the prior release v1.18.1" |
| **v1.18.1** | 2026-08-24T04:27:54Z | 66 | **Latest release containing Eigen CPU builds.** Bugfix release on v1.18.0 |

- URLs: https://github.com/lightvector/KataGo/releases/tag/v1.18.2 , https://github.com/lightvector/KataGo/releases/tag/v1.18.1
- API: `GET https://api.github.com/repos/lightvector/KataGo/releases/latest` and `/releases` (30 releases scanned).

### Complete v1.18.2 asset list (all 24, CUDA backend only)

All filenames `katago-v1.18.2-<variant>.zip`, base URL `https://github.com/lightvector/KataGo/releases/download/v1.18.2/`:

| Asset | Bytes | MiB |
|---|---|---|
| cuda12.1-cudnn8.9.7-linux-x64+bs50.zip | 45,545,991 | 43.4 |
| cuda12.1-cudnn8.9.7-linux-x64.zip | 50,783,789 | 48.4 |
| cuda12.1-cudnn8.9.7-windows-x64+bs50.zip | 6,970,524 | 6.6 |
| cuda12.1-cudnn8.9.7-windows-x64.zip | 9,735,980 | 9.3 |
| cuda12.1-cudnn9.8.0-linux-x64+bs50.zip | 45,637,762 | 43.5 |
| cuda12.1-cudnn9.8.0-linux-x64.zip | 50,893,347 | 48.5 |
| cuda12.1-cudnn9.8.0-windows-x64+bs50.zip | 6,981,967 | 6.7 |
| cuda12.1-cudnn9.8.0-windows-x64.zip | 9,748,641 | 9.3 |
| cuda12.5-cudnn8.9.7-linux-x64+bs50.zip | 45,644,685 | 43.5 |
| cuda12.5-cudnn8.9.7-linux-x64.zip | 50,878,339 | 48.5 |
| cuda12.5-cudnn8.9.7-windows-x64+bs50.zip | 7,059,746 | 6.7 |
| cuda12.5-cudnn8.9.7-windows-x64.zip | 9,821,118 | 9.4 |
| cuda12.5-cudnn9.8.0-linux-x64+bs50.zip | 45,637,700 | 43.6 |
| cuda12.5-cudnn9.8.0-linux-x64.zip | 50,958,671 | 48.6 |
| cuda12.5-cudnn9.8.0-windows-x64+bs50.zip | 7,073,110 | 6.7 |
| cuda12.5-cudnn9.8.0-windows-x64.zip | 9,834,578 | 9.4 |
| cuda12.8-cudnn9.8.0-linux-x64+bs50.zip | 46,146,059 | 44.0 |
| cuda12.8-cudnn9.8.0-linux-x64.zip | 51,350,638 | 49.0 |
| cuda12.8-cudnn9.8.0-windows-x64+bs50.zip | 7,412,623 | 7.1 |
| cuda12.8-cudnn9.8.0-windows-x64.zip | 10,173,580 | 9.7 |
| cuda13.2-cudnn9.24.0-linux-x64+bs50.zip | 45,671,788 | 43.6 |
| cuda13.2-cudnn9.24.0-linux-x64.zip | 50,896,760 | 48.5 |
| cuda13.2-cudnn9.24.0-windows-x64+bs50.zip | 7,055,066 | 6.7 |
| cuda13.2-cudnn9.24.0-windows-x64.zip | 9,825,374 | 9.4 |

### Complete v1.18.1 asset list (all 66)

Base URL `https://github.com/lightvector/KataGo/releases/download/v1.18.1/`. **Eigen rows in bold.**

| Asset | Bytes | MiB |
|---|---|---|
| cuda12.1-cudnn8.9.7-linux-x64+bs50.zip | 45,535,452 | 43.4 |
| cuda12.1-cudnn8.9.7-linux-x64.zip | 50,790,097 | 48.4 |
| cuda12.1-cudnn8.9.7-windows-x64+bs50.zip | 6,929,670 | 6.6 |
| cuda12.1-cudnn8.9.7-windows-x64.zip | 9,697,364 | 9.3 |
| cuda12.1-cudnn9.8.0-linux-x64+bs50.zip | 45,589,869 | 43.5 |
| cuda12.1-cudnn9.8.0-linux-x64.zip | 50,870,294 | 48.5 |
| cuda12.1-cudnn9.8.0-windows-x64+bs50.zip | 6,944,430 | 6.6 |
| cuda12.1-cudnn9.8.0-windows-x64.zip | 9,711,098 | 9.3 |
| cuda12.5-cudnn8.9.7-linux-x64+bs50.zip | 45,605,411 | 43.5 |
| cuda12.5-cudnn8.9.7-linux-x64.zip | 50,831,816 | 48.5 |
| cuda12.5-cudnn8.9.7-windows-x64+bs50.zip | 7,022,292 | 6.7 |
| cuda12.5-cudnn8.9.7-windows-x64.zip | 9,783,871 | 9.3 |
| cuda12.5-cudnn9.8.0-linux-x64+bs50.zip | 45,658,267 | 43.5 |
| cuda12.5-cudnn9.8.0-linux-x64.zip | 50,942,450 | 48.6 |
| cuda12.5-cudnn9.8.0-windows-x64+bs50.zip | 7,035,766 | 6.7 |
| cuda12.5-cudnn9.8.0-windows-x64.zip | 9,796,756 | 9.3 |
| cuda12.8-cudnn9.8.0-linux-x64+bs50.zip | 46,069,070 | 43.9 |
| cuda12.8-cudnn9.8.0-linux-x64.zip | 51,344,405 | 49.0 |
| cuda12.8-cudnn9.8.0-windows-x64+bs50.zip | 7,373,230 | 7.0 |
| cuda12.8-cudnn9.8.0-windows-x64.zip | 10,135,501 | 9.7 |
| cuda13.2-cudnn9.24.0-linux-x64+bs50.zip | 45,581,922 | 43.5 |
| cuda13.2-cudnn9.24.0-linux-x64.zip | 50,873,776 | 48.5 |
| cuda13.2-cudnn9.24.0-windows-x64+bs50.zip | 7,022,291 | 6.7 |
| cuda13.2-cudnn9.24.0-windows-x64.zip | 9,784,089 | 9.3 |
| **eigen-linux-x64+bs50.zip** | 36,523,433 | 34.8 |
| **eigen-linux-x64.zip** | 41,780,528 | 39.9 |
| **eigen-windows-x64+bs50.zip** | 3,136,207 | 3.0 |
| **eigen-windows-x64.zip** | 5,903,072 | 5.6 |
| **eigenavx2-linux-x64+bs50.zip** | 36,557,304 | 34.9 |
| **eigenavx2-linux-x64.zip** | 41,821,245 | 39.9 |
| **eigenavx2-windows-x64+bs50.zip** | 3,135,786 | 3.0 |
| **eigenavx2-windows-x64.zip** | 5,899,607 | 5.6 |
| onnx-openvino-linux-x64+bs50.zip | 120,159,120 | 114.6 |
| onnx-openvino-linux-x64.zip | 120,160,187 | 114.6 |
| onnx-openvino2026.2.1-windows-x64+bs50.zip | 84,223,848 | 80.3 |
| onnx-openvino2026.2.1-windows-x64.zip | 86,695,392 | 82.7 |
| onnx1.24.4-directml-windows-x64+bs50.zip | 21,112,327 | 20.1 |
| onnx1.24.4-directml-windows-x64.zip | 23,584,379 | 22.5 |
| opencl-linux-x64+bs50.zip | 36,060,094 | 34.4 |
| opencl-linux-x64.zip | 41,325,151 | 39.4 |
| opencl-windows-x64+bs50.zip | 3,235,507 | 3.1 |
| opencl-windows-x64.zip | 6,004,137 | 5.7 |
| rocm7.13-gfx103X-windows-x64+bs50.zip | 214,560,357 | 204.6 |
| rocm7.13-gfx103X-windows-x64.zip | 217,380,864 | 207.3 |
| rocm7.13-gfx110X-windows-x64+bs50.zip | 218,658,487 | 208.5 |
| rocm7.13-gfx110X-windows-x64.zip | 221,478,994 | 211.2 |
| rocm7.13-gfx1151-windows-x64+bs50.zip | 173,332,686 | 165.3 |
| rocm7.13-gfx1151-windows-x64.zip | 176,153,193 | 168.0 |
| rocm7.13-gfx120X-windows-x64+bs50.zip | 554,041,622 | 528.4 |
| rocm7.13-gfx120X-windows-x64.zip | 556,862,129 | 531.1 |
| rocm7.14.0-linux-x64+bs50.zip | 83,487,052 | 79.6 |
| rocm7.14.0-linux-x64.zip | 85,571,470 | 81.6 |
| rocm7.2.4-linux-x64+bs50.zip | 18,909,079 | 18.0 |
| rocm7.2.4-linux-x64.zip | 20,848,171 | 19.9 |
| trt10.16.1-cuda13.2-linux-x64+bs50.zip | 37,918,399 | 36.2 |
| trt10.16.1-cuda13.2-linux-x64.zip | 43,118,123 | 41.1 |
| trt10.16.1-cuda13.2-windows-x64+bs50.zip | 5,731,366 | 5.5 |
| trt10.16.1-cuda13.2-windows-x64.zip | 8,497,675 | 8.1 |
| trt10.2.0-cuda12.5-linux-x64+bs50.zip | 37,857,302 | 36.1 |
| trt10.2.0-cuda12.5-linux-x64.zip | 43,046,369 | 41.1 |
| trt10.2.0-cuda12.5-windows-x64+bs50.zip | 5,616,744 | 5.4 |
| trt10.2.0-cuda12.5-windows-x64.zip | 8,378,417 | 8.0 |
| trt10.9.0-cuda12.8-linux-x64+bs50.zip | 37,883,720 | 36.1 |
| trt10.9.0-cuda12.8-linux-x64.zip | 43,122,191 | 41.1 |
| trt10.9.0-cuda12.8-linux-x64.zip | 8,375,820 | 8.0 |

### Eigen CPU builds — platform coverage (the key M2 question)

- **windows-x64: YES** — `katago-v1.18.1-eigen-windows-x64.zip` (5,903,072 B) and `katago-v1.18.1-eigenavx2-windows-x64.zip` (5,899,607 B), plus `+bs50` variants.
- **linux-x64: YES** — `katago-v1.18.1-eigen-linux-x64.zip` (41,780,528 B) and `katago-v1.18.1-eigenavx2-linux-x64.zip` (41,821,245 B). The release notes state: "Linux executables were compiled on a 22.04 Ubuntu machine using AppImage." → the Linux zip ships an **AppImage** (explains ~40MB vs ~6MB for the loose Windows exe).
- **macOS (arm64 or x86_64): NO** — no macOS assets in v1.18.1 (or any of the 30 releases examined; asset-name scan found zero `osx`/`mac`/`darwin` files). The release body says: "For MacOS, use the Metal backend, which you can generally get by installing KataGo from homebrew."
  - Homebrew (verified 2026-09-04 via https://formulae.brew.sh/api/formula/katago.json and the formula source): current 1.18.2; bottles for `arm64_tahoe`, `arm64_sequoia`, `arm64_sonoma`, `arm64_linux`, `x86_64_linux` (no Intel-mac bottle). Formula install logic: **macOS arm64 builds with `-DUSE_BACKEND=METAL`** (linked by swiftc); **macOS Intel and Linux build with `-DUSE_BACKEND=EIGEN`**. License field: "MIT AND CC0-1.0".
  - Consequence for GoMentor: there is no official prebuilt macOS Eigen/CPU binary to bundle. Options surfaced by evidence: (1) build from source (homebrew-style) per macOS arch — Metal on arm64, Eigen on Intel; (2) invoke a homebrew-installed katago (not zero-config). Homebrew bottles are per-OS-version; relying on them at runtime is not bundling.
- `eigen` vs `eigenavx2`: release body: "If you need a pure-CPU version of KataGo, use Eigen AVX2… If somehow you're on an ancient CPU as well and Eigen AVX2 doesn't work, you can try Eigen, which will be even slower." README adds the AVX2 build "will not run at all on older CPUs… that don't support these fancy vector instructions." → bundle eigenavx2 for modern CPUs, keep plain eigen as fallback.

### SHA256 checksums

- **KataGo does NOT publish checksums for release binaries.** No checksum asset in any of the 30 releases returned by the API (scan for `sha`/`checksum`/`.txt`/`.sig` in asset names: none). The CI workflow `.github/workflows/build.yml` (fetched 2026-09-04) contains no sha256/hash generation step for artifacts (only cache-key hashing).
- Consequence for M2 (`fetch-katago.ts`): the pinned manifest cannot cite upstream checksums; GoMentor must record its own hash on first fetch (trust-on-first-use) or verify via an independent channel.

### What ships inside each archive

Direct verification failed: downloading the release zip from this environment failed 3× on 2026-09-04 with "curl: (56) Recv failure: Connection was reset" (GitHub's release-asset CDN `objects.githubusercontent.com` is unreachable here; a 2.4MB partial from a prior session exists). Indirect evidence:

- The release package includes a usage README (captured previously at `.research-tmp/relpkg.txt`, headed "KataGo v1.18.2 / https://github.com/lightvector/KataGo"). It references, as files co-located with the executable: `default_gtp.cfg`, `default_model.bin.gz` (user-supplied net), `gtp_human5k_example.cfg`, and mentions tuning "in `default_gtp.cfg`". So release archives ship the executable + config templates.
- The repo's config templates live at `cpp/configs/` (listed via API 2026-09-04): `analysis_example.cfg` (27,829 B), `gtp_example.cfg` (38,973 B), `gtp_human5k_example.cfg`, `contribute_example.cfg`, `match_example.cfg`, `task_example.cfg` + `book/`, `misc/`, `training/` subdirs. Homebrew's formula installs the whole `cpp/configs` dir as pkgshare — consistent with configs being part of a distribution.
- KaTrain (api.github.com 2026-09-04) checks official-style binaries into `katrain/KataGo/`: `katago.exe` (7,518,720 B), `katago` Linux binary (41,630,200 B), `analysis_config.cfg`, `contribute_config.cfg`, plus Windows DLLs: `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`, `msvcp140_atomic_wait.dll`, `msvcp140_codecvt_ids.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`, `vcruntime140_threads.dll`, `OpenCL.dll`, `libcrypto-3-x64.dll`, `libssl-3-x64.dll`, `z.dll`, `zip.dll`, `bz2.dll`, `cacert.pem`. (KaTrain's macOS job instead builds `katago-osx` from source in CI.)

### Stated runtime prerequisites (v1.18.1 release body, verbatim points)

- CUDA backend: "You'll also have to install CUDA and one of CUDNN or TensorRT from nvidia"; cuDNN >= 9.8.0 recommended; TensorRT < 10 unsupported.
- ROCm (AMD): Linux requires self-installed ROCm; Windows build "does NOT require installing ROCm (you need a reasonably recent AMD (Adrenalin) driver)" but "The DLLs provided and the `rocblas` and `hipblaslt` folders must stay next to katago.exe"; first run can take 45s+ (MIOpen tuning, cached under `%USERPROFILE%\.miopen\`).
- ONNX/OpenVINO: self-contained on Windows and Linux; needs Intel GPU/NPU drivers; `onnxOpenVINOCacheDir` recommended.
- OpenCL: needs a GPU/driver; first-run tuning 5–30 s (per README).
- Linux: "executables were compiled on a 22.04 Ubuntu machine using AppImage. You will still need to install e.g. correct versions of Cuda/TensorRT or have drivers for OpenCL" (AppImage ⇒ FUSE runtime needed to execute directly).
- Eigen CPU: **no prerequisite is stated anywhere in the release notes or README for the Eigen build** (no GPU/driver/CUDA needed). Visual C++ redistributable is not mentioned by KataGo; see the DLL evidence above — the Windows exe dynamically links the MSVC runtime (KaTrain ships `vcruntime140*.dll`/`msvcp140*.dll` next to `katago.exe`), so a clean Windows machine without the VC++ redistributable is a real risk unless those DLLs are bundled alongside.

### License (binary redistribution terms)

- Fetched 2026-09-04: https://raw.githubusercontent.com/lightvector/KataGo/master/LICENSE
- Content: MIT license ("Copyright 2025 David J Wu ("lightvector") and/or other authors…"). Permission explicitly includes "use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software" → **redistributing KataGo binaries inside GoMentor is permitted**; condition = retain copyright + permission notice.
- Preamble lists vendored components with their own licenses inside `cpp/external` (clblast, composable_kernel_fmha, cudnn-frontend, cutlass, filesystem-1.5.8, half-2.2.0, httplib, katagocoreml, macos Swift modules, mozilla-cacerts, nlohmann_json, sgfmill, onnx, tclap-1.2.5); `cpp/core/sha2.cpp` embeds its own license.
- Additional paragraph: "the license you receive to my code is from me, and not from any of my employers" (personal repo).
- Homebrew formula license field: "MIT AND CC0-1.0" (CC0 covers g170 resources, i.e. the training data/resources, not the engine).

### Related Specs / Task Context

- `.trellis/tasks/09-03-katago-analysis-engine/prd.md` — D6 core tier (Eigen + small net, ~120MB), E1 (checksum-verified fetch), risk notes (Windows CUDA/TensorRT DLL deps; macOS unsigned-binary risk). This file confirms: Eigen tier has no such DLL deps beyond the MSVC runtime; the macOS asset gap is real and must be solved by source builds, not downloads.

## Caveats / Not Found

- **Could not list the actual zip contents** — release-asset downloads are blocked from this environment (connection reset, 3 attempts, 2026-09-04). Contents above are inferred from the in-package README text, the repo's `cpp/configs`, and KaTrain's checked-in copies. Fetch on a network with GitHub access and record manifest hashes in `fetch-katago.ts`.
- No macOS binaries in GitHub releases — verified absence, but "why" is only explained by the release note pointing to homebrew.
- Whether the Windows Eigen zip itself bundles the VC++ redist DLLs (like KaTrain does) is unverified for v1.18.1; the zip is only ~0.6MB larger than the exe alone, suggesting mostly exe + configs.
