# Data model

The persisted shapes STARmem v2 writes to `chatMetadata`, their field names exactly as the code declares them, how entry ids are derived, and the validators that guard every boundary. Shape declarations live in `src/core/schema.js` as JSDoc typedefs; factories and validators live beside the code that produces each shape.

Source: `src/core/schema.js`, `src/core/state.js`, `src/core/constants.js`, `src/memory/entry.js`, `src/retrieval/trace.js`, `src/retrieval/tier0-exact.js`, `src/retrieval/tier1-fuzzy.js`, `src/retrieval/ladder.js`, `src/consolidation/consolidate.js`, `src/integration/bootstrap.js`.

## Storage nesting

```text
SillyTavern chatMetadata
└── ['STARmem']            ← created with Object.create(null)   (src/integration/bootstrap.js:116-120)
    └── [chatId]           ← one State per chat
        └── State          ← shape below
```

- The backend resolves `ctx.chatMetadata['STARmem'][id]` on every read/write—never a cached reference—because ST swaps the active metadata object on chat switch (`src/core/state.js:8-11`, `src/integration/bootstrap.js:98-127`).
- `loadState` returns a deep clone (`structuredClone`) independent of storage, or a fresh empty state when nothing is stored or the value is malformed (`src/core/state.js:103-112`).
- `persistState` deep-clones on write (`structuredClone`) and refuses malformed shapes (`src/core/state.js:122-130`). Callers hold the write lock; `persistState` never acquires it (`src/core/state.js:115-117`).
- The `STARmem` slot itself is `Object.create(null)` so reserved keys cannot collide with inherited properties (`src/integration/bootstrap.js:116-120`).

## State

`createEmptyState()` returns the zero-value tree; every field is initialized here (`src/core/schema.js:119-133`):

| Field | Type | Notes |
| --- | --- | --- |
| `entries` | `Object<string, Entry>` | Id → entry map. |
| `workingBuffer` | `string[]` | Entry ids in arrival order; drained front-first by consolidation. |
| `graph` | `{ edges: Edge[] }` | Flat edge list only—no adjacency structure is persisted. |
| `tierCaches` | `TierCaches` | Exact + fuzzy retrieval caches (below). |
| `runtime` | `Runtime` | Per-chat process bookkeeping (below). |

Loose shape-check for anything loaded: `looksLikeState` rejects primitives and arrays and requires an `entries` object, a `workingBuffer` array, a `graph` object containing an `edges` array, a `tierCaches` object, and a `runtime` object (`src/core/state.js:81-93`). The claim that deep validation is "left to use-sites (`isValidEntry` when indexing, etc.)" comes from a stale code comment (`src/core/state.js:74-76`): no production site performs deep entry validation—`isValidEntry` is unwired (see the validators table), and load/persist rely on `looksLikeState` alone.

## Entry

