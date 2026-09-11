# Testing

STARmem's test suite is 109 Jest files plus 6 Playwright specs. Jest is the workhorse—unit and integration tiers over the whole `src/` tree plus the bench harness—while Playwright covers only the Phase-15 smoke scope against a live SillyTavern. The suite carries no `.skip`, `.only`, or `.todo` markers anywhere (the single `test.skip(...)` in `tests/e2e/fixtures/st-instance.js:21` is a runtime reachability gate, not a disabled test), so a green run means every file executed. This page catalogs the suite, the injection seams it uses, and the invariant tests that enforce the spec's structural claims as code.

Source: `jest.config.js`, `playwright.config.js`, the whole `tests/` tree, `package.json` scripts (`:7-24`), and the `_setXForTests`/`_resetXForTests` seams they drive in `src/`.

## Jest architecture

`jest.config.js` is deliberately minimal—one flat project, no `projects` array:

| Setting | Value | Meaning |
| --- | --- | --- |
| `testEnvironment` | `'node'` | default env is plain Node (`jest.config.js:2`) |
| `testMatch` | `['**/tests/**/*.test.js']` | every `.test.js` under `tests/`, regardless of tier (`:3`) |
| `transform` | `{}` | no transpilation; Jest runs the repo's native ES2022 modules as-is (`:4`) |
| ESM mode | `node --experimental-vm-modules node_modules/.bin/jest` | the `test`/`test:watch`/`test:coverage` scripts all pass the flag (`package.json:11-13`) |
| `setupFiles` | `tests/helpers/jsdomSetup.js` | runs for **every** test file; no-ops under the node env, polyfills only when jsdom is active (`:6-9`) |
| `collectCoverageFrom` | `src/**/*.js` minus `src/**/index.js` | barrels excluded from coverage (`:10-13`) |
| `coverageThreshold` | — | **absent**; no coverage gates are configured (`jest.config.js`, whole file) |

`tests/helpers/jsdomSetup.js` bridges two jsdom gaps: `structuredClone` (needed by `src/core/state.js`; falls back to a JSON round-trip if the runtime lacks it, `jsdomSetup.js:19-24`) and `TextEncoder`/`TextDecoder` (needed by `src/vendor/sha256.js`, re-attached from `node:util`, `jsdomSetup.js:29-35`).

JSDOM is **opt-in per file** via a `/** @jest-environment jsdom */` docblock—exactly 14 files use it:

- `tests/integration/integration/` (9): `indicator`, `interceptor-injection-mode`, `settingsPanel`, `viewer-mount`, `viewer-tabs-episodic`, `viewer-tabs-graph`, `viewer-tabs-persona`, `viewer-tabs-traces`, `viewer-tabs-working`.
- `tests/unit/integration/` (5): `macro.test.js`, `viewer/episodic-bad-maturity.test.js`, `viewer/episodic-grouping.test.js`, `viewer/viewer-aria.test.js`, `viewer/viewer-keyboard.test.js`.

Gotcha: core Jest is `^29.7.0` while `jest-environment-jsdom` is `^30.3.0` (`package.json:31-32`)—the jsdom env package is intentionally one major ahead; upgrading core Jest to 30 is what would realign them.

## Unit vs integration—a directory convention only

The split is by directory, not by Jest project config: `tests/unit/**` tests modules in isolation (injected fakes, no I/O beyond the file greps a few hygiene tests perform), `tests/integration/**` wires several real modules together. Jest runs both through the same `testMatch`, so the boundary is convention and review, not tooling.

One nested name needs unpacking: `tests/integration/integration/**` is *not* a typo—it is the integration-tier tests **of** the `src/integration/` subsystem (bootstrap, interceptor, settings panel, indicator, viewer). The first path segment is the tier, the second the subsystem. The subsystem also has unit-tier coverage under `tests/unit/integration/` (pure logic: constants, settings normalization, macro, interceptor internals, viewer row logic).

## tests/helpers/stContextMock.js

The SillyTavern context mock is a deliberately narrow fake of `SillyTavern.getContext()` (`stContextMock.js:1-21`), exposing only what STARmem reads: `extensionSettings`, `saveSettingsDebounced`, `chatMetadata`, `saveMetadataDebounced`, `chatId` (default `'test-chat'`), `eventSource`, and `event_types` (`makeStContext`, `:107-117`). Everything else ST exposes—characters, chat, groups, callPopup, slash commands—is **intentionally absent**; the docstring instructs adding fields here rather than inline in a test when a later phase needs them (`:16-18`).

Two notable pieces:

