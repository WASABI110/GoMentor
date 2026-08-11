# `resources/knowledge`

Empty in M1. The curated joseki and teaching corpus lands here.

Unlike [`katago`](../katago/README.md) and [`weights`](../weights/README.md), this is **authored content, not a download** — it ships in the repository and there is deliberately no `fetch-knowledge.ts`.

The retrieval design it serves (M3) is BM25 plus a Zobrist pattern index rather than vector search. Embeddings would mean roughly +100MB and a second inference path for marginal gain on a corpus of a few thousand curated entries, and "what joseki is this corner" is a _deterministic pattern match_ rather than a text search. BM25 also stays debuggable, which matters for content a teacher is quoting to a student.

## Why this file exists rather than a `.gitkeep`

See [`../katago/README.md`](../katago/README.md). electron-builder silently copies nothing for a missing `extraResources` source, and ignores `.gitkeep`. `scripts/test/resources.test.ts` fails if it goes missing.
