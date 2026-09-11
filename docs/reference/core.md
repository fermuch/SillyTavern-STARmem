# Core infrastructure

The substrate every other layer stands on: the constants module that holds every spec-derived value plus the benchmark override mechanism, the schema module's enums and guards, the backend-injected state I/O bridge, the per-chat write lock, and the structured logger. These five modules define what other code is allowed to assume—shapes, thresholds, locking discipline, and logging style.

Source: `src/core/constants.js`, `src/core/schema.js`, `src/core/state.js`, `src/core/lock.js`, `src/core/logger.js`. Behavior confirmed against `tests/unit/core/` (`constants.test.js`, `swept-constants-overridable.test.js`, `schema.test.js`, `state.test.js`, `lock.test.js`, `logger.test.js`).

## constants.js—structure

`src/core/constants.js` is the single source of truth for spec-derived values; the module header states that any number the spec references more than once lives here (`constants.js:1-7`). It exports ten groups:

| Export | Site | Frozen? | Contents | Status |
| --- | --- | --- | --- | --- |
| `SCOPES` | `constants.js:10` | yes | `['working', 'episodic', 'persona']` | Wired—enum source for `isScope` |
| `EDGE_TYPES` | `constants.js:13-16` | yes | `{ PRODUCED: ['mentions', 'supports', 'same_topic', 'temporal_next'], RESERVED: ['contradicts'] }` | Wired—enum source for `ALL_EDGE_TYPES` |
| `QUERY_INTENTS` | `constants.js:19` | yes | `['factual', 'relational', 'temporal']` | **Unwired**—no consumer in `src/`; the classifier hardcodes its own pattern lists (`src/retrieval/classifier.js:13-31`) |
| `MATURITY_TIERS` | `constants.js:22` | yes | `['draft', 'validated', 'core']` | Wired—enum source for `isMaturity` |
| `LIFECYCLE` | `constants.js:25-50` | yes | Recency/bonus/decay numbers, maturity boosts, promotion/demotion thresholds (see [lifecycle](./lifecycle.md)) | Wired |
| `RETRIEVAL` | `constants.js:59-89` | **no** | Retrieval ladder tunables (see [retrieval](./retrieval.md)) | Wired |
| `EDGE_TYPE_WEIGHTS` | `constants.js:96-102` | yes | Edge-type match weights per query intent, including a dormant `contradicts` row the v2.0 edge builder never emits (`constants.js:93-95`) | Wired—`src/retrieval/tier3-graph.js:72` |
| `CONSOLIDATION` | `constants.js:110-135` | **no** | Consolidation tunables (see [consolidation](./consolidation.md)) | Wired |
| `PERSONA_REBUILD` | `constants.js:138-159` | yes | Enhanced-RAPTOR parameters; consumed by `src/consolidation/raptor/knn.js:21`, `leiden.js:586`, `summarize.js:15`, `embeddings.js:20`, `personaRebuild.js:38` | Wired |
| `TRACE_BUFFER_CAP` | `constants.js:162` | — | `128` | Wired—`src/retrieval/trace.js:46` |

Per-constant value tables are out of scope here—[constants.md](./constants.md) carries the full tunable catalog. `contradicts` as an edge type is reserved but never produced in v2.0.

The two **unfrozen** groups are unfrozen deliberately, as the backing mechanism for benchmark sweeps (below). Everything else is `Object.freeze`-hardened, and frozen-enum membership tests in `schema.js` read from them.

### The sweep-override mechanism

The benchmark sweep driver needs to probe retrieval and consolidation behavior at non-default knob values without re-importing modules. The mechanism (`constants.js:165-255`):

