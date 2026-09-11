# STARmem

A SillyTavern third-party extension that gives chats persistent, structured
memory. An LLM extracts durable facts from the conversation on the write path;
retrieval back into the prompt is fully deterministic—BM25 and typed-graph
traversal, with no LLM call and no embedding call on the query path. Every
retrieval produces a replayable trace, and the built-in Memory Viewer (five
tabs) surfaces entries, graph, and traces.

Current version: 2.0.5.

![STARmem Memory Viewer](docs/screenshots/viewer.png)

## How it works

**Write path.** Each assistant reply is captured as a working entry in a hot
buffer (character greetings are skipped; inline reasoning/CoT blocks are
stripped before capture). When the buffer reaches 10 entries, or after 60
seconds of silence, one batched LLM call extracts durable facts as episodic
entries—each with a subject, tags, and lifecycle metadata—deduplicates them
against the store (same subject plus Jaccard ≥ 0.7 updates the existing entry
instead of inserting), and builds typed graph edges (`mentions`, `supports`,
`same_topic`, `temporal_next`). All state mutation is serialized by a
per-chat write lock.

**Retrieval path.** Before each generation, the interceptor retrieves relevant
memories and injects them through a fixed ladder:

1. **Tier 0**—exact-match cache (FNV-1a keyed, 200 entries).
2. **Tier 1**—Jaccard fuzzy cache (threshold 0.6).
3. **Tier 2**—BM25+ over all non-working entries. Seed-only: its top 3
   candidates seed Tier 3; it never resolves a query by itself.
4. **Tier 3**—MAGMA-lite beam expansion over the typed graph (up to 2 hops,
   beam width 5), rescored by BM25, importance, recency, and maturity boost.
5. **Floor**—recency-weighted fallback (recency × importance × maturity
   boost) when everything above misses.

Working-buffer entries are always prepended to the result. Each retrieval
appends exactly one trace to a 128-entry ring buffer, inspectable—and
exportable as JSONL—in the Memory Viewer's Traces tab.

**Embeddings, precisely scoped.** The retrieval query path is embedding-free
and LLM-free. The one exception is the Persona rebuild pipeline, which uses
SillyTavern's Vectors API for its k-NN clustering stage.

**Persona scope.** Episodic facts about a subject can be rebuilt—only on
explicit request from the Memory Viewer, never automatically—into distilled
persona entries via a RAPTOR-style pipeline: k-NN graph (ST Vectors
embeddings), Leiden clustering, LLM cluster summaries, atomic replacement.

## Memory scopes

| Scope | Role |
| --- | --- |
| `working` | Hot buffer of recent assistant replies; drained by consolidation. |
| `episodic` | Long-term durable facts; the main retrieval corpus. |
| `persona` | Distilled per-subject summaries; rebuilt manually. |

The typed graph is infrastructure over entries, not a fourth memory. All state
lives in `chatMetadata['STARmem']`—no sidecar files; it rides SillyTavern's
native chat-file backup.

## Configuration

The STARmem panel lives in SillyTavern's Extensions tab (a collapsible
drawer). Half its controls are live; the rest are persisted but not yet read
at runtime.

**Live controls:**

| Control | Effect |
| --- | --- |
| Connection profile | ST connection profile supplying the extraction LLM (write path only). |
| Extraction model label | Provenance label recorded on extracted entries. |
| Injection mode | `automatic` (inject via `setExtensionPrompt`), `macro` (you place `{{starmem-memories}}` in your preset), or `off`. |
| Position / Depth / Role | Where the automatic-mode memory block lands (in-chat or in-prompt, depth 0–10, system/user/assistant). |
| Scorer | Retrieval ranking function; only `default` is currently offered. |

**Currently inert controls** (persisted and validated, but no runtime code
reads them—the effective values are hardcoded constants):

| Control | Actual behavior |
| --- | --- |
| Buffer size | Consolidation always triggers at 10 entries. |
| Idle timeout | Always 60 seconds. |
| Trace limit | Ring buffer always capped at 128. |
| Debug mode | Not connected to the logger. |
| Embeddings profile | Persona rebuild uses the main connection profile. |

Details: [integration reference](docs/reference/integration.md) and the
[drift register](docs/reference/drift-register.md).

## Requirements

- SillyTavern with the standard third-party extension surface (extension
  settings, generate interceptors, connection-manager profiles). No runtime
  dependencies; no build step.
- LLM-backed consolidation requires a connection profile configured in ST's
  Connection Manager. Without one, chat capture still works but consolidation
  cannot run—the settings panel warns about this.
- Persona rebuild additionally requires ST's Vectors extension (embeddings).

## Install

In SillyTavern:

1. Click the Extensions icon (puzzle piece, top bar).
2. Click "Install Extension" (top right of the Extensions panel).
3. Paste this URL: `https://github.com/EvaL3n4/SillyTavern-STARmem`
4. Click "Install".

For a local clone (development) and dev tooling, see
[`docs/install.md`](docs/install.md).

## Documentation

- [Reference docs](docs/reference/README.md)—the code-truth reference set;
  every factual claim cites `file:line`.
- [Drift register](docs/reference/drift-register.md)—known divergences
  between the design spec and the shipped code.
- [Design spec](docs/specs/2026-04-20-starmem-v2-design.md)—the approved
  design-of-record (with an errata note pointing at the drift register).
- [Install guide](docs/install.md)—both install paths in detail.
- [Benchmarks](docs/reference/bench.md)—the local harness (`npm run bench`)
  and the Python/Modal remote sweep story.
- [Research wiki](docs/wiki/)—paper-by-paper notes on adopted and rejected
  approaches.

## Citations

STARmem's design draws on published research:

**Adopted:**

- **ByteRover**—Nguyen et al. 2026, [arXiv:2604.01599](https://arxiv.org/abs/2604.01599)—substrate
  design (Context Tree, lifecycle metadata, tiered retrieval)
- **AdaMem**—Yan et al. 2026, [arXiv:2603.16496](https://arxiv.org/abs/2603.16496)—Working/Episodic/Persona
  vocabulary
- **MAGMA**—Jiang et al. 2026, [arXiv:2601.03236](https://arxiv.org/abs/2601.03236)—intent-routed
  graph expansion
- **Enhanced RAPTOR**—Liu et al. 2026, [DOI:10.3389/fcomp.2025.1710121](https://doi.org/10.3389/fcomp.2025.1710121)—Persona
  rebuild pipeline
- **RAPTOR**—Sarthi et al. 2024, [arXiv:2401.18059](https://arxiv.org/abs/2401.18059)—recursive
  abstractive tree

**Evaluated, not adopted:**

- **A-MEM**—Xu et al. 2025, [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)—too weak on multi-hop for roleplay
- **Zep / Graphiti**—Rasmussen et al. 2025, [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)—full KG engine is overkill at chat scale

## Contributions

Thank you to [adrenalvapor](https://github.com/adrenalvapor) for suggesting changes and live testing the SillyTavern implementation!

## License

Apache License 2.0—see [LICENSE](LICENSE).
