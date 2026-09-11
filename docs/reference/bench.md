# Benchmark harness (bench/)

The `bench/` tree is the development-only measurement system: it drives the *real* `src/` modules—the retrieval ladder, the consolidation pipeline, the write lock, and the state backend—through the same public entry points production uses, with an in-memory backend injected in place of `chatMetadata` persistence. It never ships: SillyTavern loads only `index.js` + `src/` at runtime, and `bench/` (like `tests/` and `package.json`) exists solely for development-time evaluation. The tree spans two execution planes—local Node CLIs (JavaScript) and Modal remote dispatch (Python orchestrating the same JS via subprocess)—plus a Python analytics layer. Weave (`weave` at `package.json:34`; `wandb` is pip-side only, installed in the Modal image at `bench/modal/sweep_app.py:13`) provides opt-in trace observability; `bench/harness/trace.js:1-24` documents the split that keeps the `weave` import out of unit-test startup.

Source: the whole `bench/` tree—`cli.js`, `runner.js`, `smoke-determinism.js`, `baselines.js`, `corpora/`, `harness/` (incl. `warmup/`), `metrics/`, `sweeps/`, `baselines/`, `render/`, `diagnose/`, `loaders/`, `analyze/` (Python), `modal/` (Python)—plus `package.json` scripts. Behavior confirmed against `tests/unit/bench/` and `tests/integration/bench/`.

> **baseline.json is a dated measurement, not a spec.** `docs/bench/baseline.json` (asOf `2026-04-23`) records the live-extraction LoCoMo headline—ladder MRR **0.8057** vs bm25only **0.6898** (+0.1159, `structuralInvariants.ladderVsBm25Only.status = "PASS"`), the 9.4.8 gap-axis measurement **0.8077** reproduced within 0.002 noise, and ladder coverage **0.643**. Cite these as measurements of that run; they are not guarantees, and the register in [drift-register](./drift-register.md) tracks what changed since.

## Coupling to src/

`bench/` never reimplements STARmem behavior. Every measurable code path is imported from `src/`:

| Bench module | Drives (src) | Mechanism |
| --- | --- | --- |
| `bench/runner.js:14-26` | `src/retrieval/ladder.js::retrieve`, `src/retrieval/scorer.js`, `src/core/constants.js`, `src/core/state.js`, `src/core/lock.js` | direct import; `retrieve` called per QA item |
| `bench/harness/seeder.js:14-26` | `src/consolidation/index.js::maybeConsolidate`, `src/memory/entry.js::createEntry`, `src/core/schema.js::createEmptyState`, `src/consolidation/llmClient.js` | real consolidation pipeline per turn; extractor installed via `_setLLMClientForTests` (`seeder.js:213`) |
| `bench/baselines/*.js` | `src/retrieval/bm25.js::buildIndex/query`, `src/retrieval/trace.js::buildTrace/logTrace` | baseline retrievers build real traces |
| `bench/harness/warmup/enumerate.js:20-21` | `src/consolidation/extractFacts.js::renderExtractionPrompt`, `src/core/constants.js` | shared prompt SSoT—warmup reproduces production's exact LLM calls |
| `bench/sweeps/*` | `src/core/constants.js::setConstantOverrides/resetConstantOverrides` | sweep knobs mutate live constants, restored after each run |

The in-memory backend is a plain `Map` installed via `setBackend({read, write})` (`seeder.js:203-208`; same pattern in `tests/integration/storage-roundtrip.test.js:17`)—the same injection seam documented in [core](./core.md).

## Local entry points

`package.json:14-19` exposes the local harness as npm scripts:

