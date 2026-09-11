# Runtime constants and tunables

Every runtime tunable STARmem v2 ships: where it is defined, what value it holds, who consumes it, and whether that consumption is actually reachable in production. This page is the cross-cutting catalog—the per-domain pages explain behavior; this page pins numbers. Two files define them all: `src/core/constants.js` (spec-derived engine values plus the benchmark override mechanism) and `src/integration/constants.js` (UI-scoped integration values). The spec's latency budgets are design targets only and are **not** encoded anywhere in `src/`—see [Latency budgets](#latency-budgets) below.

Source: `src/core/constants.js`, `src/integration/constants.js`. Consumer lists were derived by grepping `src/` and `bench/` for every constant name; behavior is confirmed against `tests/unit/core/constants.test.js:51-115` and `tests/unit/integration/constants.test.js`.

## Status vocabulary

Every constant below carries one or two statuses from this list:

| Status | Meaning |
| --- | --- |
| **Live** | Read at runtime in a production path. |
| **Swept** | Listed in `_SWEPT_RETRIEVAL_KEYS` / `_SWEPT_CONSOLIDATION_KEYS` (`src/core/constants.js:189-201`, `:204-215`)—overridable via `setConstantOverrides` at benchmark time and read at call time. The sole production consumer of the override mechanism is `bench/runner.js:97` (plus the bench warmup harness, `bench/harness/_modal-warmup-point.js:127`); nothing in `src/` may call it. |
| **Frozen** | The containing object is frozen at module load—the constant cannot be mutated at all. |
| **Inert** | Defined (and sometimes persisted or exported) but no runtime consumer reaches it—behaves as if it did not exist. |

The statuses are not exclusive: a constant can be both **Live** and **Swept** (a production path reads it at call time *and* the sweep driver can override it). `RETRIEVAL` and `CONSOLIDATION` are deliberately *not* frozen because `setConstantOverrides` mutates them in place (`constants.js:52-58`, `:104-109`); their non-swept keys are read-only by convention only. Group-level Frozen/Live/Inert status is noted per table.

### The sweep mechanism and the call-time-read rule

Overrides are only observable to code that reads `RETRIEVAL.X` / `CONSOLIDATION.X` at call time. Module-top destructuring (`const { TIER3_LAMBDA_1 } = RETRIEVAL`) snapshots the import-time value and silently bypasses overrides. The guard test `tests/unit/core/swept-constants-overridable.test.js:75-100` walks every `src/` file (minus `constants.js` itself), strips comments, and fails on any destructured swept key; round-trip and partial-rollback behavior are asserted at `:111-198`. Non-swept keys *may* be destructured—`src/retrieval/tier1-fuzzy.js:13` and `src/retrieval/bm25.js:13` do exactly that.

One stale comment in the guard test's own header: `swept-constants-overridable.test.js:16-18` lists `BATCH_SIZE` among "non-swept keys", but `BATCH_SIZE` **is** in `_SWEPT_CONSOLIDATION_KEYS` (`constants.js:206`) and the test itself overrides it (`:152-158`). The code is the truth: it is swept.

## Enumerations (`src/core/constants.js:10-22`)

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `SCOPES` | `['working', 'episodic', 'persona']` | `constants.js:10` | `isScope`—`src/core/schema.js:100` (used by entry construction/validation, `src/memory/entry.js`) | Frozen, Live |
| `EDGE_TYPES` | `{ PRODUCED: ['mentions', 'supports', 'same_topic', 'temporal_next'], RESERVED: ['contradicts'] }` | `constants.js:13-16` | `ALL_EDGE_TYPES`—`src/core/schema.js:93-95`; relation-type guard `src/consolidation/extractFacts.js:185` | Frozen, Live |
| `QUERY_INTENTS` | `['factual', 'relational', 'temporal']` | `constants.js:19` | **None.** The classifier hardcodes its own regex lists (`src/retrieval/classifier.js:13-31`); only the test suite imports this constant | Frozen, **Inert** |
| `MATURITY_TIERS` | `['draft', 'validated', 'core']` | `constants.js:22` | `isMaturity`—`src/core/schema.js:105` | Frozen, Live |

`QUERY_INTENTS` is unwired-in-production: the classifier returns the same three intent strings, but as inline literals, not from this constant. See drift #13 in the [drift register](./drift-register.md).

