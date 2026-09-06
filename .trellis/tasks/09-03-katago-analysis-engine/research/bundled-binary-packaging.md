# Research: Bundled Third-Party Binaries in Desktop Apps — Gatekeeper, SmartScreen, AppImage, VC++ runtime

- **Query**: how Electron apps spawning unsigned third-party binaries fare on macOS Gatekeeper, Windows SmartScreen, Linux AppImage; whether KataGo's Windows Eigen build needs the VC++ redistributable; what KaTrain/lizzieyzy/q5go/Sabaki do
- **Scope**: external
- **Date**: 2026-09-04 (all fetches this day)

## Findings

### (a) macOS — unsigned app + unsigned child binary

**Vendor-documented user flow (Apple, fetched 2026-09-04, HTTP 200):**
https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac — "Open a Mac app from an unknown developer":
> "If you try to open an app that isn't registered with Apple by a known developer, you get a warning dialog. … if you choose, you can still open an app from an unknown developer by manually overriding Privacy & Security settings. … Go to Security, then click Open. Click Open Anyway. … The app is saved as an exception to your security settings, and you can open it in the future by double-clicking it."

- Gatekeeper evaluates the **launched app** (quarantine xattr is set on the downloaded .dmg/.app by the browser); it does not separately quarantine every executable inside the bundle. Once the user grants the app the Open-Anyway exception, child processes the app spawns from inside its own bundle are not re-prompted.
- **Apple Silicon caveat (practice-verified, vendor page JS-rendered):** arm64 code must carry at least an **ad-hoc code signature** to execute at all (kernel/amfid enforcement). An unsigned x86_64 child would also be blocked by Gatekeeper *if* quarantined, but children inside an already-approved app bundle are not separately quarantined. The reliable, precedent-backed recipe for an unsigned distribution is: **ad-hoc deep-sign the .app** (`codesign --force --deep --sign -`), which also signs every nested binary.

**Electron official docs (fetched 2026-09-04, HTTP 200):**
https://www.electronjs.org/docs/latest/tutorial/code-signing:
> "macOS [Gatekeeper policies] prevent users from running unsigned applications. It is possible to distribute applications without codesigning them - but in order to run them, users need to go through multiple advanced and manual steps. If you are building an Electron app that you intend to package and distribute, it should be code signed."

**electron-builder docs (fetched 2026-09-04, HTTP 200):**
https://www.electron.build/docs/mac — "macOS apps must be signed to avoid Gatekeeper warnings." Its target table: dmg = standard consumer distribution, expects Signed+Notarized; `7z/tar.*` archives = "Optional/Optional" (a distribution path that never triggers Gatekeeper because no quarantine xattr is applied when fetched via curl/archive expansion instead of a browser-opened bundle — but then the user runs a loose executable, which on Apple Silicon still needs an ad-hoc signature).

**KaTrain precedent (the closest existing product; api.github.com 2026-09-04):**
- INSTALL.md macOS section: KaTrain ships **unsigned** dmgs; first launch is blocked as "an app from an unknown developer"; documented workaround = Apple's Open Anyway flow (linked to the same Apple page above). "This is simply a result of Apple charging $99/year to developers to be 'identified'."
- CI (`.github/workflows/test_and_build.yaml`): after PyInstaller builds `dist/KaTrain.app`, the release job runs **`codesign --force --deep --sign - dist/KaTrain.app`** ("Sign the app (ad-hoc)"), then packages the dmg with hdiutil. The bundled KataGo (`katago-osx`, built from source in the same job) is signed indirectly by the deep sign.
- The Apple-Silicon .app bundles a **Metal-backend** KataGo (GPU/ANE, requires macOS 13+); the Intel .app bundles an OpenCL build (ENGINE.md).