One memory fact in any scope. `createEntry` is the only construction site (`src/memory/entry.js:3`, factory at `entry.js:70-147`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Derivation below. |
| `scope` | `'working' \| 'episodic' \| 'persona'` | Enum at `src/core/constants.js:10`. |
| `content` | `string` | Non-empty enforced. |
| `subject` | `string \| null` | |
| `tags` | `string[]` | |
| `relations` | `Relation[]` | `{ type: EdgeType, target: string }` (`src/core/schema.js:27-30`). |
| `lifecycle` | `Lifecycle` | `importance: number` in [0, 100], `maturity: 'draft' \| 'validated' \| 'core'`, `createdAt`/`updatedAt` ISO strings, `accessCount`, `updateCount` (`src/core/schema.js:33-40`). |
| `provenance` | `Provenance` | `sourceMessages: number[]` (indices into the ST chat array), `extractor: string` (`src/core/schema.js:43-46`). |

Defaults from `createEntry`: `importance = 50`, `maturity = 'draft'`, `accessCount = 0`, `updateCount = 0`, and `createdAt === updatedAt` at creation time (`src/memory/entry.js:134-141`).

### Entry-id derivation

Format: **`<prefix>_<ISO-seconds>_<sha256-12hex>`**, e.g. `ep_2026-04-20T14:12:33_a3f124cde091` (`src/memory/entry.js:33-35`).

- **Prefix** by scope: `working → wk`, `episodic → ep`, `persona → ps` (`src/memory/entry.js:13-17`).
- **ISO seconds**: `now.toISOString().replace(/\.\d+Z$/, '')`—millisecond precision trimmed (`src/memory/entry.js:52`).
- **Suffix**: `sha256Hex(seed).slice(0, 12)`—12 hex chars = 48 bits; same seed ⇒ same id, so replayed extractions are id-stable (`src/memory/entry.js:28-30`).
- **Seed**—a pipe-joined string of `scope, content, subject ?? '', tags sorted + comma-joined, sourceMessages comma-joined, extractor` (`src/memory/entry.js:118-125`).

Determinism consequence: identical inputs (scope, content, tags, provenance, and second-resolution timestamp) always produce the same id.

## Edge

| Field | Type | Notes |
| --- | --- | --- |
| `from` | `string` | Source entry id. |
| `to` | `string` | Target entry id. |
| `type` | `EdgeType` | `'mentions' \| 'supports' \| 'same_topic' \| 'temporal_next' \| 'contradicts'` (`src/core/schema.js:23`). |
| `weight` | `number` | Set by `edgeBuilder`: explicit relations weigh 1.0, entity co-occurrence 0.5 (`RETRIEVAL.EXPLICIT_RELATION_WEIGHT` / `COOCCURRENCE_WEIGHT`, `src/core/constants.js:86-88`). |

`contradicts` is reserved but never produced in v2.0—`EDGE_TYPES.PRODUCED` holds the four emitted types and `EDGE_TYPES.RESERVED` holds `contradicts` (`src/core/constants.js:13-16`); `ALL_EDGE_TYPES` unions them (`src/core/schema.js:93-96`).

## Runtime

| Field | Type | Notes |
| --- | --- | --- |
| `lastConsolidation` | `string \| null` | ISO timestamp, or `null` in an empty state. |
| `pendingPersonaRebuild` | `boolean` | Flipped true by `consolidate()` when `episodicCountSinceLastRebuild ≥ PERSONA_REBUILD_SUGGESTION_THRESHOLD = 100` (`src/consolidation/consolidate.js:241-253`); cleared by the Persona rebuild. |
| `consolidating` | `boolean` | True while `consolidate()` holds the write lock; a stale `true` is cleared-and-skipped on the next run (`src/consolidation/consolidate.js:100-105`). |
| `episodicCountSinceLastRebuild` | `number` | Incremented per added episodic entry (`consolidate.js:241-253`). |
| `traces` | `object[]` | Ring buffer of retrieval and consolidation traces, cap `TRACE_BUFFER_CAP = 128` (`src/core/constants.js:162`, `src/retrieval/trace.js:44-56`). |

## tierCaches

| Field | Type | Key derivation |
| --- | --- | --- |
| `exact` | `Object<string, string[]>` | FNV-1a 32-bit hash (8-char hex) of the query after `trim().toLowerCase()` normalization (`src/retrieval/tier0-exact.js:28-49`). |
| `fuzzy` | `Object<string, string[]>` | Sorted unique tokens of the query joined by single spaces (`tokenSetKey`, `src/retrieval/tier1-fuzzy.js:40-43`). |

Values are entry-id lists. Both maps are bounded LRU-style caches at `RETRIEVAL.TIER_CACHE_MAX_ENTRIES = 200`, evicting oldest insertion-order keys first via delete-then-reinsert (`tier0-exact.js:91-112`, `tier1-fuzzy.js:102-123`). The exact cache is invalidated wholesale by `invalidateTier0Cache` after each consolidation batch (`src/consolidation/consolidate.js:259`); the fuzzy cache is never bulk-invalidated.

## Retrieval trace

One per `retrieve()` call. JSDoc type at `src/retrieval/trace.js:13-23`; constructed via `buildTrace` (identity helper, `trace.js:32-34`).

| Field | Type | Notes |
| --- | --- | --- |
| `timestamp` | `string` | ISO 8601. |
| `query` | `string` | The last user query verbatim. |
| `classifier` | `'factual' \| 'relational' \| 'temporal'` | |
| `tierResolved` | `0 \| 1 \| 2 \| 3 \| 'floor' \| 'bm25only' \| 'recency' \| 'random'` | The ladder only ever produces `0`, `1`, `3`, `'floor'` (`src/retrieval/ladder.js:164,189,238,124`). `2` never occurs—Tier 2 is seed-only—but a legacy persisted `2` is rendered as `T3` in the viewer's trace badges (`src/integration/viewer/tabs/traces.js:107`). The `'bm25only'`/`'recency'`/`'random'` variants are admitted by the type but not produced by current code. |
| `perTier` | `Record<string, unknown>` | Tier 0/1 hits: `{ '0': [{ id }] }` / `{ '1': [{ id }] }` (`ladder.js:156,181`). Tier 3: `{ '2': [{ id, bm25, score }], '3': [{ id, bm25, score }] }` (`ladder.js:227-230`). Floor with a Tier 2 prefix: `{ '2': [{ id, bm25, score }] }` (`ladder.js:108-117`). |
| `finalRanking` | `string[]` | Entry ids after the working-buffer prepend. |
| `scorerId` | `string` | Label only (`getScorerId()`). |
| `cause` | `string` (optional) | Generation type: `'normal' \| 'swipe' \| 'continue' \| 'regenerate' \| 'impersonate' \| 'quiet'`; interceptor supplies `'normal'` when the type is missing (`src/integration/interceptor.js:251`). |

`logTrace` appends and evicts oldest beyond the 128 cap (`src/retrieval/trace.js:44-56`).

## Consolidation trace

One per `consolidate()` run, appended to the same `runtime.traces` ring. **Not a typedef**—an inline object literal in `consolidate.js`; treat these field names as the contract:

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `'consolidate'` | Distinguishes it from retrieval traces (`src/consolidation/consolidate.js:167,272`). |
| `timestamp` | `string` | ISO 8601. |
| `chatId` | `string` | |
| `summary` | `object` | `{ factCount, added, updated, scope: 'episodic', error? }`—`error: 'parse_failure'` appears only on parse-failure runs (`consolidate.js:170-179,275-280`). |
| `durationMs` | `number` | Wall time for the run. |
| `extractor` | `string` | From `opts.extractorLabel`. |

## Validators and guards

| Guard | Site | What it enforces |
| --- | --- | --- |
| `isValidEntry(x)` | `src/memory/entry.js:157-189` | Total shape check: `id` non-empty string, `scope` in enum, non-empty `content`, `subject` string-or-null, `tags` all strings, each relation `{ type ∈ EdgeType, target: non-empty string }`, lifecycle `importance` numeric in [0, 100] with valid `maturity`, `createdAt`/`updatedAt` checked for string type only—not ISO format (`entry.js:179`)—and non-negative counts, provenance `sourceMessages` numeric array + `extractor` string. **Unwired**—zero production call sites (barrel re-export `src/memory/index.js:9` and comments only); persist/load rejection uses `looksLikeState` (`src/core/state.js:81-93`), not this validator. The source comment at `entry.js:151-152` claiming use by persist/load and index-build guards is stale. Exercised by the test suite only (`entry.test.js:90-133`). |
| `isScope` / `isMaturity` / `isEdgeType` | `src/core/schema.js:99-111` | Frozen-enum membership checks backing the above. |
| `looksLikeState(x)` | `src/core/state.js:81-93` | Loose top-level shape check on load and persist (see [State](#state)); rejects primitives, arrays, and missing/mistyped top-level keys. |
| `assertSafeChatId(id)` | `src/integration/bootstrap.js:84-91` | Chat ids must be non-empty strings and not in `RESERVED_KEYS = ['__proto__', 'constructor', 'prototype']` (`bootstrap.js:78`)—a prototype-pollution guard on the metadata slot. |
| Slot hardening | `src/integration/bootstrap.js:116-120` | `chatMetadata['STARmem']` is created as `Object.create(null)` so even a bypassed id check cannot collide with inherited properties. |
| `createEntry` field guards | `src/memory/entry.js:70-113` | Rejects invalid scope, empty content, non-string/null subject, non-array tags/relations, malformed relations and provenance before any id is minted. |

State I/O throws rather than sanitize: bad `chatId` values and malformed shapes raise (`src/core/state.js:103-105,122-128`); the only silent-repair case is `loadState` returning a fresh empty state for missing/malformed storage (`state.js:108-110`).

## See also

- [architecture.md](./architecture.md)—the two lifecycles that produce and consume these shapes.
- [schema.js reference](./core.md)—enums, state backend clone semantics, lock.
- [drift-register.md](./drift-register.md)—spec-vs-code divergences, including the trace-cap discrepancy.
- `docs/specs/2026-04-20-starmem-v2-design.md` §3—design intent for these shapes (spec is design-of-record, not code truth).