## Lifecycle (`LIFECYCLE`, `src/core/constants.js:25-50`)

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `ACCESS_BONUS` | `3` | `constants.js:27` | `applyAccessEvent`—`src/lifecycle/importance.js:42`; called from the ladder for every returned entry, `src/retrieval/ladder.js:78` | Live |
| `UPDATE_BONUS` | `5` | `constants.js:29` | `applyUpdateEvent`—`src/lifecycle/importance.js:58`; called from the dedup-update path, `src/consolidation/consolidate.js:217` | Live |
| `DAILY_DECAY` | `0.995` | `constants.js:31` | `applyDailyDecay`—`src/lifecycle/importance.js:78`; **`applyDailyDecay` has no production caller** | Inert |
| `RECENCY_TAU_DAYS` | `30` | `constants.js:33` | `recencyAt` default—`src/lifecycle/recency.js:38`; consumed by Tier 2 (`src/retrieval/tier2-bm25.js:71`), the default scorer (`src/retrieval/scorer.js:47`), the floor (`src/retrieval/floor.js:27`), and the episodic viewer tab (`src/integration/viewer/tabs/episodic.js:108,214`) | Live |
| `MATURITY_BOOST` | draft `0.85`, validated `1.0`, core `1.2` | `constants.js:35-39` | `maturityBoost`—`src/lifecycle/maturity.js:66`; consumed by Tier 2 (`tier2-bm25.js:72`), the default scorer (`scorer.js:48`), and the floor | Live—but in v2.0 always resolves to the draft value `0.85`, because `maturityFor` never promotes anything (drift #4) |
| `PROMOTION.draftToValidated` / `.validatedToCore` | `65` / `85` | `constants.js:41-44` | `maturityFor`—`src/lifecycle/maturity.js:43,45`; **`maturityFor` has no production caller** | Inert |
| `DEMOTION.validatedToDraft` / `.coreToValidated` | `35` / `60` | `constants.js:46-49` | `maturityFor`—`maturity.js:46,49`; no production caller | Inert |

Net effect: importance moves (+3 access, +5 update) but never decays, and no entry's maturity ever leaves `draft`—see [lifecycle](./lifecycle.md) and drift #4.

## Retrieval (`RETRIEVAL`, `src/core/constants.js:59-89`)

Group is **not frozen** (sweep mechanism). All swept rows are read at call time in their consumers.

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `FUZZY_JACCARD_THRESHOLD` | `0.6` | `constants.js:61` | Tier 1 gate—`src/retrieval/tier1-fuzzy.js:13` (module-top destructure, legal: not swept), `:80` | Live |
| `TIER3_LAMBDA_1` | `1.0` | `constants.js:63` | Beam score `exp(λ₁·edgeWeight + λ₂·bm25)`—`src/retrieval/tier3-graph.js:75` | Live, Swept |
| `TIER3_LAMBDA_2` | `0.3` | `constants.js:64` | `tier3-graph.js:75` | Live, Swept |
| `TIER3_MAX_HOPS` | `2` | `constants.js:66` | Hop loop—`tier3-graph.js:59` | Live, Swept |
| `BM25_K1` | `1.2` | `constants.js:68` | BM25+ saturation—`src/retrieval/bm25.js:13` (destructure), `:107` | Live |
| `BM25_B` | `0.75` | `constants.js:70` | BM25+ length normalization—`bm25.js:106-107` | Live |
| `BM25_DELTA` | `1.0` | `constants.js:72` | BM25+ lower bound (Lv & Zhai 2011)—`bm25.js:107` | Live |
| `SUBJECT_BOOST` | `2` | `constants.js:74` | Subject-token replication in the BM25 document—`bm25.js:62` | Live, Swept |
| `TAG_BOOST` | `2` | `constants.js:76` | Tag-token replication—`bm25.js:63` | Live, Swept |
| `TIER_CACHE_MAX_ENTRIES` | `200` | `constants.js:78` | Cache eviction—`src/retrieval/tier0-exact.js:98`, `tier1-fuzzy.js:110` | Live, Swept |
| `TIER3_SEEDS_K` | `3` | `constants.js:80` | Tier 2 top-K seeds—`src/retrieval/ladder.js:205` | Live, Swept |
| `TIER3_BEAM_WIDTH` | `5` | `constants.js:82` | Per-hop beam slice—`tier3-graph.js:81` | Live, Swept |
| `EDGE_CAP_PER_ENTRY` | `20` | `constants.js:84` | Edge cap + eviction—`src/memory/edgeBuilder.js:118` | Live, Swept |
| `EXPLICIT_RELATION_WEIGHT` | `1.0` | `constants.js:86` | `@relations` edge weight—`edgeBuilder.js:64` | Live, Swept |
| `COOCCURRENCE_WEIGHT` | `0.5` | `constants.js:88` | Co-occurrence edge weight—`edgeBuilder.js:84` | Live, Swept |

## Edge-type × intent weights (`EDGE_TYPE_WEIGHTS`, `src/core/constants.js:96-102`)

Frozen. Fifteen values (five edge types × three intents), consumed at the Tier 3 expansion step—`src/retrieval/tier3-graph.js:11,72`:

| Edge type | factual | relational | temporal |
| --- | --- | --- | --- |
| `supports` | `0.9` | `0.5` | `0.3` |
| `mentions` | `0.7` | `0.9` | `0.3` |
| `same_topic` | `0.5` | `0.8` | `0.5` |
| `temporal_next` | `0.3` | `0.4` | `0.9` |
| `contradicts` | `0.2` | `0.3` | `0.2` |

The `contradicts` row is **dormant**: included for completeness, but the v2.0 edge builder never emits that type (`constants.js:93-95`).

## Consolidation (`CONSOLIDATION`, `src/core/constants.js:110-135`)

Group is **not frozen** (sweep mechanism).

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `WORKING_BUFFER_THRESHOLD` | `10` | `constants.js:112` | Buffer trigger gate—`src/consolidation/triggers.js:59` | Live, Swept (must be swept together with `BATCH_SIZE`—`constants.js:207-213`) |
| `IDLE_TRIGGER_SECONDS` | `60` | `constants.js:114` | Idle timer—`triggers.js:28` (destructure, legal: not swept), `:87` (× 1000 → ms) | Live |
| `BATCH_SIZE` | `5` | `constants.js:116` | Batch drain `min(BATCH_SIZE, buffer.length)`—`src/consolidation/consolidate.js:114`; also read by the bench warmup harness (`bench/harness/fireworks-warmup.js:280,336,369`) | Live, Swept |
| `PERSONA_REBUILD_SUGGESTION_THRESHOLD` | `100` | `constants.js:118` | Suggestion flag—`consolidate.js:54` (destructure, not swept), `:244` | Live |
| `DEDUP_JACCARD_THRESHOLD` | `0.7` | `constants.js:120` | Same-subject merge gate—`src/consolidation/dedup.js:55` | Live, Swept |
| `EXTRACT_MAX_TOKENS` | `4096` | `constants.js:134` | LLM call—`src/consolidation/extractFacts.js:259`; also the bench warmup (`bench/harness/fireworks-warmup.js:290,368`) | Live, Swept |

`EXTRACT_MAX_TOKENS` history: amended 2048 → 4096 by Phase 14 Task 6 as a correctness fix (truncated responses failed cache-replay parsing on dense LongMemEval-S batches); the on-disk rationale is in the constant's docstring (`constants.js:121-133`) and the sweep note (`docs/bench/sweeps/2026-04-29-longmemeval-extract-max-tokens-live.md`).

Note the coincidence that can mislead: the inert setting `SETTINGS_DEFAULTS.idleTimeout` defaults to `60_000` ms, which matches `IDLE_TRIGGER_SECONDS = 60`—but no code connects them (drift #3).

## Persona rebuild (`PERSONA_REBUILD`, `src/core/constants.js:138-159`)

Group is frozen. These parameters run only on the manual Persona rebuild path—never automatic (drift #9), never on the retrieval query path.

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `K_BASE` | `15` | `constants.js:140` | k-NN neighbor count—`src/consolidation/raptor/knn.js:21` (destructure), `:45` | Live |
| `K_STEP` | `5` | `constants.js:142` | Per-layer increment—`knn.js:45` | Live |
| `GAMMA_BASE` | `1.0` | `constants.js:144` | Leiden resolution schedule `max(0.01, γ_base − depth·γ_step)`—`src/consolidation/raptor/leiden.js:582,599` | Live |
| `GAMMA_STEP` | `0.2` | `constants.js:146` | `leiden.js:583,599` | Live |
| `MAX_DEPTH` | `3` | `constants.js:148` | Tree depth loop—`src/consolidation/personaRebuild.js:38,121` | Live |
| `MIN_CLUSTER_SIZE` | `2` | `constants.js:150` | Clustering precondition `>= 2 × this`—`personaRebuild.js:38,123` | Live |
| `LEIDEN_TOLERANCE` | `1e-6` | `constants.js:152` | Convergence break—`leiden.js:584,687` | Live |
| `LEIDEN_MAX_OUTER_ITERATIONS` | `32` | `constants.js:154` | Outer-iteration safety cap—`leiden.js:585,661` | Live |
| `SUMMARY_MAX_TOKENS` | `512` | `constants.js:156` | Cluster summarization LLM call—`src/consolidation/raptor/summarize.js:15,90` | Live |
| `SYNTHETIC_EMBEDDING_DIM` | `16` | `constants.js:158` | `syntheticEmbedding`—`src/consolidation/raptor/embeddings.js:20,68`; the deterministic in-memory test/bench client. Production embedding dimension is provider-dependent | Live (test/bench client only) |

## Trace (`TRACE_BUFFER_CAP`, `src/core/constants.js:162`)

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `TRACE_BUFFER_CAP` | `128` | `constants.js:162` | Ring-buffer eviction—`src/retrieval/trace.js:46` (all retrieval traces); asserted by `tests/unit/retrieval/trace.test.js:57-62` | Live |

The spec puts the ring at 100 (`docs/specs/2026-04-20-starmem-v2-design.md` §9.1); 128 is the recorded resolution of the spec's §12.4 "make configurable" item—drift #6.

## Latency budgets

The spec's per-tier latency budgets—Tier 0 <1ms, Tier 1 <5ms, Tier 2 <50ms, Tier 3 <100ms, Floor <5ms (`docs/specs/2026-04-20-starmem-v2-design.md:109-113`)—are **not encoded anywhere in `src/`**. No constant, assertion, or runtime check references them; the only traces in code are docstring mentions of the Tier 0 target (`src/retrieval/tier0-exact.js:3`) and the Tier 1 target (`src/retrieval/tier1-fuzzy.js:4`, `<5ms: O(cacheSize × avgTokens)`). They are design targets that live in the spec (and, historically, in bench p50/p95 columns), not runtime tunables. Also note the spec's Tier 2 row at `:111` still describes tau-based resolution, which no longer exists (drift #1).

## Integration constants (`src/integration/constants.js`)

### Identity and injection

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `SETTINGS_KEY` | `'STARmem'` | `integration/constants.js:9` | `extension_settings` slot—`src/integration/settings.js:171,175,192,203` | Live |
| `SETTINGS_SCHEMA_VERSION` | `1` | `:12` | **None in production**—`settings.js:91-93` compares `SETTINGS_DEFAULTS.schemaVersion` instead; only tests import the constant | Inert |
| `INJECTION_PROMPT_KEY` | `'STARmem'` | `:19` | `setExtensionPrompt` slot key—`src/integration/interceptor.js:162` | Live |
| `INJECTION_DEPTH` | `4` | `:27` | Depth default—`interceptor.js:158` (function default), `:196` | Live |
| `INJECTION_POSITION_IN_PROMPT` | `0` | `:34` | Position validation—`src/integration/settings.js:129` | Live |
| `INJECTION_POSITION_IN_CHAT` | `1` | `:35` | `interceptor.js:157,195`; settings panel gating—`src/integration/settingsPanel.js:339,346` | Live |
| `INJECTION_ROLE_SYSTEM` / `_USER` / `_ASSISTANT` | `0` / `1` / `2` | `:41-43` | `interceptor.js:159,197`; role validation—`settings.js:144` | Live |
| `INJECTION_MODE_AUTOMATIC` / `_MACRO` / `_OFF` | `'automatic'` / `'macro'` / `'off'` | `:56-58` | Mode gates—`interceptor.js:42-44,194,225,270`; panel gating—`settingsPanel.js:334` | Live |
| `INJECTION_MODES` | frozen list of the three modes | `:59-63` | Mode validation—`settings.js:124` | Live |
| `MACRO_NAME` | `'starmem-memories'` | `:67` | Macro registration—`src/integration/macro.js:120,139` | Live |

The `INJECTION_POSITION_*` and `INJECTION_ROLE_*` values mirror ST's `extension_prompt_types` / `extension_prompt_roles` as local numeric literals, deliberately not imported from `script.js` (`constants.js:30-43`).

### `SETTINGS_DEFAULTS` (13 fields, `integration/constants.js:90-104`)

Frozen object. Missing fields are filled from it at load and re-persisted (`settings.js:88`); `schemaVersion` mismatch resets everything (`settings.js:91-93`); bounds are enforced by clamping in `validateSettings` (`settings.js:97-157`). Wired/inert split is drift #3:

| Field | Default | Bounds | Status |
| --- | --- | --- | --- |
| `schemaVersion` | `1` |—| Wired—`settings.js:91-93` |
| `profileId` | `''` |—| Wired—consolidation opts assembly `src/integration/bootstrap.js:70`, persona rebuild `src/integration/viewer/tabs/persona.js:119,154` |
| `embedProfileId` | `''` |—| **Inert**—persisted/validated (`settings.js:117`) and panel-writable (`settingsPanel.js:221`); persona rebuild uses `profileId`, not this |
| `bufferSize` | `5` | 1–50 (`:108`) | **Inert**—consolidation reads `WORKING_BUFFER_THRESHOLD = 10` instead (`triggers.js:59`); panel slider `settingsPanel.js:177-178` is its only writer |
| `idleTimeout` | `60_000` | 5 000–600 000 (`:109`) | **Inert**—the idle timer reads `IDLE_TRIGGER_SECONDS = 60` instead (`triggers.js:28,87`); panel slider `settingsPanel.js:189-190` |
| `scorerId` | `'default'` |—| Wired—`bootstrap.js:386`, activation via `settings.js:150-157` |
| `extractionModelLabel` | `''` |—| Wired—`bootstrap.js:71`, `persona.js:155` |
| `tracesMaxLen` | `128` | 16–1024 (`:110`) | **Inert**—the live trace cap is `TRACE_BUFFER_CAP = 128` (`trace.js:46`); panel slider `settingsPanel.js:202-203` |
| `debugMode` | `false` |—| **Inert**—boolean-coerced (`settings.js:121`), panel checkbox `settingsPanel.js:253`; the logger's debug channel never reads it (drift #14) |
| `injectionMode` | `'automatic'` |—| Wired—`interceptor.js:225,270` |
| `injectionPosition` | `1` (IN_CHAT) |—| Wired—`interceptor.js:195` |
| `injectionDepth` | `4` | 0–10 (`:111`) | Wired—`interceptor.js:196` |
| `injectionRole` | `0` (SYSTEM) |—| Wired—`interceptor.js:197` |

For the inert five, `settingsPanel.js` is the only writer outside validation (`:177-178`, `:189-190`, `:202-203`, `:221`, `:253`); `validateSettings` merely coerces and clamps (`settings.js:97-121`). No runtime code reads them—see [integration](./integration.md) and drift #3.

### Viewer constants

| Name | Value | Site | Consumer(s) | Status |
| --- | --- | --- | --- | --- |
| `SETTINGS_BOUNDS` | `{ bufferSize: 1–50, idleTimeout: 5 000–600 000, tracesMaxLen: 16–1024, injectionDepth: 0–10 }` | `integration/constants.js:107-112` | Clamping—`settings.js:101,107,113,141` | Live (bounds on fields that are themselves inert or live as noted above) |
| `VIEWER_TABS` | `['working', 'episodic', 'persona', 'graph', 'traces']` | `:116-122` | Tab shell render order—`src/integration/viewer/mount.js:59,101,113,118` | Frozen, Live |
| `CSS_PREFIX` | `'starmem'` | `:127` | Every viewer/panel/indicator DOM id and class—all of `src/integration/` (e.g. `mount.js:96-122`); enforced by `tests/integration/integration/no-leaky-css.test.js:89` | Live |

## Unwired-in-production constants (summary)

Constants that exist but no production path reaches—each is an instance of a broader wiring gap, not a value bug:

- **`QUERY_INTENTS`** (`constants.js:19`)—the classifier hardcodes its own pattern lists (`classifier.js:13-31`); drift #13.
- **`SETTINGS_SCHEMA_VERSION`** (`integration/constants.js:12`)—superseded in practice by `SETTINGS_DEFAULTS.schemaVersion` (`settings.js:91-93`).
- **Logger debug channel**—`debugMode` and `createLogger`'s `debug` option are never enabled: all 13 `createLogger` call sites in `src/` pass `debug: false` (root default `src/core/logger.js:48`); drift #14.
- **`DAILY_DECAY`, `PROMOTION.*`, `DEMOTION.*`**—live constants whose only consumers (`applyDailyDecay`, `maturityFor`) are themselves unwired; drift #4.

## See also

- [core](./core.md)—the constants module's structure and the sweep-override mechanism in detail.
- [retrieval](./retrieval.md)—how the RETRIEVAL tunables behave in the ladder.
- [consolidation](./consolidation.md)—triggers, dedup, and `EXTRACT_MAX_TOKENS` history.
- [lifecycle](./lifecycle.md)—which LIFECYCLE constants are wired and why decay/maturity are inert (drift #4).
- [integration](./integration.md)—the settings system, panel, and the wired/inert split (drift #3).
- [memory](./memory.md)—edge building under the edge cap and relation weights.
- [drift register](./drift-register.md)—authoritative entries for every inert/unwired status cited above.
