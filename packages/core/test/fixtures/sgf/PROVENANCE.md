# SGF Test Fixture Provenance

This directory holds the SGF corpus used to verify that `@gomentor/core`'s SGF
parser round-trips real-world files **byte-for-byte**, including properties it
does not understand.

**65 files are genuine real-world game records**, taken verbatim from the test
suites and data directories of established open-source Go software. They were
downloaded with `curl` / extracted from release tarballs and copied without any
text transformation, so their original bytes — including CRLF/LF mixes, BOMs,
and legacy CJK codepages — are preserved exactly. `.gitattributes` marks
`*.sgf -text -diff` so git will not rewrite them.

**3 files prefixed with `_` are synthetic**, authored specifically for this
repository to exercise parser error paths. They are not game records.

## Licensing summary

Every upstream source below is either MIT or GPL-2.0/GPL-3.0. All are compatible
with this project's GPL-3.0-or-later licence. Nothing here comes from GoGoD, a
commercial joseki database, or any source with unclear or restrictive terms.

| Upstream                                                     | Licence                                                          | Files              |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------ |
| [SabakiHQ/sgf](https://github.com/SabakiHQ/sgf)              | MIT (Copyright 2018-2020 Yichuan Shen)                           | `sabaki-sgf-*` (9) |
| [SabakiHQ/sabaki](https://github.com/SabakiHQ/sabaki)        | MIT (Copyright 2015-2020 Yichuan Shen)                           | `sabaki-app-*` (8) |
| [lightvector/KataGo](https://github.com/lightvector/KataGo)  | MIT (Copyright 2025 David J Wu et al.)                           | `katago-*` (6)     |
| [sanderland/katrain](https://github.com/sanderland/katrain)  | MIT (Copyright 2020 Sander Land et al.)                          | `katrain-*` (6)    |
| [neagle/smartgame](https://github.com/neagle/smartgame)      | MIT (Copyright 2014 Nate Eagle)                                  | `smartgame-*` (2)  |
| [GoGui](https://github.com/Remi-Coulom/gogui) 1.6.0          | GPL-3.0-or-later (Copyright 2001-2014 Markus Enzenberger et al.) | `gogui-*` (11)     |
| [GNU Go 3.8](https://ftp.gnu.org/gnu/gnugo/gnugo-3.8.tar.gz) | GPL-3.0-or-later (Free Software Foundation)                      | `gnugo-*` (23)     |
| This repository                                              | GPL-3.0-or-later, synthetic                                      | `_malformed-*` (3) |

Note on GoGui: `gogui-ff4_ex*.sgf` and `smartgame-simple-example.sgf` derive from
Arno Hollosi's canonical FF[4] specification example (`US[Arno Hollosi]`), which
has circulated as the reference SGF conformance sample for decades and is
redistributed inside both MIT- and GPL-licensed projects. We take our copies from
those projects, so the licence chain is GoGui's GPL-3.0 / smartgame's MIT.
GoGui's copy of `ff4_ex.sgf` was byte-identical to smartgame's `example.sgf`;
the duplicate was dropped.

## Real-world corpus (65 files)

Encoding column reports the **actual bytes** on disk. `CA` reports what the file
_declares_, which is frequently wrong or absent — that mismatch is itself a case
the parser must handle.

### SabakiHQ/sgf — MIT

| File                          | Size   | CA declared | Actual bytes              | Edge case covered                                                                                                                            |
| ----------------------------- | ------ | ----------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sabaki-sgf-chinese.sgf`      | 59 B   | `GB2312`    | **GB2312**                | Non-UTF-8 Chinese comment, correctly declared                                                                                                |
| `sabaki-sgf-japanese.sgf`     | 72 B   | `Shift_JIS` | **Shift-JIS**             | Non-UTF-8 Japanese comment, correctly declared                                                                                               |
| `sabaki-sgf-japanese_bad.sgf` | 99 B   | `MS_KANJI`  | UTF-8 with U+FFFD         | Declared codepage alias `MS_KANJI`; file already mojibaked upstream (contains replacement chars) — decoder must not double-decode            |
| `sabaki-sgf-korean.sgf`       | 63 B   | `EUC-KR`    | **EUC-KR**                | Non-UTF-8 Korean comment                                                                                                                     |
| `sabaki-sgf-nihon-kiin.sgf`   | 252 B  | _(none)_    | **Shift-JIS**             | Real Nihon Ki-in record: no root `;` before first property, undocumented `GK` `LC` `LT` `RD` properties, escaped `\]` inside `TE[]`, no `SZ` |
| `sabaki-sgf-no-ca.sgf`        | 917 B  | _(none)_    | **GB2312-ish, non-UTF-8** | MultiGo 4.2.1 output, no `FF`, no `CA`, CJK comments, variations, `AB`/`AW` setup — encoding must be sniffed                                 |
| `sabaki-sgf-complex.sgf`      | 76 KB  | `UTF-8`     | UTF-8                     | Large heavily-branched Sabaki 0.12.4 tree; CJK comments; both `\]` and `\\` escapes                                                          |
| `sabaki-sgf-utf16le.sgf`      | 3.1 KB | `UTF16LE`   | **UTF-16LE with BOM**     | UTF-16 file — parser must detect BOM before tokenising                                                                                       |
| `sabaki-sgf-utf8bom.sgf`      | 1.6 KB | `UTF-8`     | UTF-8 **with BOM**        | BOM must be stripped but preserved on write                                                                                                  |

### SabakiHQ/sabaki (the editor) — MIT

| File                           | Size   | Edge case covered                                                |
| ------------------------------ | ------ | ---------------------------------------------------------------- |
| `sabaki-app-beginner_game.sgf` | 346 B  | Handicap game with `HA` + `AB` setup stones, `AP[Sabaki:0.33.4]` |
| `sabaki-app-blank_game.sgf`    | 61 B   | Root node only, zero moves — valid but empty tree                |
| `sabaki-app-pro_game.sgf`      | 1.5 KB | Pro record with no `SZ` and no `FF` (both must default)          |
| `sabaki-app-shodan_game.sgf`   | 884 B  | Ordinary linear 19x19 amateur game                               |
| `sabaki-app-corner-9.sgf`      | 51 B   | Minimal 9x9                                                      |
| `sabaki-app-empty-19.sgf`      | 36 B   | Smallest realistic 19x19 file                                    |
| `sabaki-app-endgame-9.sgf`     | 275 B  | 9x9 endgame position                                             |
| `sabaki-app-opening-19.sgf`    | 66 B   | Two-move 19x19 opening                                           |

### lightvector/KataGo — MIT

| File                        | Size  | Edge case covered                                                                          |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| `katago-cornermoves.sgf`    | 114 B | CGoban 3 root with `ST[2]`                                                                 |
| `katago-foxlike.sgf`        | 198 B | FoxWeiqi-style export: CJK player names, `HA`+`AB`, `AP[GNU Go:3.8]` spoofed by the server |
| `katago-humanslbigdiff.sgf` | 562 B | No `FF`, no `CA`, no `AP` — bare move list on one line                                     |
| `katago-messy.sgf`          | 493 B | Deliberately awkward 9x9: `AB`/`AW`, branching, **pass moves**, comments                   |
| `katago-sampletest7x7.sgf`  | 275 B | **7x7 board** with variations (non-standard board size)                                    |
| `katago-sampletest9x9.sgf`  | 576 B | 9x9 with setup stones and variations                                                       |

### sanderland/katrain — MIT

| File                              | Size   | Edge case covered                                                                                                                         |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `katrain-fox-sgf-error.sgf`       | 1.3 KB | Real FoxWeiqi download that upstream flagged as _broken_; CJK, `HA` without matching `AB`                                                 |
| `katrain-fox-sgf-works.sgf`       | 731 B  | The FoxWeiqi variant that parses; useful A/B pair with the above                                                                          |
| `katrain-ls-vs-ag-g4-english.sgf` | 12 KB  | Lee Sedol vs AlphaGo game 4, Sabaki 0.43.3; very long multi-paragraph `C[]` with newlines, `LB` labels                                    |
| `katrain-ogs.sgf`                 | 1.3 KB | OGS export: every move wrapped in its own `(;...)` subtree — deeply nested but linear                                                     |
| `katrain-panda1.sgf`              | 4.1 KB | Pandanet/IGS: undocumented `OS` and `RR` properties, handicap, `TB`/`TW` territory                                                        |
| `katrain-xmgt97.sgf`              | 879 B  | **Verbose long-form property names** (`FileFormat`, `PlayerBlack`, `SiZe`, `Black[..]`) — pre-FF[4] dialect a strict FF[4] parser rejects |

### neagle/smartgame — MIT

| File                                  | Size  | Edge case covered                                                        |
| ------------------------------------- | ----- | ------------------------------------------------------------------------ |
| `smartgame-simple-example.sgf`        | 172 B | Nested variations with tab/newline indentation between nodes             |
| `smartgame-output-simple-example.sgf` | 96 B  | Same tree fully minified — round-trip whitespace-normalisation reference |

### GoGui 1.6.0 — GPL-3.0-or-later

| File                                  | Size   | Edge case covered                                                                                                                                                                                   |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gogui-ff4_ex.sgf`                    | 4.9 KB | Arno Hollosi's FF[4] conformance sample: nearly every standard property (`LB TR MA SQ AR LN DD SL VW TB TW GB BM TE DO IT`), variations, **pass moves** `B[]`/`W[]`, and both `\]` and `\\` escapes |
| `gogui-ff4_ex-1.sgf`                  | 3.8 KB | Second game tree of the same collection, split out                                                                                                                                                  |
| `gogui-ff4_ex-2.sgf`                  | 1.2 KB | Third tree — collection with multiple root nodes                                                                                                                                                    |
| `gogui-verbose-property-names.sgf`    | 10 KB  | 1995 Bracknell tournament record in long-form property names (`GaMe`, `PlayerBlack`, `Comment`) with `\[`/`\]` escapes inside comments                                                              |
| `gogui-time-settings-unknown-ot.sgf`  | 108 B  | `OT[8 xyz 16]` in an unrecognised overtime format, plus a literal escaped `OT[8 xyz 16\]` inside a comment                                                                                          |
| `gogui-invalidmove.sgf`               | 83 B   | 9x9 board containing move `B[rs]` — **off-board coordinate**, must not crash                                                                                                                        |
| `gogui-size-after-invalid-points.sgf` | 22 B   | `AB`/`AW` appear _before_ `SZ[9]`, and reference points outside it — property-order dependency                                                                                                      |
| `gogui-size-after-valid-points.sgf`   | 23 B   | Same shape with `SZ[19]`; A/B pair with the above                                                                                                                                                   |
| `gogui-human-readable.sgf`            | 56 B   | Moves written as `B[R16]`, `W[Pass]` — human coordinate notation, not SGF point notation                                                                                                            |
| `gogui-adapter-test.sgf`              | 84 B   | `CA[UTF8]` spelled without the hyphen                                                                                                                                                               |
| `gogui-statistics-game-1.sgf`         | 79 B   | Tiny GoGui-generated 9x9                                                                                                                                                                            |

### GNU Go 3.8 — GPL-3.0-or-later

Chosen from GNU Go's 1,765-file regression corpus to maximise editor and
encoding diversity. Each file's `AP[]` identifies a different real SGF writer.

| File                                   | Size   | Actual bytes                      | Edge case covered                                                                         |
| -------------------------------------- | ------ | --------------------------------- | ----------------------------------------------------------------------------------------- |
| `gnugo-9handicap-glgo-latin1.sgf`      | 2.5 KB | **non-UTF-8**                     | 9-stone handicap (`HA[9]` + 9 `AB` points), glGo 1.1, single-byte high chars in `PW[]`    |
| `gnugo-tg-gg-manyfaces-latin1.sgf`     | 2.3 KB | **Latin-1**                       | Many Faces of Go 10.0, French comment with `é` as raw 0xE9, `VW[]`                        |
| `gnugo-nicklas12-latin1.sgf`           | 2.2 KB | **Latin-1**                       | `FF[3]`, Swedish `ö` as raw 0xF6 in a chat-log comment                                    |
| `gnugo-trevor42-jago-cjk-nonutf8.sgf`  | 2.8 KB | **non-UTF-8 (GB2312/Big5-range)** | Jago 4.18, CJK score comment in a legacy double-byte codepage with no `CA` declared       |
| `gnugo-gifu2006-aya-cgoban3-jp.sgf`    | 1.6 KB | UTF-8                             | CGoban 3, Japanese comments, **pass moves**                                               |
| `gnugo-gifu2006-gorimu-cgoban3-jp.sgf` | 2.9 KB | UTF-8                             | CGoban 3, longer Japanese commentary                                                      |
| `gnugo-fsgcbot-dr-cgoban2-esc.sgf`     | 6.9 KB | ASCII                             | CGoban 2 KGS log: variations, passes, `TB`/`TW`, escaped `\]` in chat comments            |
| `gnugo-kgs-20050407-tfujii.sgf`        | 2.9 KB | ASCII                             | KGS game with escaped `\]` inside comments, passes, territory marks                       |
| `gnugo-nodan-guno-cgoban2-9x9.sgf`     | 1.9 KB | ASCII                             | **9x9** handicap, `AB`, passes, `TB`/`TW`, escapes                                        |
| `gnugo-crazystone1-twogtp-9x9.sgf`     | 760 B  | ASCII                             | `CA[ISO8859_1]` declared on a pure-ASCII file; comment contains `Result[Black\]:` escapes |
| `gnugo-owl18-13x13-var.sgf`            | 2.3 KB | ASCII                             | **13x13**, `FF[3]`, variations, undocumented `SY[]` (Cgoban 1.x signature)                |
| `gnugo-incident96-13x13-lb.sgf`        | 803 B  | ASCII                             | **13x13** handicap with `AB` and `LB` labels                                              |
| `gnugo-reading36-manyfaces.sgf`        | 365 B  | ASCII                             | **13x13**, `FF[3]`, empty `VW[]`, Many Faces of Go 11.0                                   |
| `gnugo-9x9-1-pass.sgf`                 | 452 B  | ASCII                             | **9x9** with `HA[0]` and trailing passes                                                  |
| `gnugo-9x9-4-qgo-var.sgf`              | 436 B  | ASCII                             | **9x9** qGo 1.0.4 output with variations                                                  |
| `gnugo-bitti-ggo-9x9-tbtw.sgf`         | 723 B  | ASCII                             | **9x9** gGo 1.0, handicap, `TB`/`TW` scoring marks                                        |
| `gnugo-connection2-sgfc.sgf`           | 1.7 KB | ASCII                             | Output of **SGFC 1.13b**, the reference SGF sanitiser — canonical well-formed shape       |
| `gnugo-ko6-jago.sgf`                   | 264 B  | ASCII                             | Setup-only position: 19 `AB` + 34 `AW` points, no moves at all                            |
| `gnugo-cgf2005-aya.sgf`                | 1.9 KB | ASCII                             | Aya 5.56, no `FF` property, **two sibling `C[]` on the root node** (duplicate property)   |
| `gnugo-gifu2005-aya-nngs.sgf`          | 1.9 KB | ASCII                             | NNGS 1.1.18 server export                                                                 |
| `gnugo-joseki-hoshi-keima-var.sgf`     | 15 KB  | ASCII                             | Joseki tree: deep branching with `LB`/`MA` annotations at nearly every node, `FF[3]`      |
| `gnugo-joseki-sansan-var.sgf`          | 1.2 KB | ASCII                             | Smaller 3-3 joseki branching tree                                                         |
| `gnugo-dublin2-var-tbtw.sgf`           | 4.5 KB | ASCII                             | `FF[3]`, `SY[Cgoban 1.9.11]` unknown property, variations, `TB`/`TW`                      |

## Synthetic error-path files (3 files) — authored here, not real records

These are **not** game records and carry no upstream provenance. They exist to
pin down parser behaviour on invalid input.

| File                       | Size  | What it tests                                                                                 |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `_malformed-truncated.sgf` | 92 B  | File ends inside an unterminated `C[` property value, tree never closed                       |
| `_malformed-empty.sgf`     | 0 B   | Zero-byte file                                                                                |
| `_malformed-not-sgf.sgf`   | 186 B | Control bytes, a PNG magic header, invalid UTF-8 sequences, and prose — no game tree anywhere |

## Coverage matrix

| Dimension                                 | Status  | Files                                                                                                                                                                                       |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19x19                                     | Covered | 40 files                                                                                                                                                                                    |
| 13x13                                     | Covered | `gnugo-owl18-13x13-var`, `gnugo-incident96-13x13-lb`, `gnugo-reading36-manyfaces`                                                                                                           |
| 9x9                                       | Covered | 13 files incl. `katago-messy`, `gnugo-nodan-guno-cgoban2-9x9`                                                                                                                               |
| Other board sizes                         | Covered | `katago-sampletest7x7` (7x7)                                                                                                                                                                |
| Missing `SZ` (must default)               | Covered | 11 files incl. `sabaki-app-pro_game`, `katrain-xmgt97`                                                                                                                                      |
| Branching variations                      | Covered | 17 files; deepest are `sabaki-sgf-complex`, `gnugo-joseki-hoshi-keima-var`, `katrain-ogs`                                                                                                   |
| Pass moves `B[]`/`W[]`                    | Covered | 8 files incl. `gogui-ff4_ex`, `katago-messy`, `gnugo-9x9-1-pass`                                                                                                                            |
| Escaped `\]` in values                    | Covered | 10 files                                                                                                                                                                                    |
| Escaped `\\` in values                    | Covered | `gogui-ff4_ex`, `gogui-ff4_ex-1`, `sabaki-sgf-complex`                                                                                                                                      |
| CJK comments/names                        | Covered | 6 files (JP, ZH, KO)                                                                                                                                                                        |
| Handicap `HA` + `AB`/`AW`                 | Covered | 18 with `HA`, 16 with `AB`, 8 with `AW`                                                                                                                                                     |
| Setup-only (no moves)                     | Covered | `gnugo-ko6-jago`, `gogui-size-after-*`                                                                                                                                                      |
| `CA[UTF-8]` declared                      | Covered | 20+ files                                                                                                                                                                                   |
| UTF-8 BOM                                 | Covered | `sabaki-sgf-utf8bom`                                                                                                                                                                        |
| UTF-16LE + BOM                            | Covered | `sabaki-sgf-utf16le`                                                                                                                                                                        |
| Non-UTF-8 legacy codepages                | Covered | GB2312, Shift-JIS, EUC-KR, Latin-1 — see list below                                                                                                                                         |
| Undocumented / editor-specific properties | Covered | `GK LC LT RD` (Nihon Ki-in), `SY` (Cgoban 1.x), `OS RR` (Pandanet), long-form names (`GaMe`, `PlayerBlack`)                                                                                 |
| Distinct `AP[]` writers                   | Covered | 16 distinct: Sabaki, CGoban 2/3, GoGui, GNU Go, Jago, glGo, gGo, qGo, MultiGo, Many Faces of Go 10 & 11, Aya, NNGS, SGFC, TwoGtp, Primiview, foxwq — 23 counting version strings separately |
| Malformed-but-recoverable real files      | Covered | `katrain-fox-sgf-error`, `sabaki-sgf-japanese_bad`, `sabaki-sgf-nihon-kiin`, `gogui-invalidmove`, `gogui-size-after-invalid-points`, `katrain-xmgt97`, `gnugo-cgf2005-aya`                  |
| Deliberately broken (error paths)         | Covered | the three `_malformed-*` files                                                                                                                                                              |

### Known gaps

- **No `FF[1]` / `FF[2]` files.** The oldest dialect present is `FF[3]`, plus the
  unnumbered long-form-property files (`katrain-xmgt97`,
  `gogui-verbose-property-names`) which are effectively pre-FF[4].
- **No non-Go games.** Every file is `GM[1]`. Chess/backgammon SGF variants
  (`GM[6]` etc.) are not represented; out of scope for this project.
- **No KataGo/LizzieYzy analysis-annotated file.** KataGo writes analysis into
  `C[]` rather than custom properties, and no permissively-licensed fixture
  containing an SGF with KataGo review data (e.g. `KT`-style vendor properties)
  was found. Editor-specific _unknown_ properties are still covered via
  Nihon Ki-in, Cgoban, and Pandanet files above.
- **No UTF-16BE file.** Only UTF-16LE is represented.
- **No rectangular board (`SZ[19:13]`).** No real-world example located in a
  permissively-licensed corpus.

### Non-UTF-8 files (parser must not assume UTF-8)

| File                                  | Actual encoding                  | Declared `CA`         |
| ------------------------------------- | -------------------------------- | --------------------- |
| `sabaki-sgf-chinese.sgf`              | GB2312                           | `GB2312`              |
| `sabaki-sgf-japanese.sgf`             | Shift-JIS                        | `Shift_JIS`           |
| `sabaki-sgf-korean.sgf`               | EUC-KR                           | `EUC-KR`              |
| `sabaki-sgf-nihon-kiin.sgf`           | Shift-JIS                        | _(none — must sniff)_ |
| `sabaki-sgf-no-ca.sgf`                | GB2312-range double-byte         | _(none — must sniff)_ |
| `sabaki-sgf-utf16le.sgf`              | UTF-16LE (BOM)                   | `UTF16LE`             |
| `gnugo-9handicap-glgo-latin1.sgf`     | single-byte high chars (Latin-1) | _(none)_              |
| `gnugo-tg-gg-manyfaces-latin1.sgf`    | Latin-1                          | _(none)_              |
| `gnugo-nicklas12-latin1.sgf`          | Latin-1                          | _(none)_              |
| `gnugo-trevor42-jago-cjk-nonutf8.sgf` | GB2312/Big5-range double-byte    | _(none)_              |
| `_malformed-not-sgf.sgf`              | invalid UTF-8 by construction    | n/a (synthetic)       |

`sabaki-sgf-utf8bom.sgf` is valid UTF-8 but carries a BOM, which a naive reader
will surface as a stray U+FEFF before the opening `(`.

## Sources deliberately skipped

| Source                                                 | Reason                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GoGoD (Games of Go on Disk)                            | Commercial collection with restrictive redistribution terms — excluded on the project's instruction.                                                              |
| Any commercial joseki dictionary or paid game database | Restrictive terms.                                                                                                                                                |
| Wikimedia Commons                                      | Commons runs MIME search in "miser mode" and returned no SGF attachments; nothing usable was located, so nothing was taken.                                       |
| Sensei's Library                                       | Not needed once MIT/GPL library fixtures gave sufficient coverage; the site's Open Content Licence obligations were therefore not worth incurring.                |
| Fox Weiqi / OGS / KGS scraped directly                 | Not scraped. The Fox, OGS, and Pandanet-format records here come second-hand from KaTrain's MIT-licensed test data, whose redistribution is explicitly permitted. |
| GitHub code search for stray `.sgf` files              | Requires authentication (HTTP 401 unauthenticated), and individual files found that way rarely carry an identifiable licence.                                     |
