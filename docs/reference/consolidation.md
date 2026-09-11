# Consolidation

Consolidation is STARmem's write half. An LLM pass turns buffered chat turns into structured episodic entries, deduplicates them against the store, builds graph edges, and—entirely separately—rebuilds the Persona scope from clustered episodic facts. It is the only subsystem allowed to mutate long-term state, and it does so in exactly two functions: `consolidate()` and `atomicReplacePersona()`, both under the chat write lock. Every LLM call in the extension lives here or in the viewer; the retrieval path never touches a model.

**Source:** `src/consolidation/consolidate.js`, `src/consolidation/triggers.js`, `src/consolidation/extractFacts.js`, `src/consolidation/dedup.js`, `src/consolidation/llmClient.js`, `src/consolidation/personaRebuild.js`, `src/consolidation/index.js`, `src/consolidation/raptor/` (`chunking.js`, `knn.js`, `leiden.js`, `summarize.js`, `embeddings.js`, `atomic.js`), constants in `src/core/constants.js:110-159`. Barrel exports in `src/consolidation/index.js:8-15`; `raptor/` has no barrel and is imported directly by `personaRebuild.js`.

## Triggers—`triggers.js`

`maybeConsolidate(chatId, reason, opts)` (`src/consolidation/triggers.js:42-66`) is the single gate in front of `consolidate()`. `reason` must be `'buffer'` or `'idle'`, otherwise it throws (`triggers.js:46-48`). It loads state without taking the lock (`triggers.js:50`)—a pre-check; the authoritative guards re-run inside `consolidate()` under the lock—and applies the gates in order:

1. **`already-running`**—`runtime.consolidating === true` skips (`triggers.js:52-54`).
2. **`empty-buffer`**—`workingBuffer.length === 0` skips (`triggers.js:55-57`).
3. **`below-threshold`**—checked only when `reason === 'buffer'`: skips while `workingBuffer.length < CONSOLIDATION.WORKING_BUFFER_THRESHOLD` (10, `src/core/constants.js:112`) (`triggers.js:59-61`). The `'idle'` reason has no size precondition beyond a non-empty buffer (`triggers.js:62`)—a single buffered entry is enough to consolidate on idle.

Each skip returns `{ skipped: true, why: 'already-running' | 'empty-buffer' | 'below-threshold' }`; otherwise the call proceeds to `consolidate(chatId, opts)` (`triggers.js:65`).

### The idle timer

`resetIdleTimer(chatId, opts)` (`triggers.js:75-90`) clears any pending timer for the chat (`triggers.js:79-80`) and arms a fresh `setTimeout` that fires `maybeConsolidate(chatId, 'idle', opts)` after `CONSOLIDATION.IDLE_TRIGGER_SECONDS * 1000` ms—60 s (`src/core/constants.js:114`). `cancelIdleTimer(chatId)` (`triggers.js:98-104`) clears it. Timers live in a module-level `Map` (`triggers.js:31`); they are process state, not persisted, so a page reload silently drops them—harmless, because the next chat event re-arms the timer.

Event wiring (`src/integration/bootstrap.js`): `MESSAGE_SENT` and `MESSAGE_SWIPED` call `resetIdleTimer` (`bootstrap.js:160`, `bootstrap.js:330`); `MESSAGE_RECEIVED` appends to the buffer and fires an opportunistic `maybeConsolidate(chatId, 'buffer', …)` without awaiting it (`bootstrap.js:248-250`); `CHAT_CHANGED` cancels the previous chat's timer (`bootstrap.js:138`) and runs an opportunistic buffer consolidation for it (`bootstrap.js:141`).

