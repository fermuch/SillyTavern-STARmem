# Drift register

The canonical list of places where the shipped code diverges from the design-of-record spec (`docs/specs/2026-04-20-starmem-v2-design.md`) or from older top-level docs. Every reference page in this directory describes **code truth**—where code and spec disagree, the code wins and the disagreement is recorded here, while the spec keeps its design intent unedited (an errata note points here). "Drift" therefore covers three kinds of facts: spec claims the code never implemented or later demolished, doc claims that went stale, and code that is defined but never wired into a production path.

**ID scheme.** Entries #1–#10 are the ten findings from the 2026-09-11 documentation-plan reconnaissance; their numbers are stable and are cross-referenced as "drift #N" throughout the reference pages. Additions discovered while line-verifying the T1–T6 pages continue the sequence as #11 onward. No entry is ever renumbered.

**Statuses.** `open` (real gap, no decision made yet), `intentional` (code diverges from spec wording by design; spec stays), `documented` (recorded here and in the affected reference page; no action needed beyond that), `needs-fix` (a doc or errata change is required—the spec errata and top-level doc rewrites land in the T8 task). Where a code-side divergence is intentional but a doc-side fix is still pending, both are stated.

**Last full audit:** 2026-09-11, against `main` @ `801909b` plus this branch's working state. Evidence citations are into that tree; line numbers refer to the code as it stands on `docs/overhaul`.

---

## #1—Tier 2 is not a resolver

**What the spec/docs said:** Spec §5's ladder table (`docs/specs/2026-04-20-starmem-v2-design.md:111`) still describes Tier 2 as resolving a query when "Top score ≥ τ_confidence AND gap ≥ τ_gap", with a <50ms budget for that decision.

**What the code does:** Tier 2 was demolished as a resolver (Phase 12 Task 1; tau constants removed in Phase 14 Task 2). `tier2()` returns `{ scored }` only—there is no `hit` field and no tau gate (`src/retrieval/tier2-bm25.js:31` typedef, returns at `:52`, `:58`, `:95`, `:98`). The ladder uses Tier 2 purely to produce seeds for Tier 3 (`TIER3_SEEDS_K = 3`): `src/retrieval/ladder.js:201` calls it, `:204-205` slices seeds, and `:209-213` falls through to the Floor branch (with the Tier 2 scores preserved in the trace) when Tier 3 yields nothing. `tierResolved` is never `2`—the demolition invariant is pinned by `tests/integration/retrieval/ladder.test.js:135-150`. A persisted legacy trace with `tierResolved: 2` renders as `T3` in the viewer (`src/integration/viewer/tabs/traces.js:107`).

**Impact:** Conceptual, not behavioral: every non-cached query runs BM25 + graph expansion; there is no BM25 shortcut tier. Readers of the spec's ladder table will mis-model the cost profile.

**Status:** needs-fix—the T8 spec errata corrects §5. [retrieval](./retrieval.md) already documents the seed-only design.

## #2—Embeddings are used, on the Persona rebuild path only

**What the docs said:** README and AGENTS state "No vector DB. No embeddings." without qualification.

**What the code does:** `src/consolidation/raptor/embeddings.js` is a real HTTP client for SillyTavern's Vectors extension—`/api/vector/insert`, `/api/vector/query`, `/api/vector/purge` (`embeddings.js:3`, `:129`, `:139`, `:159`)—and `src/consolidation/personaRebuild.js` depends on it for the adaptive k-NN stage. The **retrieval query path** is genuinely embedding-free and LLM-free: no model call appears anywhere in `retrieve()`'s branch tree.

**Impact:** The unqualified README/AGENTS claim is false as an absolute statement; the "retrieval path only" scope is the accurate claim. Persona rebuild is also non-deterministic (provider-dependent embedding model) and outside any latency budget.