→ **For GoMentor macOS (unsigned until M5):** expect every first launch to hit the Open Anyway flow (document it in install notes, as KaTrain does). Ad-hoc deep-sign the .app in CI so the bundled engine actually executes on Apple Silicon. There is no official macOS KataGo binary (see katago-releases.md) — the bundled engine must be built from source per-arch (Metal for arm64; Eigen or OpenCL for Intel).

### (b) Windows — unsigned installer + unsigned child exe

**Vendor-documented mechanism (Microsoft Learn, fetched 2026-09-04, HTTP 200):**
https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ — "Microsoft Defender SmartScreen overview":
> "Microsoft Defender SmartScreen determines whether a downloaded app or app installer is potentially malicious by: Checking downloaded files against a list of reported malicious software sites and programs known to be unsafe. … Checking downloaded files against a list of files that are well known and downloaded frequently. **If the file isn't on that list, Microsoft Defender SmartScreen shows a warning, advising caution.**"

- SmartScreen is **reputation-based, not signature-based**: an unsigned/new installer triggers a "Windows protected your PC" screen that the user can bypass via "More info → Run anyway". It is a warning, not a block (contrast: Gatekeeper's arm64 hard signature requirement). Reputation accrues with download volume/age/signing.
- **electron-builder docs (fetched 2026-09-04):** https://www.electron.build/docs/win — `sign?` is optional; "Code signing stamps every installer and executable … so that Windows (SmartScreen / UAC) and your auto-updater can verify the publisher". Left unsigned, the build simply carries no Authenticode stamp.
- **KaTrain precedent:** distributes an unsigned `KaTrain.exe`/zip ("Simply download and run, everything is included" — INSTALL.md) with no documented SmartScreen friction beyond that.

→ **For GoMentor Windows:** unsigned NSIS installer + unsigned bundled `katago.exe` = first-run SmartScreen warning; viable for M2-M4 if the download page tells users to click "More info → Run anyway", same as the unsigned-installer status quo across the Go GUI ecosystem.

### (c) Linux — AppImage spawning bundled binaries

**AppImage docs (fetched 2026-09-04, HTTP 200):**
https://docs.appimage.org/user-guide/run-appimages.html — run = "download them, make them executable and run them"; type-2 AppImages self-mount read-only ("`my.AppImage --appimage-mount`") to expose contents. (The docs defer the host FUSE runtime requirement to their Quickstart page, which was not captured verbatim from this environment; the libfuse2/FUSE-runtime requirement on the host is the well-known practical constraint for running — not building — AppImages on minimal or very new distros.)
- No code-signature or notarization enforcement exists on mainstream Linux; distribution friction is dependency/portability, not policy.

**KataGo-on-Linux specifics (verified 2026-09-04):**
- Official KataGo Linux builds **are AppImages** ("Linux executables were compiled on a 22.04 Ubuntu machine using AppImage", v1.18.1 notes). An AppImage nested inside GoMentor's own AppImage would need extraction at runtime (nested FUSE mounts are fragile and pointless) — better to extract the official AppImage once (it supports `--appimage-extract`) during `fetch-katago`/build and ship the loose `katago` binary.
- Dynamic-linking pitfall: KataGo links `libzip`/`zlib` (and on newer builds `abseil`/`protobuf` per the homebrew formula deps). KaTrain's Linux docs name this the most common failure: "**libzip compatibility** … leading to an 'Error 127'" (KaTrain ENGINE.md), and KataGo issue #312 (open) is exactly `error while loading shared libraries: libzip.so.5`. KaTrain's repo bundles a 41.6MB `katago` Linux binary plus `z.dll`/`zip.dll`-style deps for Windows; for Linux it documents the compile-yourself fallback.
- electron-builder can also emit `deb`/`rpm`/`pacman` (installs into the system, dependencies declarable) — an alternative to AppImage for the bundled binary, at the cost of multi-format CI.

### (d) Does the KataGo Windows Eigen build need the VC++ redistributable?

**No explicit statement exists in KataGo's docs or release notes** (verified: README + v1.18.1/v1.18.2 release bodies contain no redistributable mention; GitHub issue search for "visual c++ redistributable" in lightvector/KataGo: 0 hits, 2026-09-04).

**Strong indirect evidence that it dynamically links the MSVC runtime** (api.github.com, 2026-09-04): KaTrain checks the official-style Windows binary into `katrain/KataGo/katago.exe` (7,518,720 B) **together with** `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`, `msvcp140_atomic_wait.dll`, `msvcp140_codecvt_ids.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`, `vcruntime140_threads.dll` — i.e. KaTrain ships the Visual C++ runtime DLLs next to katago.exe precisely because a clean Windows install lacks them. Same for zlib/libzip (`z.dll`, `zip.dll`) and OpenSSL (`libcrypto-3-x64.dll`, `libssl-3-x64.dll`) + `cacert.pem`.

→ **For GoMentor Windows:** treat the VC++ 2015-2022 x64 redistributable as a runtime dependency. The KaTrain pattern (copy the 8 redist DLLs into `resources/katago/` next to `katago.exe`) avoids any installer prerequisite and keeps the app portable; test `katago benchmark` on a stock Windows VM without the redist installed, both with and without the bundled DLLs.

### What the other Go GUIs do (survey, all verified 2026-09-04)

| App | Stack | Bundles KataGo? | macOS handling | Windows handling |
|---|---|---|---|---|
| **KaTrain** | Python/Kivy (PyInstaller) | Yes — exe checked into repo; macOS binary built from source in CI; offers in-app "download katago versions" incl. Eigen | Unsigned dmg; Open Anyway documented; **ad-hoc deep sign in CI**; arm64 app = Metal engine, Intel app = OpenCL | Unsigned exe/zip; VC++ runtime + zlib/libzip/OpenSSL DLLs shipped next to katago.exe |
| **lizzieyzy** | Java | Base zips are "without.engine"; full engine packages via Google Drive/Baidu mirrors | macOS amd64 zip offered | windows64 zip (~259MB incl. engine/JRE) |
| **Sabaki** | **Electron** | No — user points it at engines; docs (docs/guides/engines.md) just list download links (KataGo, Leela Zero, GNU Go…) | n/a — but its docs are the Electron-app pattern for *not* bundling | n/a |
| **q5go** | C++/Qt | No engine bundling (checked scope: not flagged in any doc) | n/a | n/a |

- Sabaki is the Electron precedent in this space and it deliberately does **not** bundle engines; no Electron+KataGo bundling precedent was found in the reachable sources. KaTrain is therefore the load-bearing precedent for bundling, and it is unsigned everywhere with documented/manual first-launch workarounds.
- The only fully signed+notarized path among precedents: none. All reachable precedents ship unsigned.

### Related Specs / Task Context

- PRD: "Code-signing spike runs in parallel from M2; actual signing is M5. macOS Gatekeeper treatment of an unsigned bundled katago binary is a named M2 risk." → this research confirms the risk shape: Open Anyway flow + **mandatory ad-hoc deep-sign for the arm64 child**; SmartScreen is a soft warning on Windows.
- PRD: `extraResources` for `resources/{katago,weights}` already configured in `apps/desktop/electron-builder.yml` — consistent with the KaTrain DLLs-next-to-exe pattern.

## Caveats / Not Found

- Apple's own developer documentation pages on code signing are JS-rendered; the "ad-hoc signature is the minimum on Apple Silicon" fact is supported here by the Electron docs + KaTrain's CI practice, not by a captured Apple quote. The Apple Support user-flow quote *is* captured verbatim.
- The exact AppImage host FUSE requirement wording was not captured (docs defer to a Quickstart page); the behavior is otherwise documented by the mount/extract sections fetched.
- No quantitative data on SmartScreen warning rates vs signing (no reachable source); reputation-based mechanism is the vendor-documented core fact.
- q5go's packaging was not exhaustively inspected (low relevance; it does not bundle engines).