- `makeEventSource()` (`:55-78`) is a *real* pub/sub spy—`emit` synchronously invokes handlers registered via `on`, `off` deregisters, `_handlers` is inspectable, and mid-emit unregistration is safe via set cloning. It is a jest.Mock-wrapped implementation, not a bare mock.
- `ET` (`:29-36`) is a frozen map of the six ST event types bootstrap wires (`APP_READY`, `CHAT_CHANGED`, `MESSAGE_SENT`, `MESSAGE_RECEIVED`, `MESSAGE_DELETED`, `MESSAGE_SWIPED`).
- `installGlobalSillyTavern(ctx)` (`:130-138`) installs the mock on `globalThis.SillyTavern` for code that reads the global directly, returning a teardown that restores the prior value.

The mock has its own self-test: `tests/helpers/stContextMock.test.js`.

## E2E (Playwright)

`playwright.config.js` targets `./tests/e2e` with a single chromium project, `workers: 1`, `fullyParallel: false`, `retries: 0` ("no flake masking"), 30 s test timeout, and `baseURL: 'http://localhost:8000'` (`:13-32`). The critical property: **the fixture does not boot SillyTavern**. `openST(page)` (`tests/e2e/fixtures/st-instance.js:14-29`) navigates to an *already-running* local ST, skips the test with a clear message when :8000 is unreachable, and otherwise waits for ST's `#send_but` as the readiness signal. `expectExtensionLoaded` (`:35-40`) probes the DOM for any `starmem-`-prefixed id or class.

The six specs:

| Spec | Asserts |
| --- | --- |
| `load.spec.js` | extension loads with no console/page errors mentioning STARmem; indicator mounts at the send-form anchor |
| `indicator.spec.js` | indicator defaults to idle; the quiet dot is always visible |
| `settings.spec.js` | settings panel mounts into ST's extensions drawer with the expected fields |
| `viewer.spec.js` | viewer opens/closes, all five tabs render, serif title, episodic subject sort, arrow-key tab navigation |
| `viewer-visual.spec.js` | visual smoke of viewer + tabs |
| `viewer-visual-populated.spec.js` | visual smoke with a populated viewer |

Scope is Phase-15-narrow by declaration (`tests/e2e/README.md:24-38`): real chat synthesis → interceptor → consolidation, indicator pulse on consolidation, settings persistence across reload, and full a11y are explicitly deferred to Phase 16.

## Test catalog by subsystem

Counts: 84 files under `tests/unit/` (13 of them in `unit/integration/`), 24 under `tests/integration/`, 1 helper self-test.

