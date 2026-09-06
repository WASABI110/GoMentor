# Research: KataGo Neural Networks — families, small nets, sizes, URLs, checksums, license

- **Query**: net families and small-net options (b6c96, b10c128, …), exact file sizes, relative strength, download URL patterns/stability, checksums, license/redistribution terms; recommendation for CPU-Eigen zero-config bundle
- **Scope**: external
- **Date**: 2026-09-04 (all fetches performed this day)

## Findings

### Sources fetched live

- https://katagotraining.org/networks/ — HTTP 200, 498,701 bytes (identical size to the 2026-09-03 snapshot in `.research-tmp/kt_nets.html`, i.e. page content unchanged between the two days). This page shows the **kata1** run: 950 table rows, 831 `*.bin.gz` model links.
- https://katagotraining.org/extra_networks/ — HTTP 200 (fetched 2026-09-04).
- https://katagotraining.org/network_license/ — content captured (page titled "katagotraining.org - Neural Network License").
- HTTP HEAD probes against `https://media.katagotraining.org/...` for exact file sizes (all 2026-09-04).
- Homebrew formula `katago.rb` (api.github.com, 2026-09-04) — embeds sha256 pins for the nets it bundles.

### Current strongest nets (for strength scale), from networks table

Table columns: net name | date | "Elo ± err - (games)" | [model Download] | [training-data zip Download]. Top rows on 2026-09-04:

| Net | Date | Site Elo |
|---|---|---|
| kata1-zhizi-b40c768nbt-s11472M-d5982M | 2026-07-27 | 14538.8 ± 19.4 |
| kata1-tf3-b11c768-s11001M-d5973M | 2026-08-25 | 14530.9 ± 20.4 |
| kata1-tf3-b11c768-s11341M-d6089M (newest by date) | 2026-09-01 | 14515.6 ± 32.6 |
| kata1-tf3-b10c512-s3203M-d5937M | 2026-08-25 | 14167.8 ± 13.1 |
| kata1-tf2-b10c384-s2941M-d5872M | 2026-08-25 | 13707.4 ± 14.4 |

These full-size nets (hundreds of MiB) are far too large for the core tier; listed only as the strength ceiling.

### Small-net options (the g170 imports listed on the kata1 page)

The kata1 networks table includes the final nets of the older **g170** run, marked "Imported from g170, the run KataGo did in early to mid 2020". Rows verified in the 2026-09-04 fetch:

| Net (kata1 page name) | Family | Date | Site Elo | Download size (HEAD) |
|---|---|---|---|---|
| kata1-b6c96-s175395328-d26788732 | b6c96 (6 blocks, 96 ch) | 2020-11-28 | 9961.9 ± 14.3 | **4,967,720 B (4.74 MiB)** `.txt.gz`; uncompressed 12,411,674 B (verified by download + `gzip -l`) |
| kata1-b10c128-s1141046784-d204142634 | b10c128 (10 blocks, 128 ch) | 2020-11-28 | **11521.7 ± 13.7** | **14,466,254 B (13.79 MiB)** `.txt.gz` |
| kata1-b10c128-s41138688-d27396855 | b10c128 (mid-training) | 2020-11-28 | 10147.6 ± 15.5 | 14,525,424 B `.txt.gz` |

- Larger g170 families also listed (not small): b15c192, b18c384(nbt), b20c256, b28c512, b40c256 etc.
- **Format caveat (verified 2026-09-04):** the g170-imported nets return **HTTP 403 for `.bin.gz`** (e.g. `.../kata1-b6c96-s175395328-d26788732.bin.gz` → 403) and **HTTP 200 for `.txt.gz`** (the older text format). Current-run nets are offered as `.bin.gz` only. KataGo v1.18 still loads `.txt.gz` (README: "name whichever network file you've downloaded to `default_model.bin.gz` (for newer `.bin.gz` models) or `default_model.txt.gz` (for older `.txt.gz` models)").
- `last-modified` on the small-net files: Sat, 28 Nov 2020 20:33 GMT — static for ~6 years; these URLs are stable endpoints.

### Extra/special nets (https://katagotraining.org/extra_networks/, fetched 2026-09-04)

| Net | URL (media.katagotraining.org/uploaded/networks/models_extra/) | HEAD size |
|---|---|---|
| KataGo Human SL (July 2024) | b18c384nbt-humanv0.bin.gz | 99,066,230 B (94.5 MiB) |
| 9x9-trained net | kata9x9-b18c384nbt-20231025.bin.gz | (offered; size not probed) |
| Rectangular-board net | rect15-b20c256-s343365760-d96847752.bin.gz | (offered) |
| Human-trained nets by others | M2-…, fd3.bin.gz, igoh120…, lionffen… | (various, external contributors) |