- **Mutable groups.** `RETRIEVAL` and `CONSOLIDATION` are plain objects—deliberately *not* `Object.isFrozen`, because `setConstantOverrides` mutates them in place in strict mode (`constants.js:52-58`, `constants.js:104-109`; invariant asserted in `tests/unit/core/swept-constants-overridable.test.js:66-73`). Their non-swept keys should still be treated as read-only; mutating one outside the harness is a bug by convention, not by freeze.
- **Swept-key registries.** `_SWEPT_RETRIEVAL_KEYS` (`constants.js:189-201`) holds 11 keys: `TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `TIER3_MAX_HOPS`, `TIER3_SEEDS_K`, `TIER3_BEAM_WIDTH`, `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT`, `EXPLICIT_RELATION_WEIGHT`, `SUBJECT_BOOST`, `TAG_BOOST`, `TIER_CACHE_MAX_ENTRIES`. `_SWEPT_CONSOLIDATION_KEYS` (`constants.js:204-215`) holds 4: `DEDUP_JACCARD_THRESHOLD`, `BATCH_SIZE`, `WORKING_BUFFER_THRESHOLD`, `EXTRACT_MAX_TOKENS`. Both arrays are frozen. `WORKING_BUFFER_THRESHOLD` must be swept *together with* `BATCH_SIZE`—the runtime drains `min(BATCH_SIZE, buffer.length)` per fire, so sweeping only one of the pair produces a permanent cache miss (`constants.js:207-213`).
- **Module-load snapshots.** `_INITIAL_RETRIEVAL` / `_INITIAL_CONSOLIDATION` are shallow copies taken at module load (`constants.js:185-186`) and are what `resetConstantOverrides()` restores from.
- **`setConstantOverrides(overrides)`** (`constants.js:225-246`) applies a partial override. A non-object input throws (`:226-228`). Each key is looked up in the two swept registries and mutated in place, with a restorer closure pushed onto a list; a key in neither registry throws `unknown or non-swept key '<key>'` **after undoing all keys applied so far** (`:239-243`), so partial application never leaks (asserted in `swept-constants-overridable.test.js:168-176`). Returns a restore function that undoes just that override set (`:245`).
- **`resetConstantOverrides()`** (`constants.js:252-255`) writes every swept key back from the `_INITIAL_*` snapshots—the sweep driver's try/finally clean slate.
- **Call-time-read rule.** Overrides are only observable to code that reads `RETRIEVAL.X` at call time. Module-top destructuring (`const { TIER3_LAMBDA_1 } = RETRIEVAL`) snapshots the import-time value and silently bypasses overrides. The guard test `tests/unit/core/swept-constants-overridable.test.js` walks every `.js` file under `src/` except `constants.js` itself (`:75-76`), strips comments (`:60-64`), and fails on any `const { … <swept key> … } = RETRIEVAL|CONSOLIDATION` pattern (`:83-85`, `:98-100`). Round-trip and partial-rollback behavior are asserted at `:111-198`.
- **Ownership.** This is a controller-owned mechanism: production code must never call `setConstantOverrides` or `resetConstantOverrides`—their only production consumer is the bench runner (`constants.js:180-182`; `bench/runner.js:97`).

Minor stale-comment note: the guard test's header still describes `BATCH_SIZE` as a non-swept key (`swept-constants-overridable.test.js:16-18`), but `BATCH_SIZE` is in `_SWEPT_CONSOLIDATION_KEYS` (`constants.js:206`) and is overridden by the test itself (`:152-158`). The code is the truth: it is swept.

## schema.js—types, enums, and guards

`src/core/schema.js` holds the JSDoc typedefs for the persisted state tree, the frozen enum helpers, and `createEmptyState` (`schema.js:1-10`). The typedefs—`Scope` (`:15`), `Maturity` (`:19`), `EdgeType` (`:23`), `Relation` (`:27-30`), `Lifecycle` (`:33-40`), `Provenance` (`:43-46`), `Entry` (`:49-58`), `Edge` (`:61-66`), `Runtime` (`:69-75`), `TierCaches` (`:78-81`), `State` (`:84-90`)—are compile-time documentation only; the runtime shapes are covered in [data-model.md](./data-model.md).

- **`ALL_EDGE_TYPES`** (`schema.js:93-96`) is the frozen union of `EDGE_TYPES.PRODUCED` and `EDGE_TYPES.RESERVED`—five values including `contradicts`. Its only production consumer is the extractor's relation-type guard (`src/consolidation/extractFacts.js:185`).
- **Guards**—thin membership checks over the frozen constant arrays:
  - `isScope(s)` (`schema.js:99-101`)—`SCOPES.includes(s)`.
  - `isMaturity(m)` (`schema.js:104-106`)—`MATURITY_TIERS.includes(m)`.
  - `isEdgeType(t)` (`schema.js:109-111`)—`ALL_EDGE_TYPES.includes(t)`.

  Consumers: `src/memory/entry.js:43,75,104,162,171,178` (construction and validation), `src/lifecycle/maturity.js:35,63`, and the Memory Viewer's episodic tab (`src/integration/viewer/tabs/episodic.js:221`).

- **`createEmptyState()`** (`schema.js:119-133`) returns the complete zero-value State literal—empty `entries`, `workingBuffer: []`, `graph: { edges: [] }`, `tierCaches: { exact: {}, fuzzy: {} }`, and a `runtime` block with `lastConsolidation: null`, `pendingPersonaRebuild: false`, `consolidating: false`, `episodicCountSinceLastRebuild: 0`, `traces: []` (`:125-131`). No persistence side effects; a fresh object tree on every call (no shared references—`schema.test.js:50-59`). The only production caller is `loadState`'s recovery path (`src/core/state.js:109`).

All of `schema.js` is wired.

## state.js—backend-injected state I/O

`src/core/state.js` bridges STARmem's in-memory State tree to SillyTavern's `chatMetadata` slot. ST swaps the active `chatMetadata` object on chat switch, so reads and writes resolve the current metadata through the backend on every call rather than caching a reference (`state.js:1-18`; backend construction in `src/integration/bootstrap.js`).

- **Backend contract** (`state.js:22-26`): `{ read(chatId) → unknown, write(chatId, value) → void }`. The implementation is module-level state and is injectable so tests substitute an in-memory store.
- **Default backend throws.** Until `setBackend` is called, every `read`/`write` throws "state backend not configured" (`state.js:40-50`)—bootstrap-must-run is an enforced invariant, not a comment. Production sets the real backend once at bootstrap (`src/integration/bootstrap.js:382`).
- **`setBackend(b)`** (`state.js:61-66`) validates that `read` and `write` are functions, then replaces the module-level backend. `_resetBackendForTests()` (`state.js:69-71`) restores the throwing default—test-only.
- **`looksLikeState(x)`** (`state.js:81-93`, private) is a loose top-level shape check: rejects primitives and arrays, requires an `entries` object (non-array), a `workingBuffer` array, a `graph` object containing an `edges` array, and `tierCaches` and `runtime` objects. Deep validation is left to use-sites.
- **`loadState(chatId)`** (`state.js:103-112`): async. Throws on an empty or non-string `chatId` (`:104-106`). Reads raw via the backend; if the value is missing or fails `looksLikeState`, returns a fresh `createEmptyState()` (`:108-110`)—the one silent-repair path in state I/O. Otherwise returns `structuredClone(raw)` (`:111`), so the caller's tree is fully independent of storage.
- **`persistState(chatId, state)`** (`state.js:122-130`): async. Throws on bad `chatId` (`:123-125`) and on shape failure (`:126-128`); writes `structuredClone(state)` (`:129`) so subsequent in-place mutation of the caller's tree cannot bleed into storage. It never acquires the write lock—the caller must already hold it (`state.js:114-117`).

Clone semantics are confirmed by `tests/unit/core/state.test.js`: persist/load round-trip returns an independent object (`:28-40`), and a corrupted stored value recovers to an empty state rather than throwing (`:48-54`).

Production callers: the interceptor loads and persists inside a single `withWriteLock` (`src/integration/interceptor.js:253,256`), the bootstrap chat-lifecycle hooks (`src/integration/bootstrap.js:238-356`), the consolidation trigger pre-checks and drain (`src/consolidation/triggers.js:50,121-122`), `consolidate()` itself (`src/consolidation/consolidate.js:94-200`), the Memory Viewer mount snapshot (`src/integration/viewer/mount.js:249`), and the indicator poll (`src/integration/indicator.js:103`).

## lock.js—per-chat write lock

`src/core/lock.js` implements the write path's "single mutator" gatekeeper: every long-term mutation must flow through `withWriteLock` (`lock.js:1-11`). The mechanism is a promise-tail chain per chat id:

- A `Map<chatId, Promise<void>>` of tail promises (`lock.js:14-15`).
- Each call takes the previous tail (or an already-resolved promise for the first caller), runs `prev.catch(() => {}).then(() => fn())`—swallowing the previous task's rejection *for chain continuity only* while still propagating `fn`'s own result or error to its caller (`lock.js:34-37`).
- The stored tail tracks completion only (`run.then(() => {}, () => {})`, `lock.js:39`), so a rejected task does not poison subsequent callers: the next task still runs after a failed one settles (asserted in `tests/unit/core/lock.test.js:43-49`).
- Cleanup: when a tail settles, it is deleted from the map—but only if it is still the latest tail for that chat (`lock.js:42-46`), so a superseded tail cannot evict its successor.
- `withWriteLock` returns the raw `run` promise: the caller awaits `fn`'s actual value (`lock.js:47`).

Semantics: calls with the same `chatId` serialize in call order; independent `chatId`s run in parallel (`lock.js:17-19`; trace-based proof in `lock.test.js:11-41`). There is no reentrancy and no queue bound—a slow task simply queues later callers behind it. Non-function `fn` and empty/non-string `chatId` reject immediately without touching the chain (`lock.js:27-32`; `lock.test.js:51-54`).

Test-only exports: `_resetLocksForTests()` clears all in-flight lock state—voiding serialization for pending callers—and `_getLockSetForTests()` exposes the in-flight chat-id set (`lock.js:55-62`). Never called from production code.

Production consumers of `withWriteLock`: the interceptor's load-retrieve-persist block (`src/integration/interceptor.js:252`), the idle-trigger drain (`src/consolidation/triggers.js:120`), `consolidate()` (`src/consolidation/consolidate.js:92`), the persona-rebuild atomic replace (`src/consolidation/raptor/atomic.js:75`), and the bootstrap mutation hooks for received/deleted/swiped messages (`src/integration/bootstrap.js:237,268,333`).

## logger.js

`src/core/logger.js` is a tiny structured logger all STARmem code is expected to use instead of bare `console.*` (`logger.js:1-6`).

- **`createLogger(opts)`** (`logger.js:29-33`): accepts an injectable `console` (for tests) and a `debug` boolean, defaulting to `globalThis.console` and `false`.
- **Channels** (`logger.js:35-45`): `info` → `console.log`, `warn` → `console.warn`, `error` → `console.error`, each prefixed with `[<prefix>]`; `debug` → `console.debug` with a `[<prefix>:debug]` prefix but **silent unless the `debug` flag is set**. `warn` and `error` always fire regardless of the flag (`logger.test.js:45-51`).
- **`scope(name)`** (`logger.js:43`): returns a child logger whose prefix appends `:<name>`—`log.scope('retrieval')` logs `[STARmem:retrieval]`.
- **Default export** `log` (`logger.js:47-48`) is created with `debug: false` and is consumed only by the entry point (`index.js:23`); every other module builds its own scoped logger (`src/integration/interceptor.js:52`, `src/consolidation/consolidate.js:45`, and ten more call sites across `src/integration/` and `src/consolidation/`).
- **Status: debug channel unwired in production.** Every call site passes `debug: false`—nothing in `src/` flips it on at runtime, and the settings system's `debugMode` field is likewise unwired (drift #3). The comment "flip via settings later" (`logger.js:47`) was never realized; enabling debug output currently requires a code change.

## See also

- [data-model.md](./data-model.md)—the State/Entry/Edge shapes `state.js` and `schema.js` manage.
- [memory.md](./memory.md) and [lifecycle.md](./lifecycle.md)—the biggest consumers of `schema.js` guards and `LIFECYCLE` constants.
- [retrieval.md](./retrieval.md) and [consolidation.md](./consolidation.md)—the `RETRIEVAL`/`CONSOLIDATION` consumers and the lock's heaviest users.
- [constants.md](./constants.md)—the full per-constant tunable catalog.
- [drift-register.md](./drift-register.md)—where "defined but unwired" items are tracked.
- `docs/specs/2026-04-20-starmem-v2-design.md`—the approved design-of-record (not code truth).