| Area | Files (`tests/…`) |
| --- | --- |
| unit/core | `constants`, `swept-constants-overridable`, `schema`, `state`, `lock`, `logger` |
| unit/memory | `entry`, `graph`, `edgeBuilder`, `index`, `determinism` (see [Invariant tests](#invariant-tests)) |
| unit/lifecycle | `recency`, `importance`, `maturity`, `index` |
| unit/retrieval | `bm25`, `classifier`, `floor`, `scorer`, `tier0-exact`, `tier1-fuzzy`, `tier2-bm25`, `tier3-graph`, `tier-cache-cap`, `trace`, `workingBuffer`, `index` |
| unit/vendor | `vendor/sha256` (FIPS 180-4 vectors + `node:crypto` parity over 256 inputs) |
| unit/consolidation | `consolidate`, `consolidate-trace`, `dedup`, `extractFacts`, `llmClient`, `triggers`, `personaRebuild`, `no-other-mutators` (see [Invariant tests](#invariant-tests)), plus `raptor/`: `atomic`, `chunking`, `embeddings`, `knn`, `leiden` (462 lines—the largest unit file), `summarize` |
| unit/integration | `constants`, `index-barrel`, `interceptor` (lock-before-read regression), `macro`, `settings`, and `viewer/`: `episodic-bad-maturity`, `episodic-grouping`, `episodic-recency`, `traces-cause-badge`, `traces-consolidation`, `traces-tier-labels`, `viewer-aria`, `viewer-keyboard` |
| unit/security | `malformed-metadata`, `prototype-pollution` |
| unit/bench | `runner`, `metrics/retrieval`, `metrics-coverage`, `extractionCache`, `llmExtractor`, `concurrencyLimit`, `amendment-rule`, `render/by-task-type`, `sweeps/driver`, `seeder-live-switch`, `cache-ingest-path-traversal`, `fireworks-warmup-submissionid`, `corpora/` (adapter, locomo, longmemeval), `baselines/` (bm25only, recency, random), `harness/` (seeder, trace, fireworks-warmup-enumerate), `warmup/` (enumerate, cache-ingest, fireworks-batch, applyBatchSizeOverride, fireworks-warmup-cli), `loaders/locomo` |
| integration/bench | `baseline-json`, `cli-mounts-wired`, `runner.integration`, `seeder-ladder-integration` |
| integration/consolidation | `pipeline`, `personaRebuild` |
| integration/retrieval | `ladder` (the ladder end-to-end; see [Invariant tests](#invariant-tests)) |
| integration (top) | `storage-roundtrip` (lock necessity) |
| integration/integration | `bootstrap` (615 lines—the largest test file), `index-mounts-wired`, `interceptor`, `interceptor-injection-mode`, `indicator`, `settingsPanel`, `viewer-mount`, `viewer-tabs-{working,episodic,graph,persona,traces}`, and 4 CSS-contract tests: `css-tokens-defined`, `no-hardcoded-colors`, `no-leaky-css`, `style-css-invariants` |
| helpers | `stContextMock.test.js` (self-test) |

## Invariant tests

These tests encode the architecture's structural claims as executable tripwires:

- **Single-mutator whitelist.** `tests/unit/consolidation/no-other-mutators.test.js` walks every `src/**/*.js` file and fails if non-whitelisted files contain long-term-mutation patterns (`state.entries[x] = …`, `state.graph.edges.push/splice`, `applyUpdateEvent(`, `addEdge(`/`removeEdge(` call sites—`:67-79`). The whitelist (`WHITELIST_PREFIXES`, `:38-57`) covers `src/consolidation/`, the graph primitives called *from* consolidate, state I/O, retrieval cache/trace helpers, the ladder (access events), and the lifecycle definitions. The test declares itself a **heuristic tripwire**—dynamic property access could bypass it; real enforcement is review plus discipline (`:7-9`).
- **Entry-id determinism.** `tests/unit/memory/determinism.test.js` is the regression test for sub-phase 9.4.5: identical `createEntry` fields collapse to the same id regardless of tag order, `null` and `''` subjects normalize identically, `generateEntryId` yields a stable 12-hex suffix, and 1 000 distinct seeds produce 1 000 distinct ids. The header records the motivating incident (random suffix → 374 vs 375 fact drift, `:1-11`).
- **Lock necessity.** `tests/integration/storage-roundtrip.test.js:21-42` proves two concurrent `withWriteLock` mutations both land in order; `:44-70` is the control demonstration—the same interleaving *without* the lock (race window widened by a 10 ms sleep, `:50`) loses exactly one write.
- **Interceptor lock-before-read.** `tests/unit/integration/interceptor.test.js:25` pins the fix for Codex finding #12: `loadState` must happen inside `withWriteLock`, verified by instrumenting the backend's `read()` seam and asserting the chat is locked at read time (`:30-35`)—jest.spyOn on ESM exports is unavailable, so the backend seam is the hook.
- **Tier-2 demolition.** `tests/integration/retrieval/ladder.test.js:135-150` asserts `retrieve()` **never** returns `tierResolved: 2`—even a state engineered for the old tau-confidence shortcut must resolve `3` or `'floor'`; `:152-167` pins the surviving contract that `trace.perTier['2']` still carries the BM25 candidates that seeded Tier 3.
- **Swept-constant call-time reads.** `tests/unit/core/swept-constants-overridable.test.js` drives `setConstantOverrides`/`resetConstantOverrides` and verifies consumers observe override values (the mechanism the sweep grids depend on; see [core](./core.md)).
- **CSS contracts.** Four tests make the stylesheet's discipline executable: `css-tokens-defined.test.js` (every used `var(--starmem-*)` resolves to a definition), `no-hardcoded-colors.test.js` (no inline color literals in `src/integration/`—colors only via tokens or theme-aware classes), `no-leaky-css.test.js` (every class/id is `starmem-`-prefixed or explicitly whitelisted), and `style-css-invariants.test.js` (selector hygiene, ≤3 `!important`, `--SmartTheme*` fallbacks, single `(max-width: 639px)` breakpoint).

## Test-injection surface in src/

The suite never reaches into module internals—`src/` exposes explicit seams, and tests use those:

| Seam | Definition | Used by |
| --- | --- | --- |
| `setBackend(b)` / `_resetBackendForTests()` | `src/core/state.js:61, 69` | every test touching state; bench seeder too |
| `_resetLocksForTests()` / `_getLockSetForTests()` | `src/core/lock.js:55, 60` | lock tests, storage round-trip, interceptor |
| `setConstantOverrides` / `resetConstantOverrides`, `_SWEPT_*_KEYS` | `src/core/constants.js:189-258` | sweep tests, swept-constants test |
| `registerScorer(id, fn)` / `setScorer(id)` / `_resetScorerForTests()` | `src/retrieval/scorer.js:65, 85, 103` | ladder, tier-3, bench baseline tests |
| `_setLLMClientForTests(fn)` / `_resetLLMClientForTests()` | `src/consolidation/llmClient.js:78, 86` | consolidation pipeline tests; bench seeder |
| `_setEmbeddingClientForTests(c)` / `_resetEmbeddingClientForTests()` | `src/consolidation/raptor/embeddings.js:257, 265` | raptor kNN/persona tests |
| `_resetTimersForTests()` | `src/consolidation/triggers.js:107` | idle-timer tests |
| `_setContextForTests(ctx)` / `_resetContextForTests()` per module | `bootstrap.js:43`, `interceptor.js:68`, `macro.js:38` (+`_clearMemoryBodiesForTests:78`), `settings.js:50`, `settingsPanel.js:32`, `viewer/mount.js:22` | integration-tier context injection instead of global monkey-patching |

Recurring patterns:

- **No `jest.mock` anywhere** in `tests/`—ESM read-only bindings make the classic API unusable. The single exception in the whole suite is `jest.unstable_mockModule` in `tests/integration/integration/viewer-tabs-persona.test.js` (`:7-9`—mocking `rebuildPersona` from the `src/consolidation/index.js` barrel for the persona tab).
- **Backend injection** over mocking: an in-memory `Map` backend stands in for `chatMetadata` persistence.
- **Fake timers** for consolidation idle-trigger tests (`tests/unit/consolidation/triggers.test.js:119-120`).
- **Top-level `await import`** for tests that must re-import modules after resets or behind env flips (e.g. `tests/unit/bench/harness/seeder.test.js`, `tests/unit/bench/seeder-live-switch.test.js`, `tests/unit/consolidation/raptor/knn.test.js`).

## Coverage gaps

- **`src/consolidation/index.js` barrel is untested**—and also excluded from coverage collection by the `collectCoverageFrom` barrel exclusion (`jest.config.js:10-13`).
- **Bootstrap is only tested through a mocked context.** `tests/integration/integration/bootstrap.test.js` exercises the real hook logic against `makeStContext`, never a live ST.
- **The ladder has no unit-tier test**—it is covered only end-to-end via `tests/integration/retrieval/ladder.test.js` (the unit tier covers each tier module separately).
- **The viewer graph and persona tabs are tested only under the integration tier** (`tests/integration/integration/viewer-tabs-graph.test.js`, `viewer-tabs-persona.test.js`); the unit tier covers episodic and traces row logic only.
- **`src/eval/` is an empty directory**—nothing to test, nothing covered.
- **The Python bench tree is outside Jest entirely**—`bench/modal/tests/` runs under its own pytest suite with a stubbed `modal` package (`bench/modal/tests/conftest.py`), and nothing in `npm test` executes it.

## Known fragility

- **No statically skipped tests.** No `.skip`/`.only`/`.todo` marker is committed statically—the one conditional exception is a documented `test.skip(true, …)` in the e2e fixture (`tests/e2e/fixtures/st-instance.js:21`, fires only when the live ST is unreachable). A broken test fails CI; there is no general way to park one—deliberate, per the suite's determinism stance.
- **Real-time debounce waits.** The viewer subject-filter test sleeps real wall-clock time for the debounce (`tests/integration/integration/viewer-mount.test.js:65` waits 200 ms) rather than using fake timers—correct but latency-bearing.
- **One widened timing assertion.** `tests/unit/bench/loaders/locomo.test.js:8-10` gives its `beforeAll` a 30 000 ms timeout (`offline: false` at `:9`) because it fetches the real LoCoMo corpus—the only network-dependent Jest test, and the only explicit timeout override.
- **Fake-timer/fake-async mix in the triggers tests.** `tests/unit/consolidation/triggers.test.js:119-147` advances fake timers while awaiting real microtasks (`await Promise.resolve()` ×2, then `jest.runAllTimersAsync()`), because consolidation awaits `loadState` → lock → extractFacts underneath the timer.
- **Storage-roundtrip race window.** The lock-free control demonstration (`storage-roundtrip.test.js:50`) relies on a 10 ms sleep to widen the race; on a sufficiently fast or slow scheduler the "one write lost" assertion could theoretically flake—it is a demonstration, not a deterministic property.

## See also

- [bench](./bench.md)—the harness these bench tests pin (metrics formulas, seeder flow, sweep driver, cache-ingest guards).
- [core](./core.md)—the state backend, lock, and swept-constant seams the injection surface exposes.
- [architecture](./architecture.md)—the lifecycles the invariant tests enforce.
- [data-model](./data-model.md)—the entry-id derivation pinned by `determinism.test.js`.
- [drift-register](./drift-register.md)—statuses for the modules whose wiring the catalog flags.
- [constants](./constants.md)—the live/inert settings the integration-tier tests distinguish.