> **Divergence (drift #3):** the Settings panel's `bufferSize` (5) and `idleTimeout` (60_000 ms) defaults (`src/integration/constants.js:94-95`) are persisted and validated but read by no runtime code. Consolidation thresholds are the hardcoded constants in `src/core/constants.js:110-135`. The same drift covers the inert `embedProfileId`, `tracesMaxLen`, and `debugMode` settings—see [integration.md](./integration.md) and the [drift register](./drift-register.md).

## The pipeline—`consolidate.js`

`consolidate(chatId, opts)` (`src/consolidation/consolidate.js:74`) runs entirely inside `withWriteLock(chatId, …)` (`consolidate.js:92`). `opts` is a `ConsolidateOptions` record `{ profileId, extractorLabel, messageOf(entry) → {role, content}, now? }` (`consolidate.js:56-63`), assembled by the integration layer from persisted settings and passed in as opaque fields—consolidation itself never reads settings (drift #3). The call shape used by bootstrap at trigger sites is `buildConsolidateOpts()` (`bootstrap.js:141`).

In order:

1. **Argument validation**—`chatId`, non-empty `profileId`/`extractorLabel`, a `messageOf` function (`consolidate.js:75-90`).
2. **Stale-flag recovery**—if `runtime.consolidating` is still `true` on load (a prior run died mid-flight), log a warning, persist the cleared flag, and return `{ skipped: true }` (`consolidate.js:96-105`). Without this a crashed run would permanently block the chat's consolidation (Finding #13).
3. **Empty-buffer fast path**—returns `{ added: 0, updated: 0, drained: 0, parseFailures: 0, entriesSkipped: 0 }` without touching state (`consolidate.js:107-110`).
4. **Batch capture**—`r = Math.min(CONSOLIDATION.BATCH_SIZE, workingBuffer.length)` (5 max, `consolidate.js:114`); `batchIds = workingBuffer.slice(0, r)` (`consolidate.js:115`). The batch is captured before any mutation, so a failed extraction never loses or double-counts messages.
5. **Stale-reference dropping**—ids are dereferenced against `state.entries`; missing ones are skipped (`consolidate.js:118-121`). If the whole batch is stale, the references are dropped (buffer sliced by `r`, persisted) and the run returns `{ added: 0, updated: 0, drained: r, parseFailures: 0, entriesSkipped: 0 }` without calling the LLM (`consolidate.js:122-130`)—a cleanup write, not a long-term mutation.
6. **Message assembly**—`batchMessages = batchEntries.map(messageOf)`; `sourceMessageIndices` is the flattened union of each entry's `provenance.sourceMessages` (`consolidate.js:132-134`). A working copy with `consolidating: true` is prepared but deliberately not persisted until the run completes (`consolidate.js:136-141`).
7. **Extraction**—`extractFacts(batchMessages, { profileId, extractorLabel, sourceMessageIndices, now })` (`consolidate.js:143-151`); detailed below.
8. **Failure policy**—two opposite paths, detailed below (`consolidate.js:152-202`).
9. **Per-entry dedup and write** (`consolidate.js:209-238`)—for each extracted entry, `findDuplicate(newEntry, Object.values(work.entries))` (`consolidate.js:210-211`).
   - *Duplicate*—the existing entry is kept and only its lifecycle bumps: `{ ...dup, lifecycle: applyUpdateEvent(dup.lifecycle, clock) }` (`consolidate.js:215-218`). Content, tags, relations, id, and provenance stay as they were (spec §6.3, option A). This is the only wired caller of `applyUpdateEvent`—importance +5, `updateCount` +1, `updatedAt` restamped (see [lifecycle.md](./lifecycle.md)).
   - *New*—the episodic entry is inserted and edges are built immediately: `buildEdges(newEntry, corpus, work)` returns `{ newEdges, evicted }`, applied via `addEdge` / `removeEdge` (`consolidate.js:224-237`). `buildEdges` internals (explicit relations, entity co-occurrence, cap eviction) live in [memory.md](./memory.md).
10. **Persona-rebuild suggestion counter**—only when `added > 0`: `episodicCountSinceLastRebuild += added`, and `pendingPersonaRebuild` flips to `true` once the count reaches `PERSONA_REBUILD_SUGGESTION_THRESHOLD` (100) (`consolidate.js:240-253`, threshold at `src/core/constants.js:118`). Updates do not move the counter (`tests/unit/consolidation/consolidate.test.js:123`); `atomicReplacePersona` resets it to 0 (see persona rebuild below).
11. **Buffer drain**—`workingBuffer = workingBuffer.slice(r)` (`consolidate.js:256`).
12. **Tier 0 invalidation**—`invalidateTier0Cache(work)` once per batch, replacing the whole exact-match map (`consolidate.js:259`; `src/retrieval/tier0-exact.js:122-130`) so the next retrieval rebuilds it from the new entries.
13. **Run close**—`consolidating: false`, `lastConsolidation` stamped as an ISO string (`consolidate.js:262-269`).
14. **Trace + persist**—a `consolidate` trace is appended to the ring buffer (`consolidate.js:271-284`), then `persistState` (`consolidate.js:286`).
15. **Return**—`{ added, updated, drained: r, parseFailures: 0, entriesSkipped: extracted.skipped }` (`consolidate.js:287`).

### Failure policy—parse failure vs transport error

The two failure classes get opposite treatment (`consolidate.js:152-202`):

- **`ExtractionParseError`** (the model answered, but not with parseable JSON) is treated as a *content-level* result, not an abort: the batch is drained, `consolidating` is cleared, `lastConsolidation` is stamped, a trace with `summary.error: 'parse_failure'` is recorded, state is persisted, and the run returns `{ added: 0, updated: 0, drained: r, parseFailures: 1, entriesSkipped: 0 }` (`consolidate.js:160-191`). The rationale (`consolidate.js:153-159`): aborting would leave the buffer over threshold, the next turn would re-fire, and with cached replay the same cached bad response would be replayed forever—an infinite loop. `parseFailures: 1` lets the bench report a parse-failure rate.
- **Transport / validation / unknown errors** are logged, the `consolidating` flag is cleared and persisted if it was set (`consolidate.js:198-201`), and the error is **rethrown without draining** (`consolidate.js:202`). The buffer is intact, so the same messages are retried on the next trigger—and **no `consolidate` trace is recorded** on this path (`tests/unit/consolidation/consolidate-trace.test.js:196-210`).

### Trace and return value

Successful and parse-failed runs each append one trace to the runtime ring buffer (cap 128—see [retrieval.md](./retrieval.md)):

```js
{
    kind: 'consolidate',
    timestamp,        // ISO string
    chatId,
    summary: { factCount, added, updated, scope: 'episodic', error? },
    durationMs,
    extractor,
}
```

`factCount` is the number of entries the extractor produced (before dedup), `added`/`updated` are the post-dedup counts, and `error: 'parse_failure'` exists only on the parse-failure path (`consolidate.js:166-179` vs `consolidate.js:271-283`). The returned counters: `drained` is the batch size `r`, `parseFailures` is 0 or 1, and `entriesSkipped` is the extractor's soft-fail count. The stale-flag recovery returns a bare `{ skipped: true }` (`consolidate.js:104`).

## Fact extraction—`extractFacts.js`

`extractFacts(batch, context)` (`src/consolidation/extractFacts.js:240-276`) turns transcript messages into entry specs:

1. Guards: `batch` must be a non-empty array (`extractFacts.js:241-243`); `context.profileId` and `context.extractorLabel` non-empty strings (`extractFacts.js:248-253`); `context.sourceMessageIndices` an array (`extractFacts.js:254-256`).
2. `renderExtractionPrompt(batch)` (`extractFacts.js:218-226`) builds a two-message payload: the fixed system prompt plus a user message containing the transcript—one `` `[role] content` `` line per message—and the instruction `Return the JSON now.`
3. `callLLM(profileId, messages, CONSOLIDATION.EXTRACT_MAX_TOKENS)` (`extractFacts.js:259`)—4096 tokens (`src/core/constants.js:134`).
4. `parseLLMJson(raw)` (`extractFacts.js:98-114`).
5. `validateExtractionShape(parsed)` (`extractFacts.js:138-210`).
6. Each surviving spec becomes an entry via `createEntry` with `scope: 'episodic'` and `provenance: { sourceMessages: [...context.sourceMessageIndices], extractor: extractorLabel }` (`extractFacts.js:264-275`); the clock is `context.now ?? new Date()` (`extractFacts.js:263`). Baseline lifecycle from `createEntry`: importance 50, maturity `draft` (`tests/unit/consolidation/extractFacts.test.js:125-126`).
7. Returns `{ entries, skipped }` (`extractFacts.js:276`).

### The system prompt contract

`SYSTEM_PROMPT` (`extractFacts.js:26-48`) demands strict JSON and nothing else—no prose, no fences. The schema is `{ entries: [...] }` where each entry is:

- `content`—one factual statement, 1-2 sentences, third person;
- `subject`—the canonical subject name, or `null` if none;
- `tags`—short topical tags, lowercase;
- `relations`—optional array of `{ type, target }`, omitted entirely when empty, with `type` limited to `mentions | supports | same_topic | temporal_next` and `target` being another entry id or a stable subject string.

Rules: only durable facts (skip pleasantries and filler); if nothing durable, return `{"entries":[]}`; and explicitly, *"Do not emit `contradicts` relations; that type is reserved"*—the validator drops any that appear anyway (below).

### `parseLLMJson`

`parseLLMJson(raw)` (`extractFacts.js:98-114`) trims, strips a single Markdown fence with a regex (`extractFacts.js:104`), and `JSON.parse`s—there is no repair pass. Any failure throws `ExtractionParseError` (`extractFacts.js:77-88`) carrying `responseLength` (raw string length) and an optional `cause`. The class exists so `consolidate()` can distinguish content-level failures from transport failures; it was surfaced by Phase 12 Task 7, where a remote vLLM warmup wrote truncated responses into the on-disk cache at the token ceiling, and cache replay kept feeding those truncated payloads back as parse errors.

`EXTRACT_MAX_TOKENS` is 4096 (`src/core/constants.js:134`)—amended upward from 2048 in Phase 14 Task 6 after dense LongMemEval-S batches hit the 2048 ceiling and produced truncated cached responses that failed replay parsing; 4096 recovered six truncation-skipped items (n_scored 393→399, coverage +1.27 pp), while 6144 added only noise (`constants.js:121-133`).

### `validateExtractionShape`

`validateExtractionShape(parsed)` (`extractFacts.js:138-210`) enforces the schema with a two-tier policy:

- **Root errors throw** (`extractFacts.js:139-145`): a non-object root → `response must be a JSON object`; a missing or non-array `entries` → `response.entries must be an array`. These surface as `ExtractionParseError`-style failures that trigger the drain path above.
- **Per-entry errors soft-fail** (`extractFacts.js:149-208`): each entry is validated inside its own `try/catch`; a malformed entry is dropped and counted, the rest of the batch survives. Returns `{ specs, skipped, skipReasons }` (`extractFacts.js:209`). Per-entry rules: `content` must be a non-empty string (`extractFacts.js:156-158`); `subject` is `null`/`undefined` → `null`, any non-string throws (`extractFacts.js:159-166`); `tags` defaults to `[]` and must be a string array (`extractFacts.js:167-170`); `relations` defaults to `[]` and must be an array of `{ type: string, target: non-empty string }` (`extractFacts.js:177-184`); `type` must be in `ALL_EDGE_TYPES` (`extractFacts.js:185-187`).
- A `contradicts` relation is **silently dropped**—`continue`, not counted as a skip (`extractFacts.js:188-191`); the type is reserved and produced by nothing in v2.0.
- A relation targeting `__proto__`, `constructor`, or `prototype` throws (`extractFacts.js:192-201`), a prototype-pollution guard against `state.entries[target]` writes (Finding #14); under the soft-fail wrapper this drops the offending entry.

## LLM surface—`llmClient.js`

`callLLM(profileId, messages, maxTokens)` (`src/consolidation/llmClient.js:61-72`) is the single LLM entry point for the write path. It validates its arguments (non-empty `profileId`, non-empty message array, positive numeric `maxTokens`, `llmClient.js:62-70`) and forwards to the active client, which defaults to `defaultCallLLM` (`llmClient.js:29-47`):

- Resolves `globalThis.SillyTavern.getContext().ConnectionManagerRequestService` **at call time, never cached**—ST swaps the service object during lifecycle events, so caching is fragile (`llmClient.js` header, same reasoning as `core/state.js`'s context resolution); missing either object throws (`llmClient.js:33`, `llmClient.js:38`).
- Calls `svc.sendRequest(profileId, messages, maxTokens)` non-streaming (`llmClient.js:40`) and reads only a string `response.content`, throwing if absent (`llmClient.js:42-46`).

Test hooks `_setLLMClientForTests` / `_resetLLMClientForTests` swap the client in place (`llmClient.js:78-88`). Both extraction and persona summarization go through this surface—there is exactly one.

## Deduplication—`dedup.js`

`findDuplicate(candidate, allEntries)` (`src/consolidation/dedup.js:47-58`) implements the episodic collapse rule:

- A candidate with `subject === null` never dedups—`null !== null` by design, so subjectless facts always insert (`dedup.js:49`).
- Candidates are compared only against entries with `scope === 'episodic'` (`dedup.js:52`)—even though `consolidate()` passes the entire entry store as the corpus, the scope filter is internal to `findDuplicate`.
- The subject must match by **exact string equality** (`dedup.js:53`).
- Content similarity uses `jaccard(candTokens, tokenize(e.content))` (`dedup.js:27-35`), where `tokenize` is BM25's tokenizer (`src/retrieval/bm25.js:22-28`—lowercase, split on `/[^a-z0-9]+/u`, keep tokens ≥ 2 chars) so dedup and retrieval see identical tokens. A match requires `≥ CONSOLIDATION.DEDUP_JACCARD_THRESHOLD` (0.7, `src/core/constants.js:120`) (`dedup.js:54-55`); the first match in corpus order wins (`dedup.js:81-87` in tests).
- `jaccard` of two empty token sets returns 0, not 1 (`dedup.js:30`)—zero-content entries never dedup.

## Persona rebuild—`personaRebuild.js` and `raptor/`

`rebuildPersona(chatId, subject, opts)` (`src/consolidation/personaRebuild.js:70`) recomputes the Persona scope for one subject from the episodic store, using the RAPTOR-style cluster-then-summarize pipeline. `opts` is `{ profileId, extractorLabel, signal?, onProgress?, now? }` (`personaRebuild.js:45-51`); `onProgress` always receives `{ stage }` plus a stage-specific payload—`{count}` for `chunk` and `atomic-swap`, `{depth, leaves}` for `knn`, `{depth, gamma}` for `cluster`, `{depth, cluster}` for `summarize`, and no payload for `snapshot`, `summarize-root`, `summarize-root-direct` (emissions at `personaRebuild.js:102,115,130,136,162,187,196,219`). The declared typedef—`{ stage, depth?, clusters? }` (`personaRebuild.js:49`)—is broader than reality: `clusters` is never emitted, so the viewer's destructure (`src/integration/viewer/tabs/persona.js:157-160`) never renders it. An `AbortSignal` is threaded through every async stage—an abort throws an `AbortError` with zero state mutation and temp collections purged (`personaRebuild.js:20-21`). It returns `{ episodicCount, layers, replacedCount, newCount, duration }` (`personaRebuild.js:54-60`).

### Stage 1—read-only snapshot

`loadState` is called **without taking the lock** (`personaRebuild.js:104-113`): a concurrent `consolidate()` can keep running; the snapshot just means summaries may lag the newest entries slightly, and the final swap still persists valid data. Entries are filtered to `scope === 'episodic' && subject === subject` (`personaRebuild.js:108-110`); zero matches throws (`personaRebuild.js:111-113`).

### Stage 2—chunking (identity stub)—`chunking.js`

`chunkEntries(entries)` (`src/consolidation/raptor/chunking.js:37-47`) is an **identity stub in v2.0**: each episodic entry becomes exactly one leaf `{ id: 'leaf_<entryId>_0', sourceEntryIds: [entryId], text, subject }` (`chunking.js:22-27`). The spec's §6.4 semantic chunking (cosine threshold 0.7) is deliberately not implemented—extractor output is already atomic 1-2 sentence facts, and splitting them would fragment rather than coarsen. This module is the v2.1 hook point; the public API stays the same.

### Stage 3—adaptive k-NN graph—`knn.js`

For each depth `d`, `buildKnnGraph(leaves, d, collectionId, signal)` (`src/consolidation/raptor/knn.js:68-140`) builds an undirected similarity graph: `kForDepth(d) = K_BASE + d * K_STEP` = 15 + 5d (`knn.js:41-46`; `K_BASE`/`K_STEP` at `src/core/constants.js:140-142`). Leaves are inserted into a temporary ST Vectors collection (`knn.js:97-101`; collection id `starmem:<chatId>:<subject>:persona-rebuild:<depth>:<Date.now()>` at `personaRebuild.js:129`), each leaf is queried with top-k `k + 1` to absorb the self-hit, self-hits and similarities `≤ 0` are dropped (`knn.js:104-115`), and the directed result is symmetrized by taking the max weight of each pair's two directions (`knn.js:118-132`). The temporary collection is purged in a `finally` block, even on error (`knn.js:135-139`). Fewer than 2 leaves yields an empty graph (`knn.js:88-90`).

### Stage 4—Leiden clustering—`leiden.js`

`leidenCluster(graph, gamma, { seed: 1, signal })` (`src/consolidation/raptor/leiden.js:619-708`) runs the Leiden algorithm (Traag et al. 2019): local moves accept only positive gains (> 1e-10, `leiden.js:293`), the refinement pass applies the well-connectedness filter, aggregation lifts communities to a coarser graph, and the hierarchy is unlifted back onto the original leaves. Resolution shrinks with depth: `gammaForDepth(d) = max(0.01, GAMMA_BASE − d × GAMMA_STEP)` = max(0.01, 1.0 − 0.2d) (`leiden.js:595-600`; `constants.js:144-146`). Node ordering is seeded and deterministic (`leiden.js:209-220`); the outer loop is capped at `LEIDEN_MAX_OUTER_ITERATIONS` (32) and stops on `LEIDEN_TOLERANCE` (1e-6) modularity convergence (`constants.js:152-154`). The depth loop in `rebuildPersona` (`personaRebuild.js:121-177`) stops early when a layer has fewer than `MIN_CLUSTER_SIZE * 2` = 4 leaves (`personaRebuild.js:123-126`) or clustering produced fewer than 2 communities (`personaRebuild.js:140-143`), and `MAX_DEPTH` = 3 caps the hierarchy (`constants.js:148`).

### Stage 5—cluster summaries—`summarize.js`

`summarizeCluster(clusterLeaves, context)` (`src/consolidation/raptor/summarize.js:58-98`) makes **one LLM call per cluster** with `SUMMARY_MAX_TOKENS` = 512 (`constants.js:156`). Depth 0 uses `SYSTEM_PROMPT_LEAF`—distill the cluster's facts into one 2-5 sentence third-person paragraph, preserve names/places/preferences, invent nothing, and state contradictions side by side ("X, though sometimes Y") rather than resolving them (`summarize.js:17-26`); deeper layers use `SYSTEM_PROMPT_LAYER` to combine Persona statements (`summarize.js:28-36`). Each summary carries `sourceLeafIds` = the flat-mapped `sourceEntryIds` of its leaves (`summarize.js:96-97`) and becomes a leaf of the next layer (`personaRebuild.js:160-176`). After the loop, the final root summary fires whenever `currentLeaves.length > 1 && collectedSummaries.length > 0` (`personaRebuild.js:185-191`)—including after the `communityCount < 2` break (`:140-143`) and after the `<4 leaves` break at depth ≥ 1—and is labeled depth `MAX_DEPTH` (`:188-191`). The direct-summary branch (`collectedSummaries.length === 0`, `:192-201`) triggers only when clustering never engaged—1–3 episodic entries leave fewer than `MIN_CLUSTER_SIZE * 2` = 4 leaves at depth 0 (3 < 4)—and summarizes the raw leaves at depth 0, replacing the whole stack. Replacements pair each summary text with the sorted union of its source entries' `provenance.sourceMessages` (`personaRebuild.js:206-217`).

### Stage 6—atomic swap—`atomic.js`

`atomicReplacePersona({ chatId, subject, extractorLabel, replacements, now, signal })` (`src/consolidation/raptor/atomic.js:55-137`) is the pipeline's only long-term mutator:

1. Pre-flight abort check (`atomic.js:69-73`), then `withWriteLock(chatId, …)` (`atomic.js:75`) with a second abort re-check inside the lock (`atomic.js:76-80`).
2. Deletes every existing entry with `scope === 'persona'` and the matching subject (`atomic.js:87-91`).
3. Creates one new `persona` entry per replacement—`{ content, subject, tags: [], relations: [], provenance: { sourceMessages, extractor } }` (`atomic.js:96-110`).
4. Resets runtime: `pendingPersonaRebuild: false`, `episodicCountSinceLastRebuild: 0`, fresh `lastConsolidation` (`atomic.js:122-131`).
5. Persists and returns `{ deletedCount, addedCount }` (`atomic.js:133-135`).

**Dangling edges are intentional:** graph edges pointing at deleted Persona entries are left in place (`atomic.js:6-9`)—Tier 3 retrieval silently skips missing entry ids, and cleaning up would not justify the complexity. A repeated rebuild is idempotent: run 2 replaces exactly the entries run 1 added (`tests/integration/consolidation/personaRebuild.test.js:135-163`).

### Embeddings and the determinism boundary

> **Divergence (drift #2):** the k-NN stage is backed by **embeddings**, via SillyTavern's Vectors extension HTTP API—`/api/vector/insert`, `/api/vector/query`, `/api/vector/purge` (`src/consolidation/raptor/embeddings.js:128-167`). ST never exposes raw vectors, only similarity scores returned by query (`embeddings.js:4-10`); `hashText` (FNV-1a 32-bit, `embeddings.js:49-57`—the same algorithm as the Tier 0 cache's query hash, though the code is not shared: `hashQuery` renders an 8-hex string at `tier0-exact.js:36-42` while `hashText` returns the raw uint32) keys the collection items. This makes persona rebuild **not deterministic** (the embedding model is provider-dependent) and places it **outside the retrieval hot path**—the query path remains BM25 + typed graph with zero model calls ([retrieval.md](./retrieval.md)). Persona rebuild is offline maintenance with no latency budget. The `embeddings.js` client is injectable; `makeSyntheticClient` supplies a deterministic in-memory cosine client for tests (`embeddings.js:221-251`).

### Trigger policy—manual only

> **Divergence (drift #9):** persona rebuild is **never automatic**. `consolidate()` only sets the `pendingPersonaRebuild` runtime flag at 100 added episodic entries (`consolidate.js:240-253`); nothing reads that flag to start a rebuild, and nothing in the UI displays it—the flag is runtime state only (`src/core/schema.js:71` typedef, `consolidate.js:243-250` writer, `atomic.js:127` atomic reset). The sole production caller is the Memory Viewer's Persona tab rebuild button (`src/integration/viewer/tabs/persona.js:10` import, invocation at `persona.js:153`)—see [viewer.md](./viewer.md). The rebuild button is a manual user action unrelated to the flag; persona maintenance is a user decision the flag only records internally.

## Lock usage

`withWriteLock(chatId, …)` (`src/core/lock.js`) serializes all mutation per chat:

- `consolidate()` holds the write lock for its entire run—extraction LLM call included (`consolidate.js:92`). Concurrent triggers serialize; a second call that arrives mid-run either sees `consolidating` at the `maybeConsolidate` pre-check or, if it slips past, blocks on the lock and sees the drained buffer (`tests/unit/consolidation/consolidate.test.js:266-291`).
- `rebuildPersona()`'s snapshot, k-NN, clustering, and summarization stages run **lock-free** against a read-only copy, so a concurrent consolidation is safe; the two collide only on the brief final swap (`personaRebuild.js:15-18`).
- `atomicReplacePersona()` takes the write lock for the swap (`atomic.js:75`)—this is the second and last long-term mutator. "One path per responsibility" is therefore per-concern: one consolidation writer, one persona writer, both lock-guarded (drift #7).
- `clearTraces()` also runs under the lock (`triggers.js:119-127`).

## Constants

Consolidation constants in `src/core/constants.js:110-159`. The four **swept** keys are mutated in place by `setConstantOverrides()` (bench-only, `constants.js:225-246`) and must be read through `CONSOLIDATION` at call time, never destructured at module top (`consolidate.js:47-54`, `triggers.js:25-28`).

| Constant | Value | Consumed by | Status |
| --- | --- | --- | --- |
| `CONSOLIDATION.WORKING_BUFFER_THRESHOLD` | 10 (`constants.js:112`) | `triggers.js:59-61` | Wired, swept |
| `CONSOLIDATION.IDLE_TRIGGER_SECONDS` | 60 (`constants.js:114`) | `triggers.js:75-90` | Wired, not swept |
| `CONSOLIDATION.BATCH_SIZE` | 5 (`constants.js:116`) | `consolidate.js:114` | Wired, swept |
| `CONSOLIDATION.PERSONA_REBUILD_SUGGESTION_THRESHOLD` | 100 (`constants.js:118`) | `consolidate.js:243-244` | Wired, not swept |
| `CONSOLIDATION.DEDUP_JACCARD_THRESHOLD` | 0.7 (`constants.js:120`) | `dedup.js:55` | Wired, swept |
| `CONSOLIDATION.EXTRACT_MAX_TOKENS` | 4096 (`constants.js:134`) | `extractFacts.js:259` | Wired, swept |
| `PERSONA_REBUILD.K_BASE` / `K_STEP` | 15 / 5 (`constants.js:140-142`) | `kForDepth` (`knn.js:41-46`) | Wired, frozen |
| `PERSONA_REBUILD.GAMMA_BASE` / `GAMMA_STEP` | 1.0 / 0.2 (`constants.js:144-146`) | `gammaForDepth` (`leiden.js:595-600`) | Wired, frozen |
| `PERSONA_REBUILD.MAX_DEPTH` | 3 (`constants.js:148`) | depth loop (`personaRebuild.js:121-177`) | Wired, frozen |
| `PERSONA_REBUILD.MIN_CLUSTER_SIZE` | 2 (`constants.js:150`) | stop rule (`personaRebuild.js:123-126`) | Wired, frozen |
| `PERSONA_REBUILD.LEIDEN_TOLERANCE` | 1e-6 (`constants.js:152`) | convergence (`leiden.js:687`) | Wired, frozen |
| `PERSONA_REBUILD.LEIDEN_MAX_OUTER_ITERATIONS` | 32 (`constants.js:154`) | outer loop cap (`leiden.js:661`) | Wired, frozen |
| `PERSONA_REBUILD.SUMMARY_MAX_TOKENS` | 512 (`constants.js:156`) | `summarize.js:90` | Wired, frozen |
| `PERSONA_REBUILD.SYNTHETIC_EMBEDDING_DIM` | 16 (`constants.js:158`) | synthetic test client (`embeddings.js:68-86`) | Test-only; production dimension is provider-dependent |

The full inventory of every runtime tunable, including inert settings values, lives in [constants.md](./constants.md).

## See also

- [architecture.md](./architecture.md)—the module map and write-path lifecycle this page details.
- [data-model.md](./data-model.md)—the `Entry`, runtime, and trace shapes consolidation produces.
- [lifecycle.md](./lifecycle.md)—the `applyUpdateEvent` bump applied on dedup merges.
- [retrieval.md](./retrieval.md)—the read half: Tier 0 invalidation, the trace ring, and the BM25 `tokenize` shared with dedup.
- [memory.md](./memory.md)—`buildEdges` internals behind the add path's edge construction.
- [core.md](./core.md)—`withWriteLock`, `loadState`/`persistState`, and the constants sweep mechanism.
- [integration.md](./integration.md)—the bootstrap event wiring that arms these triggers.
- [viewer.md](./viewer.md)—the Persona tab hosting the only rebuild trigger.
- [drift-register.md](./drift-register.md)—authoritative entries for drifts #2, #3, #7, and #9 cited above.