**Status:** needs-fix—T8 adds the caveat to README/AGENTS. The code itself is intentional design. See [consolidation](./consolidation.md) (drift #2 callout).

## #3—Settings buffer/idle sliders are inert

**What the docs said:** The settings panel presents `bufferSize` and `idleTimeout` (plus `tracesMaxLen`, `debugMode`, `embedProfileId`) as live configuration.

**What the code does:** `SETTINGS_DEFAULTS.bufferSize = 5` and `idleTimeout = 60_000` (`src/integration/constants.js:94-95`) are persisted, validated, clamped to bounds, and exposed in the panel—but **no runtime code reads them**. Consolidation uses the hardcoded `CONSOLIDATION.WORKING_BUFFER_THRESHOLD = 10` and `IDLE_TRIGGER_SECONDS = 60` (`src/core/constants.js:112,114`; consumed at `src/consolidation/triggers.js:59` and `triggers.js:28,87`). The same applies to `tracesMaxLen` (live cap is `TRACE_BUFFER_CAP = 128`), `debugMode` (the logger's debug channel never reads it), and `embedProfileId` (persona rebuild uses `profileId`). `settingsPanel.js` is the only writer of the inert five (`src/integration/settingsPanel.js:177-178`, `:189-190`, `:202-203`, `:221`, `:253`); `validateSettings` only coerces and clamps (`src/integration/settings.js:97-121`). The genuinely live settings are `profileId`, `extractionModelLabel`, `scorerId`, and `injectionMode/Position/Depth/Role`.

**Impact:** Five user-facing controls do nothing. The `idleTimeout` default (60 000 ms) coincidentally matches `IDLE_TRIGGER_SECONDS = 60`, which hides the disconnect.

**Status:** open—wire the settings or remove the controls; the decision is out of scope for the docs branch. [integration](./integration.md) and [constants](./constants.md) document the wired/inert split.

## #4—Lifecycle decay and maturity are implemented but unwired

**What the spec/docs said:** Spec §7 describes daily importance decay as a scheduled effect and maturity promotion/demotion as part of the entry lifecycle.

**What the code does:** `applyDailyDecay()` (`src/lifecycle/importance.js:73-78`, decay factor `LIFECYCLE.DAILY_DECAY = 0.995^days`) and `maturityFor()` (`src/lifecycle/maturity.js:31`, hysteresis over `PROMOTION`/`DEMOTION` thresholds) have **no callers in `src/` outside tests**. Entries stay `maturity: 'draft'` forever. `applyAccessEvent` (+3) and `applyUpdateEvent` (+5) DO run—called from `src/retrieval/ladder.js:78` and `src/consolidation/consolidate.js:217`—so `importance` moves, but tier never changes. The Tier 3 default-scorer path multiplies by `recencyAt` and `maturityBoost` (`src/retrieval/scorer.js:45-48`), so the in-effect maturity boost is permanently the draft value `0.85`.

**Impact:** Importance rises monotonically and never decays; the validated/core tiers, their boosts, and both hysteresis threshold pairs are dead configuration.

**Status:** open—wiring decay/maturity is a design decision, not a doc fix. [lifecycle](./lifecycle.md) documents per-function wiring status.

## #5—`AGENTS.md` is stale ("scaffold only")

**What the docs said:** AGENTS.md claims the repo is "scaffold only" and that `src/` and `tests/` "do not exist yet".

**What the code does:** Both trees are fully populated (~8K LOC runtime, ~14K LOC tests).

**Impact:** Any AI assistant or contributor onboarding from AGENTS.md starts with a false model of the repository.

**Status:** needs-fix—T8 rewrites AGENTS.md.

## #6—Trace ring buffer cap is 128, not the spec's 100

**What the spec/docs said:** Spec §9.1 puts the retrieval trace ring at 100 entries.

**What the code does:** `TRACE_BUFFER_CAP = 128` (`src/core/constants.js:162`), enforced by `logTrace` eviction at `src/retrieval/trace.js:46`. This is the recorded resolution of the spec's §12.4 "make configurable" open item—default 128, settings hook deferred. The inert `tracesMaxLen` setting (drift #3) defaults to the same 128 but is not connected.

**Impact:** Cosmetic-scale divergence; the code value is the deliberate resolution of a spec open item.

**Status:** documented. [retrieval](./retrieval.md) and [constants](./constants.md) cite 128.

## #7—"Single mutation path" is per-concern, not literally one function

**What the docs said:** The spec's "one path per responsibility" principle reads as one mutator for persisted state.

**What the code does:** Long-term storage is mutated by `consolidate()` (`src/consolidation/consolidate.js:74`, under `withWriteLock` at `:92`) **and** `atomicReplacePersona()` (`src/consolidation/raptor/atomic.js:55`); working-buffer state is mutated by the bootstrap chat-lifecycle hooks (`src/integration/bootstrap.js:242` append, `:293` and `:359` swipe/regenerate scrub). All mutation runs under the same per-chat `withWriteLock`. The real rule is encoded as a whitelist in `tests/unit/consolidation/no-other-mutators.test.js:38-57`: `src/consolidation/`, graph primitives called from consolidate, state I/O, retrieval cache helpers, the ladder (access-event bumps), and the lifecycle definitions—everything else must be read-only.

**Impact:** The principle holds as "per-concern single writer, one write lock"—it does not hold as "one function touches state".

**Status:** intentional—the spec wording is looser than the enforced invariant; no doc fix needed beyond this register.

## #8—Scorer pluggability is partial

**What the docs said:** Spec §9.2 describes a pluggable scorer registry on the retrieval path.

**What the code does:** Tier 3 consults the registry (`getScorer()` at `src/retrieval/tier3-graph.js:13,91,96`), but Tier 2 deliberately bypasses it and inlines the default formula (`src/retrieval/tier2-bm25.js:61-66`), and the settings UI only ever offers `'default'`—`getAvailableScorerIds()` hardcodes the list because no `listScorers()` API exists (`src/integration/settingsPanel.js:70-72`). The registry itself works (`src/retrieval/scorer.js:52-106`); alternates are registered only by tests (the bench harness imports only `getScorerId`, `bench/runner.js:22`).

**Impact:** A registered alternate scorer changes only Tier 3's ranking; the settings panel cannot expose one anyway.

**Status:** open—`TODO(phase-9)` exists only in `src/integration/settingsPanel.js` (`:12`, `:64`) and asks for `listScorers()`; finishing pluggability is a code decision.

## #9—Persona rebuild is never automatic

**What the docs said:** Spec §6.4 reads as though the suggestion threshold triggers a rebuild.

**What the code does:** `consolidate()` flips `runtime.pendingPersonaRebuild` when the count of added Episodic entries reaches `PERSONA_REBUILD_SUGGESTION_THRESHOLD = 100` (`src/consolidation/consolidate.js:240-253`), and `atomicReplacePersona()` resets it (`src/consolidation/raptor/atomic.js:127`)—but **nothing reads the flag to start a rebuild**. The sole production caller of `rebuildPersona()` is the Memory Viewer's Persona tab rebuild button (`src/integration/viewer/tabs/persona.js:10` import, `:153` invocation).

**Impact:** Persona maintenance is a user decision—the flag records it internally and is never surfaced to the UI; no surprise LLM+embedding spend from background rebuilds.

**Status:** intentional (arguably deliberate design—the flag is a suggestion, the human decides). [consolidation](./consolidation.md) and [viewer](./viewer.md) document the manual-only behavior.

## #10—Bench harness divergences

**What the docs said:** The bench docs imply JS and Python harnesses are equivalent views of one pipeline.

**What the code does:** Several deliberate-but-uneven divergences between the local JS harness and the Python/Modal harness (Python is authoritative for Modal runs):

- `bench/loaders/*` are deprecated re-export shims for `bench/corpora/*` (`bench/loaders/index.js:2`, `locomo.js:2-3`)—still imported by `bench/baselines.js:18`, the local sweeps, `bench/diagnose/ladder-inversion.js`, and `smoke-determinism.js`.
- The JS graph sweep runs **5** coordinate-descent rounds (`bench/sweeps/graph.js:224-230`); Python `GRAPH_ROUNDS` runs **6**, adding a `TIER3_SEEDS_K` axis (`bench/modal/sweep_app.py:1948-1954`, loop at `:2185`).
- The amendment-rule and by-task-type renderers are duplicated in JS (`bench/render/amendment-rule.js`, `bench/render/by-task-type.js`) and Python (`sweep_app.py:1492-1585`); the consolidation-stats aggregator is duplicated four times in JS alone.
- Further items catalogued in [bench](./bench.md#divergences): the unused metrics trio (`bench/metrics/retrieval.js:4-12`), `[diag-task-7-cache-miss]` remnants, per-category baseline re-runs, the hardcoded `add_local_dir` host path (`sweep_app.py:16`), no npm scripts for the Modal-only sweeps, and `bench:baselines` being LoCoMo-only.

**Impact:** Numbers produced by the two harnesses are comparable only if you know the divergence list; the loaders shim keeps dead imports alive.

**Status:** documented—known, catalogued, and accepted for the current phase; parity cleanup is out of scope for the docs branch.

---

## #11—`isValidEntry` is defined but unwired (with a stale comment)

**What the docs said:** `src/memory/entry.js:151-152` claims the validator is "Used by persist/load to reject malformed state".

**What the code does:** `isValidEntry` (`entry.js:157`) has no call site in `src/`—it is referenced only by the barrel export (`src/memory/index.js:9`) and comments (`src/core/state.js:76`, `src/core/schema.js:5`). Load/persist enforce shape via `looksLikeState` (`src/core/state.js:81-93`), not this validator; the test suite is its only exerciser.

**Impact:** The comment overstates the safety net; deep validation does not happen on the persistence path.

**Status:** documented—[memory](./memory.md) flags it; the stale source comment is itemized under #15.

## #12—`listEdges` is defined but unwired

**What the docs said:** Nothing—the export looks like part of the graph API surface.

**What the code does:** `listEdges(state)` (`src/memory/graph.js:69-71`) is re-exported by the barrel (`src/memory/index.js:13`) but never called by production code; tests only.

**Impact:** Dead public API surface; harmless.

**Status:** documented—[memory](./memory.md).

## #13—`QUERY_INTENTS` is defined but unwired

**What the docs said:** `src/core/constants.js:18-19` presents `QUERY_INTENTS` as the classifier's intent set.

**What the code does:** No consumer in `src/`—the classifier hardcodes its own regex lists and returns the intent strings as inline literals (`src/retrieval/classifier.js:13-31`). Only the test suite imports the constant.

**Impact:** The constant can drift from the classifier without anything failing.

**Status:** documented—[core](./core.md) and [constants](./constants.md) flag it. A cleanup (making the classifier consume the constant) is out of scope for the docs branch.

## #14—Logger debug channel is unwired

**What the docs said:** `src/core/logger.js:47` promises debug output can be flipped "via settings later".

**What the code does:** Every `createLogger` call site in `src/` passes `debug: false` (13 sites, including the root default at `src/core/logger.js:48`), the settings system's `debugMode` is inert (drift #3), and nothing else flips the channel at runtime. Enabling debug output currently requires a code change.

**Impact:** The debug tier of the logger is dead code in production; the promised settings hook never landed.

**Status:** open—[core](./core.md) documents it. Wiring `debugMode` → logger would close this together with #3.

## #15—Stale comments in source

A batch entry for source comments that no longer describe the code. Each is wrong at its citation site; the code itself is correct and documented in the reference pages. Cleanup is out of scope for the docs branch.

| Site | Comment claims | Code reality |
| --- | --- | --- |
| `src/retrieval/tier2-bm25.js:3` | "Returns `{ hit, scored }`" | Returns `{ scored }` only (`:31`, `:52`, `:58`, `:95`, `:98`)—drift #1 |
| `src/memory/entry.js:151-152` | `isValidEntry` "Used by persist/load" | Unwired (drift #11) |
| `index.js:54-57` | "Top-level await … We use it over an IIFE" | The module registers an APP_READY callback inside a synchronous try/catch—no `await` expression exists |
| `tests/unit/core/swept-constants-overridable.test.js:16-18` | `BATCH_SIZE` listed among "non-swept keys" | `BATCH_SIZE` is in `_SWEPT_CONSOLIDATION_KEYS` (`src/core/constants.js:206`) and the test overrides it (`:152-158`) |
| `bench/harness/llmExtractor.js:22` | Retries "sleep max(200ms, Retry-After * 1000) with ×2 backoff" | Fixed exponential backoff `min(5000, 200·2^attempt)` ms at `:117`—no `Retry-After` header is ever read |

**Status:** documented here; the source comments remain stale.

## #16—`rerender.py` accepts a `tau` sweep that no longer exists

**What the docs said:** `bench/modal/rerender.py:11-15` documents `sweep_name ∈ {tau, bm25, hops, relw, graph, consolidation}` with a worked `tau` example re-rendering a historical tau artifact.

**What the code does:** The dispatch at `rerender.py:118-128` handles only `bm25`, `hops`/`relw`, `graph`, and `consolidation`; `tau` falls through to "Unknown sweep_name" and exits 2. The tau sweep was demolished along with `TIER2_TAU_CONFIDENCE`/`TIER2_TAU_GAP` (drift #1), so the docstring's tau branch is a ghost of a removed sweep.

**Impact:** Following the docstring's own example fails.

**Status:** documented—[bench](./bench.md#divergences).

## #17—`_recompute-metrics.js` has an entry contract but no main

**What the docs said:** The file is shaped like a standalone script—`#!/usr/bin/env node` shebang and a stdin→stdout filter contract in its header (`bench/sweeps/_recompute-metrics.js:1-11`).

**What the code does:** The file exports `runFromStdin(stdin)` (`:43`; the export-and-no-self-invocation tail is `:44-53`) but never invokes it—executed directly it does nothing. The caller is the Python side, which shells out a dynamic-import one-liner (`bench/modal/sweep_app.py:2906-2907`). Contrast the three point scripts, which do self-execute (`main().catch(...)` at `bench/sweeps/_modal-point.js:106`, `bench/sweeps/_modal-batchsize-point.js:64`, `bench/baselines/_modal-point.js:105`).

**Impact:** Minor: the shebang suggests direct executability that does not exist; the real invocation lives in Python.

**Status:** documented.

---

## What would close these

- **#1, #2, #5** close with the T8 deliverables: the marked errata block on the spec (pointing here) and the README/AGENTS rewrites.
- **#3** closes when the inert settings are either wired (`bufferSize`/`idleTimeout`/`tracesMaxLen`/`debugMode`/`embedProfileId`) or removed from the panel—a product decision, deliberately not made in this branch.
- **#4** and **#14** close together when decay/maturity are scheduled (or explicitly retired) and `debugMode` reaches the logger.
- **#8** closes when `listScorers()` lands and the panel stops hardcoding `['default']`.
- **#15** closes with a comment-cleanup pass; #11–#13, #16, #17 with small code cleanups. All are **out of scope for this docs branch**.
- **#6, #7, #9, #10** need no action: they are the recorded resolutions of spec open items or deliberate design, kept here so the reasoning survives.

## See also

- [README](./README.md)—purpose of the reference set and the code-truth rule this register enforces.
- [constants](./constants.md)—the full tunable catalog with Live/Swept/Inert status per constant.
- [retrieval](./retrieval.md)—drift #1, #6, #8 in context.
- [consolidation](./consolidation.md)—drift #2, #3, #7, #9 in context.
- [integration](./integration.md)—drift #3, #8 in context.
- [lifecycle](./lifecycle.md)—drift #4 in context.
- [memory](./memory.md)—drift #11, #12 in context.
- [core](./core.md)—drift #13, #14 in context.
- [viewer](./viewer.md)—drift #1, #9 in context.
- [bench](./bench.md)—drift #10, #16, #17 in context.