Note: a 19x19 net still plays 9x9/13x19 acceptably in analysis (KataGo generalizes across board sizes); the 9x9/rect15 nets are "fun extra" specialists, not required for M2's 19/13/9 support.

### Download URL patterns and stability

- Main run: `https://media.katagotraining.org/uploaded/networks/models/kata1/<net-name>.bin.gz` (recent nets) or `.txt.gz` (g170 imports).
- Extra nets: `https://media.katagotraining.org/uploaded/networks/models_extra/<name>.bin.gz`.
- Training-data zips: `https://media.katagotraining.org/uploaded/networks/zips/kata1/<net-name>.zip` (not needed for M2).
- Stability: g170 files unchanged since 2020-11-28 (last-modified verified); katagotraining.org is the canonical host named by every KataGo release ("Download the latest neural nets to use with this engine release at https://katagotraining.org/"). Cloudflare-fronted GCS; HEAD/GET both work from this environment (2026-09-04).

### Checksums

- **katagotraining.org publishes NO checksums for nets** — zero `sha256` occurrences on the networks page HTML (verified by parsing the 498,701-byte page).
- Homebrew's `katago.rb` formula pins sha256 for the three nets it bundles (api.github.com, 2026-09-04) — usable as an independent checksum source for exactly these files:
  - `kata1-b18c384nbt-s9996604416-d4316597426.bin.gz` → `9d7a6afed8ff5b74894727e156f04f0cd36060a24824892008fbb6e0cba51f1d`
  - `g170e-b20c256x2-s5303129600-d1228401921.bin.gz` → `7c8a84ed9ee737e9c7e741a08bf242d63db37b648e7f64942f3a8b1b5101e7c2`
  - `g170-b40c256x2-s5095420928-d1229425124.bin.gz` → `2b3a78981d2b6b5fae1cf8972e01bf3e48d2b291bc5e52ef41c9b65c53d59a71`
  (Formula comment: "Using most recent b18c384nbt rather than strongest as it is easier to track"; the two g170 nets are "final … shouldn't need to be updated".)
- Consequence for M2: for the chosen small net, `fetch-weights.ts` must record GoMentor's own sha256 on first fetch (TOFU) — no upstream hash exists for the b6c96/b10c128 files.

### Net license / redistribution terms

From https://katagotraining.org/network_license/ (captured; page current as of the 2026-09-03 fetch, content quoted):

- Default: "**KataGo Neural Network License**, Copyright 2026 David J Wu ("lightvector")" — MIT-style: "deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, **distribute**, sublicense, and/or sell copies of the Software" — condition: retain copyright + permission notice. Applies to all kata1-run nets.
- **Exceptions**: "The oldest networks imported from prior runs before distributed training began, namely the ones marked … as belonging to the **g170** run, are not covered by the above license but rather are under **CC0** and are effectively public domain."
- zhizi nets: separate MIT-style license, "(c) 2026 hzyhhzy & zhizigo.com".
- Non-"KataGo" contributed nets on extra_networks: covered by their contributors' own terms.
- → **The b6c96 and b10c128 final g170 nets are CC0 (public domain) — the cleanest possible choice for bundling.** No attribution stringency at all. kata1 nets would also be fine (MIT-style + notice).

### Recommendation for the M2 core tier (CPU-Eigen, zero-config)

Bundle **`kata1-b10c128-s1141046784-d204142634.txt.gz`** (final g170 b10c128):
- 13.79 MiB download (fits the ~120MB core tier with room for the ~6MB Eigen exe and configs).
- Site Elo 11521.7 — about **1,560 Elo above** the strongest b6c96 on the same scale, and ~3,000 Elo below the current full-size nets (which are unobtainable for CPU anyway).
- CC0 — zero license friction.
- 6+ years of URL stability (last-modified 2020-11-28).

Alternative when size dominates: **`kata1-b6c96-s175395328-d26788732.txt.gz`** — 4.74 MiB, site Elo 9961.9, also CC0, same stability. Trade-off: ~3x smaller file, ~1,560 Elo weaker.

Both are `.txt.gz`; KataGo v1.18 loads them (README explicitly documents `default_model.txt.gz` for older models). Unverified: any difference in model-load time between txt.gz and bin.gz on Eigen — measure on the reference machine if startup latency matters.

## Caveats / Not Found

- Site "Elo" is KataGo's internal self-play rating scale anchored to reference nets — valid for *relative* net comparison, not convertible to human ranks.
- No upstream checksums for the small nets (only the 3 homebrew-pinned nets above have published hashes anywhere reachable).
- 9x9/13x13 play quality with a 19x19-trained b10/b6 net: qualitatively known to work in KataGo; no quantitative source reachable from this environment to cite.