| Script | Command | Scope |
| --- | --- | --- |
| `bench` | `node bench/cli.js` | one harness pass over a corpus |
| `bench:smoke` | `node bench/cli.js --conversations 1` | 1-conversation smoke |
| `bench:sweep:bm25` / `:graph` / `:consolidation` | the three local sweep CLIs | see [Sweeps](#sweeps) |
| `bench:baselines` | `node bench/baselines.js` | four-way comparison, **LoCoMo only** (`baselines.js:275` calls the deprecated `loaders` `loadLocomo` directly) |

The `hops`, `relw`, `lambda1_tripwire`, and `extract_max_tokens` sweeps have **no npm scripts**—they exist only as `SWEEP_CONFIGS` entries in `bench/modal/sweep_app.py:1866-1939` and run via `modal run ... --mode run-sweep --sweep-name <name>`.

### bench/cli.js

`node bench/cli.js [--corpus locomo] [--conversations N] [--max-items N] [--scorer id] [--overrides "KEY=num,KEY=num"] [--offline] [--out path.jsonl] [--metrics-out path.json]` (`bench/cli.js:1-12`).

| Flag | Default | Notes |
| --- | --- | --- |
| `--corpus` | `locomo` | resolved via `getAdapter`, which throws with the known-name list on typos (`cli.js:85`, `corpora/adapter.js:75-82`) |
| `--conversations` | all | LoCoMo truncation (`cli.js:76`) |
| `--max-items` | all | LongMemEval-S truncation (`cli.js:88`) |
| `--scorer` | active scorer | passed through to `runHarness` (`cli.js:77`) |
| `--overrides` | none | `KEY=num` comma pairs parsed to a number map (`cli.js:61-70`) |
| `--offline` | off | forwarded to the adapter—no network, cache required |
| `--out` | `docs/bench/runs/<YYYY-MM-DD-HH-MM-SS>.jsonl` | one JSON line per run (`cli.js:81, 106-107`) |
| `--metrics-out` | `<out>` with `.jsonl`→`.metrics.json` | metrics + envSnapshot JSON (`cli.js:83, 110-114`) |

### bench/runner.js—runHarness()

`runHarness({corpus, scorerId, overrides, chatIdPrefix, onProgress, retriever})` (`bench/runner.js:89-197`) is the single orchestrator all planes share:

- **Constant overrides + restore**: `setConstantOverrides(overrides)` is captured; a `finally` block restores it *and* resets the state backend and lock map (`runner.js:97`, `192-196`)—every run starts clean and leaves no residue.
- **Weave trace wrapper**: the retriever is wrapped once via `traceRetrieve` (`runner.js:117-120`); when Weave was initialized by the entry point each call becomes a replayable W&B op, otherwise the wrapper is a no-op passthrough (`harness/trace.js:85-89`).
- **Per-conversation seed**: `seedConversation(conv, {chatIdPrefix: 'bench', keepBackend: true})` per corpus item, then `loadState(chatId)` holds the seeded state (`runner.js:129-131`).
- **Per-QA retrieval at k:10**: each QA's question runs through the (possibly wrapped) retriever with `{k: 10}` and wall-clock latency (`runner.js:141-142`).
- **Run record**: one entry per QA with `conversationId`, `qa`, `retrieved` (id/content/`provenance.sourceMessages`/score/tier), `goldTurns`, `traces`, `latencyMs`, `consolidationStats`, `retrieverId` (`runner.js:159-174`).
- **`score` semantics**: the run record's `score` field is `0` unless `tierResolved` is `2` or `3`, in which case the first entry's score is read from `trace.perTier[String(tierResolved)]` (`runner.js:150-157`).
- **envSnapshot**: `{constants: {...RETRIEVAL, ...CONSOLIDATION}, scorerId, nodeVersion, gitSha}` (`runner.js:184-189`). `gitSha` resolves `STARMEM_BENCH_GIT_SHA` → `git rev-parse HEAD` → `'unknown'`, never throwing (the Modal `add_local_dir` incident is documented at `runner.js:31-35`).

### bench/smoke-determinism.js

One-shot determinism check (`bench/smoke-determinism.js`): seeds LoCoMo conversation 1 twice with a fixed clock (`2026-04-20T10:00:00Z`, `:27`), fresh backend and lock map per run (`:61-68`), and compares `stateHash` **and** `factCount` (`:73-76`). Match → exit `0`; drift → exit `2` (`:78-84`). `live` mode sets `STARMEM_BENCH_LIVE_EXTRACTOR=1` and requires the three `STARMEM_BENCH_LLM_*` variables (`:41-49`); the default mode forces the rule-based extractor (`:51`).

### bench/baselines.js—four-way comparison

Runs the corpus through the default ladder, `bm25only`, `recency`, and `random` (`baselines.js:280-285`), emits `docs/bench/baselines/<date>-comparison.md` with an overall metrics table (recall@1/3/5/10, precision@1/3/5/10, MRR, p50/p95), per-category breakdowns, and an interpretation block (`renderReport`, `:177-266`). The interpretation encodes a hard **STOP rule**: ladder MRR within 0.02 of random means a structural scoring bug—"Do not proceed to retro without investigation" (`:221-222`); ladder ≈ bm25only files the scorer chain for investigation (`:223-224`); the healthy ordering ladder > bm25only > recency > random proceeds (`:225-226`). Per-category metrics are computed by **re-running the full harness once per category** (`runOneCategory`, `:141-147, 298-301`)—see [Divergences](#divergences).

## Corpora

Adapters implement the `CorpusAdapter` interface—`{name, loadConversations, metadata: {sourceUrl, cacheKey, itemCount, taskTypes?, multiSession?}}` (`bench/corpora/adapter.js:22-40`)—and self-register into a `Map` at import time via the `bench/corpora/index.js` barrel (`corpora/index.js:9-16`). Two adapters exist:

| | LoCoMo | LongMemEval-S |
| --- | --- | --- |
| Module | `bench/corpora/locomo.js` | `bench/corpora/longmemeval.js` |
| `name` / CLI value | `locomo` | `longmemeval-s` |
| Canonical URL | `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json` (`locomo.js:47-48`) | `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json` (`longmemeval.js:37-38`) |
| Cache file | `bench/.cache/locomo10.json` (`locomo.js:50-53`) | `bench/.cache/longmemeval_s_cleaned.json` (`longmemeval.js:40-43`) |
| `itemCount` | **1986** QA items (`locomo.js:210`) | **500** items (`longmemeval.js:176`) |
| Task types | none (`category` only) | 6: `single-session-user`, `single-session-assistant`, `single-session-preference`, `temporal-reasoning`, `knowledge-update`, `multi-session` (`longmemeval.js:177-184`) |
| `multiSession` | `false` | `true` |
| Abstention | n/a | `question_id` ends `_abs` → `qa.abstention = true` (`longmemeval.js:147, 155`); excluded from scoring by `computeMetrics` |
| Shape | sessions flattened, evidence keys normalized | haystack sessions concatenated in `haystack_session_ids` order (`longmemeval.js:111-125`) |

LoCoMo evidence normalization (`locomo.js:117-144, 163-197`): turn indices are mapped through three key shapes—legacy `S<sid>:T<i>`, the actual v10 shape `D<sid>:<i+1>` (1-indexed within session; day == session), and the raw `dia_id` string verbatim as belt-and-suspenders. Unmatched refs are silently dropped (tolerating malformed entries like the bare `D` observed in ~4 items, `locomo.js:192-195`).

LongMemEval evidence (`longmemeval.js:127-144`): a turn is evidence when `has_answer === true`; if an evidence session (in `answer_session_ids`) has *no* `has_answer` turns, every turn in it is marked evidence as a fallback. Each item flattens to one conversation with a single QA entry carrying both `category` (backward-compat) and `taskType` (`longmemeval.js:149-156`).

## Seeding and extraction

### seeder.js—seedConversation()

`seedConversation(conv, {chatIdPrefix='bench', now=new Date('2026-04-20T10:00:00Z'), keepBackend=false})` (`bench/harness/seeder.js:193-299`) replays a corpus conversation through the real pipeline:

1. Fresh `Map` backend + reset locks (`seeder.js:203-209`), empty state seeded (`:216`).
2. Per turn: `pushWorking` writes a working-scope entry **inside `withWriteLock`** (`:162-181, 226`), then `maybeConsolidate(chatId, 'buffer', {profileId: 'bench', extractorLabel: ...})` fires the real trigger gate (`:228-235`).
3. Residual buffer drained by a loop of `maybeConsolidate(chatId, 'idle', ...)` until a call drains 0—the loop exists because `consolidate()` drains at most `BATCH_SIZE` (5) per call (`:246-270`).
4. Stats accumulate `{added, updated, drained, batches, parseFailures, entriesSkipped, factLengths}` (`:218, 236-243, 282-283`).
5. `stateHash = sha256(JSON.stringify(state.entries))` (`:274-276`); `factCount` counts episodic entries (`:278-280`).

`now` defaults to the fixed timestamp `2026-04-20T10:00:00Z` (`:196`)—deterministic clocks are load-bearing for `stateHash` stability.

### Extractor selection—_resolveExtractor()

`_resolveExtractor()` (`seeder.js:42-62`) is env-gated:

- Default: `source: 'rule-based'`—a heuristic mock that parses the extraction prompt's transcript lines (`[user|assistant|system] text`), sentence-splits, and emits up to 5 entries per batch (`seeder.js:148`—"Cap at BATCH_SIZE") with the first non-stopword capitalized `\b[A-Z][a-z]{2,}\b` token as subject and up to 3 lowercase tags of length ≥ 4 (`:85-152`). The stop-word list is duplicated from `src/memory/edgeBuilder.js` to avoid a breaking export change (`:68-74`).
- Live: requires `STARMEM_BENCH_LIVE_EXTRACTOR=1` **plus** `STARMEM_BENCH_LLM_URL`, `STARMEM_BENCH_LLM_API_KEY`, `STARMEM_BENCH_LLM_MODEL`—each missing variable throws with the variable name (`:48-53`). (Names only; values come from `.env.bench`, which is never committed.)
- `STARMEM_BENCH_NO_CACHE=1` bypasses the on-disk extraction cache (`:56-59`).

### Extraction cache

`wrapWithCache(inner, {dir, model, disabled, stats})` (`bench/harness/extractionCache.js:65-157`) memoizes live extractions on disk. Key: `sha256(model + '\x00' + JSON.stringify(messages) + '\x00' + String(maxTokens))` (`_cacheKey`, `:32-40`)—temperature is always 0 so it is not keyed (`:2-4`). Cache files live under `bench/.cache/extractions/<key>.json` (default dir `seeder.js:28-31`) with `{model, maxTokens, response, at}` in exactly that key order (`:140-149`)—the byte-compat contract remote warmups must reproduce. Corrupt files fall through to the inner call and overwrite (`:5-9`); failed writes log once and continue (`:150-154`). The cache also carries `[diag-task-7-cache-miss]` first-miss diagnostics (`:72-76, 95-134`)—see [Divergences](#divergences).

### llmExtractor.js—retry policy

`makeLLMExtractor({url, apiKey, model, maxRetries = 2})` (`bench/harness/llmExtractor.js:43-125`) posts OpenAI-compatible `/chat/completions` with `temperature: 0` hard-locked (`:61-66`). Retry semantics (code, not the docstring—`:21-23` mentions `Retry-After`, which the implementation does not read): **5xx and network errors retry**, **4xx and malformed responses fail fast** (`:86-91, 96-103, 108-111`), backoff is `min(5000, 200 · 2^attempt)` ms (`:116-119`), and the final error names the attempt count (`:123`).

### concurrencyLimit.js

Hand-rolled p-limit-style limiter (`bench/harness/concurrencyLimit.js:21-52`): FIFO queue, up to K tasks concurrent, a slot frees when a task settles (fulfilled *or* rejected—one rejection does not poison the pool). Zero dependencies by design (SillyTavern extensions cannot use `node_modules` at runtime, `:2-3`).

### Weave tracing

`initWeave(project)` (`bench/harness/trace.js:44-67`) is idempotent and fails soft: `WANDB_DISABLED=1` or `WEAVE_DISABLED=1` short-circuits (`:50-53`); any init failure logs to stderr and permanently disables tracing for the process (`:61-66`). `traceRetrieve(fn, meta)` returns `fn` unchanged when Weave is not ready—op name precedence `meta.name > fn.name > 'retrieve'` (`:85-89`).

## Metrics

`bench/metrics/retrieval.js` defines the entire scoring surface:

- `STANDARD_K = [1, 3, 5, 10]` (`retrieval.js:24`).
- **`matchGoldByEvidence`** (`:138-164`) is the **only** scoring path: a retrieved entry matches iff its `provenance.sourceMessages` (carried as `entry.sourceMessages` by the runner) intersects the QA's `evidenceTurns`—"zero heuristics, zero threshold, zero tokenization" (`:128-132`).
- **precision@k** = |matched ∩ top-k| / k, `NaN` when `matchedIds` is empty, `0` when nothing was retrieved (`:175-184`).
- **recall@k** = |matched ∩ top-k| / |matched|, `NaN` when `matchedIds` is empty (`:196-204`). The old "return 1.0 on empty matchedIds" vacuous-truth default was deleted in 9.4.6 (`:187-189`).
- **MRR** = 1/(rank) of the first matched id, `NaN` when `matchedIds` is empty, `0` when no retrieved id matches (`:213-221`).
- **`computeMetrics(runs, opts)`** (`:238-349`): excludes `qa.abstention === true` runs from scoring (`:241-242`); reports `n` (scorable-run count), `n_scored`, `n_skipped`, and `coverage = n_scored / n` (`:308-316`); aggregates per-k values by **nanmean**—sums of non-NaN contributions over their counts (`:276-306`). When any run carries `qa.taskType`, a `byTaskType` slice is emitted per type (untyped runs bucketed as `__untyped__` but excluded from the slice, `:318-340`); when any run is an abstention, `abstentionCount` is emitted (`:342-346`).

The **deprecated, unused trio** remains exported for provenance: `matchGold` (text-Jaccard gold matcher—the primary cause of Phase 9's "flat sweep" artifact, `:88-97`), `jaccard` (`:77-85`), and `DEFAULT_GOLD_THRESHOLD = 0.5` (`:21`). None are called by `computeMetrics`; the header (`:4-12`) says so explicitly.

## Warmup

Three paths pre-populate the extraction cache so that expensive live LLM calls happen once, keyed identically to how sweeps will read them:

1. **Fireworks Batch Inference (JS).** `bench/harness/fireworks-warmup.js` is a CLI (`submit --corpora <csv> [--model] [--submission-id]` / `resume <id>` / `continue <id>` / `enumerate <out>`, `:4-7, 59-137`) with a job state machine (`normalizeJobState`/`nextState`, `:169-202`) persisted under `bench/.cache/fireworks-warmup/` (`:44-47`). `enumerateWarmupBatches` (`bench/harness/warmup/enumerate.js:45-85`) reproduces the exact `(model, messages, maxTokens)` triples `consolidate()` would produce—prompts come from `renderExtractionPrompt` in `src/consolidation/extractFacts.js` (the shared prompt SSoT, `enumerate.js:20`), `customId = _cacheKey(model, messages, extractMaxTokens)` (`:73`) so each batch id *is* its cache key, and the empty-turn filter matches `seeder.js` byte-for-byte (`:11`). The HTTP client (`warmup/fireworks-batch.js`) implements create-dataset/upload-JSONL/create-job/poll/download with 4xx-fail-fast / 5xx-retry (200 ms ×2, capped 5 s, `:27-32, 87-91`); `ingestResults` (`warmup/cache-ingest.js:26-119`) converts result JSONL into extraction-cache files, accepting both Fireworks BIJ (`response.choices[0]`) and OpenAI Batch (`response.status_code`, `response.body.choices[0]`) shapes, rejecting only explicit non-200 status (`:82-87`), requiring `finish_reason === 'stop'` (`:97-102`), and validating `custom_id` as a basename to block path traversal (`:68-74`, Codex finding #8).
2. **Modal live warmup (parallel Design A).** `bench/harness/_modal-warmup-point.js` bypasses the state pipeline and fires enumerated batches through `concurrencyLimit(K)` (default 16, `:39-41, 68`) against the live LLM, writing the same cache format; correctness contract at `:19-37`. `STARMEM_BATCH_SIZE` is applied via the pure `applyBatchSizeOverride` helper (`warmup/applyBatchSizeOverride.js:31-50`): unset/empty → no override (`null`), invalid → throw, valid positive integer → `setConstantOverrides({BATCH_SIZE: n})`.
3. **Modal vLLM offline batch.** `bench/modal/vllm_warmup.py` runs enumerated `WarmupBatch` entries from `/data/warmup-input.jsonl` through vLLM on a single **H100** (`vllm_warmup.py:188`), writing byte-compatible cache files (`:9-14`; Python `json.dumps(..., indent=2)` matches Node's insertion-order shape when the dict is built in the same key order). It uses the dedicated `vllm/vllm-openai:nightly` image with DeepGEMM JIT kernels cached on their own Volumes (`starmem-vllm-hf-cache`, `starmem-vllm-cache`, `:101-114`).

## Sweeps

### Shared driver—bench/sweeps/_driver.js

`sweep({name, knobs, corpus, primaryMetric, baseOverrides, onComplete, _runHarness})` (`bench/sweeps/_driver.js:221-273`) runs the cartesian product of knob values through `runHarness`, collecting `{overrides, metrics, latencyMs, runs}` points plus a raw JSONL string. `METRIC_ACCESSORS` (`:17-23`) maps `recallAt5`, `recallAt10`, `precisionAt3`, `precisionAt5`, `mrr` to `MetricsResult` fields. `detectElbow` (`:102-163`) sorts each slice by the primary knob, computes consecutive Δmetric/Δknob, and picks the first point where the delta drops to ≤ `ELBOW_RATIO = 0.1` × maxΔ (`:26, 186-187`), choosing among secondary-knob slices by highest primary metric; no elbow found → fallback to the highest-metric point with a stated rationale (`:136-151`). `cartesianProduct` (`:55-67`) handles multi-knob grids.

### Three local sweeps

| Script | Knob(s) | Values | Report |
| --- | --- | --- | --- |
| `bench/sweeps/bm25.js` | `TAG_BOOST` × `SUBJECT_BOOST` (4×4 grid) | `[1,2,3,4]` each (`bm25.js:313-316`) | `docs/bench/sweeps/<date>-bm25.md`—heatmap, flat-heatmap Branch C (<0.01 MRR spread), amendment proposal only when the elbow deviates >50% from current defaults (`:203-216`) |
| `bench/sweeps/consolidation.js` | `DEDUP_JACCARD_THRESHOLD` | `[0.5, 0.6, 0.7, 0.8, 0.9]` (`consolidation.js:288`) | `docs/bench/sweeps/<date>-consolidation.md`—recommends the threshold whose `updateRate` falls in the `[0.2, 0.4]` band, closest to 0.3 (`:194-207`) |
| `bench/sweeps/graph.js` | coordinate descent, 5 rounds | `TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `TIER3_BEAM_WIDTH`, `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT` (`graph.js:224-230`) | `docs/bench/sweeps/<date>-graph.md`—each round's elbow is committed into the next round's `baseOverrides` (`:232-245`) |

The JS graph sweep is **5 rounds without a `TIER3_SEEDS_K` axis**—the Python `GRAPH_ROUNDS` is 6 rounds and adds `seeds_k` (see [Divergences](#divergences)).

### Modal point scripts

`bench/sweeps/_modal-point.js` (one cell: `STARMEM_OVERRIDES` JSON + `STARMEM_BENCH_CORPUS`), `_modal-chunk.js` (adds `STARMEM_ITEM_INDICES` fan-out; echoes `itemIndices` and raw `runs[]` for cell-level recompute), and `_modal-batchsize-point.js` (one conversation × one `BATCH_SIZE` via `STARMEM_CONV_IDX`/`STARMEM_BATCH_SIZE`) are self-running mains: all three hijack `console.log` to stderr and print exactly one JSON payload to stdout for Python's `json.loads` (`_modal-point.js:16-21`, `_modal-chunk.js:25-28`, `_modal-batchsize-point.js:27-30`). `bench/sweeps/_recompute-metrics.js` is the exception—it has **no self-invocation**; it exports `runFromStdin(stdin)` (`:43-53`) and Modal drives it via `node -e`, recomputing metrics once over concatenated chunk `runs[]`. The shared `aggregateConsolidationStats` logic is duplicated in all four files (`_modal-point.js:39-62` notes it "matches bench/sweeps/consolidation.js:137-158 precisely").

## Baselines

`bench/baselines/` ships three alternative retrievers plus the ladder id, used for comparison and Modal dispatch:

| id | Behavior | Site |
| --- | --- | --- |
| `bm25only` | raw `buildIndex` + `query` from `src/retrieval/bm25.js`, no scorer chain; default k 5 | `baselines/bm25only.js:16-41` |
| `recency` | sorts all entries by `lifecycle.updatedAt` descending (ISO string compare; missing values sink) | `baselines/recency.js:39-47` |
| `random` | **deterministic** shuffle: `sha256(query)` first 4 bytes (`readUInt32BE(0)`) seed a Mulberry32 PRNG driving a Fisher-Yates shuffle (`baselines/random.js:21-57, 83-85`) | — |

All three construct traces manually via `buildTrace`/`logTrace` with `tierResolved` set to the retriever id and `scorerId` matching (`bm25only.js:29-39` etc.). `BASELINE_IDS = ['ladder', 'bm25only', 'recency', 'random']` (`baselines/index.js:14`) is what Python's `run_baselines` iterates; `bench/baselines/_modal-point.js` reads `STARMEM_RETRIEVER_ID`, validates against `BASELINE_IDS` (exit 2 on unknown, `:36-40`), and supports stratified subsets via `STARMEM_SAMPLE_INDICES_JSON` (invalid → exit 2/3, `:53-73`).

## Modal / remote (bench/modal/)

`sweep_app.py` (3 467 lines) is the remote orchestrator, app `starmem-bench` (`sweep_app.py:5`):

- **Image**: Debian slim (Python 3.11) + Node 20 via NodeSource + `wandb`/`weave` pip packages (`:7-14`). The repo is baked in via `add_local_dir` from a **hardcoded host path** (`:15-16`—see [Divergences](#divergences)), ignoring `docs/bench/runs/**`, `bench/.cache/**`, logs, and `node_modules` via `FilePatternMatcher` (`:35-41`); `.git` is deliberately kept so `gitSha` stamping works (`:30-34`).
- **Volume**: `starmem-bench-data` mounted at `/data` (`:45`); containers symlink `/data/locomo10.json`, `/data/longmemeval_s_cleaned.json`, and `/data/extractions` over the repo's `bench/.cache/` paths via `_install_volume_symlink`—which first *evicts* a real directory copied in by `add_local_dir`, or writes land on ephemeral storage (`:97-120`, incident log at `:102-104`).
- **Secrets, names only**: `env_secret = modal.Secret.from_dotenv(filename=".env.bench")` (`:53`) and `wandb_secret = modal.Secret.from_name("wandb-secret")` (`:61`, created once via `modal secret create wandb-secret WANDB_API_KEY=<key>` per the comment). Values never appear in the repo; `.env.bench` is read from the host cwd at `modal run` time. Point functions get only `[env_secret]`; orchestrators (`run_sweep`) get `[env_secret, wandb_secret]` (`:2937`).
- **Functions** (all `@app.function`, `volumes={"/data": volume}`):

| Function | Purpose | Notes |
| --- | --- | --- |
| `run_point` (`:271-`) | one sweep cell | `secrets=[env_secret]`, timeout 3000 s, memory 4096; optional `extractor_model` override must match the warm cache's model or every lookup misses (`:283-297`) |
| `run_point_chunk` (`:403-`) | Phase 13 item fan-out cell | chunk plan `max(1, items // 80)` (`:216-251, 3050-3055`) |
| `run_baseline_point` (`:536-`) | one retriever × corpus | — |
| `run_batchsize_point` (`:608-`) | one conversation × one `BATCH_SIZE` | `BATCHSIZE_VALUES = [3, 5, 7, 10, 15]` × `BATCHSIZE_CONV_INDICES = [0..4]`—a 25-cell split sweep (`:1085-1086`) |
| `run_longmemeval_warmup_point` / `run_longmemeval_warmup` (`:679-, 846-`) | live-extraction cache warmup on LongMemEval-S | stratified sampling via `stratified_longmemeval_indices` (`:123-213`—per-`question_type` shuffle + round-robin, deterministic on `(corpus_path, n, seed)`) |
| `run_baselines` (`:1089-`) | 4-retriever fan-out | writes `/data/runs/<ts>-baselines{suffix}/result.json` + `report.md` (`:1163-1183`) |
| `run_sweep` (`:2937-`) | full sweep dispatch | `secrets=[env_secret, wandb_secret]`, timeout 10 800 s; LoCoMo-only for the `batchsize`/`graph`/`consolidation` sub-orchestrators (`:2980-2986`) |

- **Sweep dispatch** (`run_sweep`, `:2937-3060`): `batchsize`/`graph`/`consolidation` route to specialized multi-round runners; everything else reads `SWEEP_CONFIGS`—`bm25` (4×4 grid), `hops` (`TIER3_MAX_HOPS [1,2,3,4]`), `relw` (`EXPLICIT_RELATION_WEIGHT [0.5,1.0,1.5,2.0,3.0]`), `lambda1_tripwire` (`TIER3_LAMBDA_1 [0.5..1.5]` on LongMemEval-S, inlining `BATCH_SIZE=15 + WORKING_BUFFER_THRESHOLD=15` for cache-key alignment with the vLLM warmup), and `extract_max_tokens` (`[2048, 4096, 6144]`, `:1866-1939`). `GRAPH_ROUNDS` (`:1948-1955`) is **6 rounds**—the JS five plus `seeds_k` (`TIER3_SEEDS_K [1,3,5,7]`). Post-Phase-14 `GRAPH_BASE_OVERRIDES` is empty (the `TIER2_TAU_GAP=10` reachability inlining was removed with Tier 2's demolition, `:1957-1963`).
- **Python is authoritative for Modal.** The Python `_detect_elbow`/`_elbow_on_slice`/`_should_amend`/`render_by_task_type` (`:1356-1585`) mirror the JS driver and `bench/render/`, but what Modal actually runs is Python.

Support files: `bench/modal/vllm_warmup.py` (third warmup path, above); `bench/modal/upload_cache.py`—the host-side `modal volume put` recipes plus a `verify()` function reporting corpus/cache presence and sizes (`:6-13, 23-52`); `bench/modal/rerender.py`—offline re-renderer that back-fills `coverage = n_scored / n` into pre-Task-4 JSONs and re-invokes sweep_app's renderers via a stubbed `modal` module (`:22-80`). Its docstring advertises `sweep_name ∈ {tau, bm25, hops, relw, graph, consolidation}` (`:15`), but the dispatch has **no `tau` branch**—`tau` falls through to "Unknown sweep_name" and exit 2 (`:118-128`).

`bench/modal/tests/` is a pytest suite (7 test modules + `conftest.py`) covering the pure Python helpers: elbow detection, stratified sampling determinism, batchsize 5×5 grid shape, corpus parameter threading, baseline report shape + `ladderVsRandom` invariant rendering, `_build_cell_record` chunk walls, and vLLM warmup byte-compat (`test_vllm_warmup.py:77`). `conftest.py` stubs the `modal` package with a real `ModuleType` + selective attributes so tests run without Modal installed; its maintenance contract requires every new `from modal import X` to be mirrored in the stub (`conftest.py:22-27`).

## Analytics (bench/analyze/)

- `bench/analyze/runs.py`—polars-based tabulation of `docs/bench/runs/*.json|jsonl`. `SWEEP_SCHEMA` (`runs.py:53-68`) normalizes four artifact shapes (rounds → points, nested rounds, flat points, baselines-as-knob) into one long-form DataFrame; subcommands `sweeps` (with `--knob`, `--sweep-name`, `--since` filters), `runs`, and `diff` (ΔMRR on shared knob values, `:626`); output formats `md | csv | json | html` (`:666`).
- `bench/analyze/traces.py`—the Weave/W&B side: `fetch_calls` pulls `retrieve` ops from the W&B API and reports latency statistics (p50/p95 per op, `:123-204`), with `--format md|csv|json` (`:328`).

## Output locations

| Location | Producer | Contents |
| --- | --- | --- |
| `docs/bench/runs/` | `bench/cli.js` (`cli.js:81-107`), `--local-out` mirroring | per-run JSONL + `.metrics.json`; sweep mirrors (`sweep_app.py:3320-3335`) |
| `docs/bench/baselines/` | `bench/baselines.js:310-314`, Modal `--mode run-baselines` | `<date>-comparison.md` (+ Modal `{ts}-baselines.{md,json}`) |
| `docs/bench/sweeps/` | the three local sweeps + `rerender.py` | `<date>-{bm25,consolidation,graph}.md` and live re-renders |
| `docs/bench/audits/` | `bench/diagnose/` tools (`ladder-inversion.js`, `render-audit.js`) | dated audit reports (e.g. `2026-04-22-ladder-inversion.md`) |
| `docs/bench/baseline.json` | controller-run baseline | dated headline + `structuralInvariants` |
| `bench/.cache/` | corpora loaders (`locomo10.json`, `longmemeval_s_cleaned.json`), extraction cache (`extractions/`), Fireworks submission state (`fireworks-warmup/`)—gitignored (`bench/.gitignore`) |
| Modal volume `starmem-bench-data` (`/data`) | `modal volume put` + functions | `/data/runs/<ts>-<sweep>/` (`result.json` + `report.md`), `/data/extractions/` (canonical cache), `/data/locomo10.json`, `/data/longmemeval_s_cleaned.json`, `/data/warmup-input.jsonl`, stratified indices files (`sweep_app.py:963`) |
| Modal volumes `starmem-vllm-hf-cache`, `starmem-vllm-cache` | `vllm_warmup.py:101-114` | HF weights (~35 GB FP8) and DeepGEMM JIT kernels |

## Divergences

- **`bench/loaders/` is a deprecated shim.** `loaders/index.js` and `loaders/locomo.js` re-export from `bench/corpora/locomo.js` "kept for backward compatibility during Phase 12; removed in Phase 13 cleanup". They are still imported by `bench/baselines.js:18`, all three local sweeps, `bench/diagnose/ladder-inversion.js`, and `smoke-determinism.js`.
- **Unused metrics trio.** `matchGold`, `jaccard`, `DEFAULT_GOLD_THRESHOLD` are exported but not wired into `computeMetrics` (`bench/metrics/retrieval.js:4-12`).
- **JS vs Python graph rounds.** `bench/sweeps/graph.js:224-230` runs 5 coordinate-descent rounds; `sweep_app.py:1948-1955` runs 6, adding `TIER3_SEEDS_K`. Python is authoritative for Modal runs.
- **Duplicated renderers.** The amendment rule and by-task-type table exist in both JS (`bench/render/amendment-rule.js`, `bench/render/by-task-type.js`) and Python (`sweep_app.py:1492-1585`); the consolidation-stats aggregator is duplicated four times in JS (local consolidation sweep + three point scripts).
- **`rerender.py` tau ghost.** The usage docstring lists `tau` (`rerender.py:15`) but no `tau` render branch exists (`:118-128`).
- **`[diag-task-7-cache-miss]` remnants.** Diagnostic logging blocks in `bench/runner.js:99-109`, `bench/harness/extractionCache.js:72-134`, and `bench/sweeps/_modal-point.js:68-75` are marked "Remove once Phase 12 Task 7 is resolved" but remain.
- **Per-category baseline re-runs.** `bench/baselines.js:298-301` re-runs the full harness once per discovered category instead of filtering one run's results—N× corpus cost per baseline.
- **Hardcoded `add_local_dir` path.** `sweep_app.py:16` bakes in `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem`—machine-specific.
- **No npm scripts for the Modal-only sweeps.** `hops`, `relw`, `lambda1_tripwire`, `extract_max_tokens` are reachable only through `modal run` (`sweep_app.py:3432-3433`).
- **`bench:baselines` is LoCoMo-only.** `bench/baselines.js:273-275` always loads via the deprecated `loadLocomo` shim; no `--corpus` flag.

## See also

- [testing](./testing.md)—the Jest suite that pins the harness contracts (metrics, seeder, sweeps driver, cache-ingest guards).
- [retrieval](./retrieval.md)—the `retrieve()` ladder the harness scores.
- [consolidation](./consolidation.md)—the pipeline `seedConversation` replays and `renderExtractionPrompt`'s origin.
- [constants](./constants.md)—the swept keys `--overrides` and the sweep grids mutate.
- [drift-register](./drift-register.md)—finding #10 (bench divergences) and the dated-`baseline.json` caveat.
