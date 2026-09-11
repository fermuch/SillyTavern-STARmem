# STARmem—repository notes for AI assistants

This is **STARmem v2**, a clean-break rewrite. If you were trained on or have seen v1 (`SillyTavern-STARmem` at `/home/opus/SillyTavern/...`), forget its architecture—this is a different project.

## Start here

1. **Code truth first:** `docs/reference/`—the reference doc set describing implemented behavior, every claim cited `file:line`. Start at `docs/reference/README.md`.
2. **Known divergences:** `docs/reference/drift-register.md`—the canonical list of spec-vs-code divergences. Read it before trusting the spec's details.
3. **Spec:** `docs/specs/2026-04-20-starmem-v2-design.md`—approved design-of-record (intent, not code truth; its errata note points at the drift register).
4. **Paper rationale:** `docs/wiki/`—per-paper notes with our adaptation/rejection rationale.

## Core rules (from spec §2)

1. **Deterministic retrieval, always.** No LLM call on the query path. Ever.
2. **One path per responsibility.** One extraction function, one consolidation function, one retrieval ladder, one write lock. Many readers, single mutator.
3. **Honest instrumentation.** Every retrieval produces a replayable trace. Benchmarks are a v2.0 subsystem, not an afterthought.

Two nuances the code enforces:

- "Single mutator" is **per concern**, not one function: long-term storage is written by `consolidate()` and by the atomic persona swap; working-buffer state by the bootstrap hooks. All of it runs under the same per-chat `withWriteLock`. The real rule is the whitelist in `tests/unit/consolidation/no-other-mutators.test.js`.
- "Deterministic" scopes the **retrieval query path**—embedding-free and LLM-free. Embeddings exist in exactly one place: the Persona rebuild pipeline (`src/consolidation/raptor/embeddings.js`), which calls ST's Vectors API for k-NN.

## What exists right now

The full implementation, shipped:

- `src/`—the runtime, ~8K LOC: retrieval ladder, consolidation + RAPTOR persona rebuild, integration (bootstrap, interceptor, settings, viewer), core (state, lock, constants, schema).
- `bench/`—the benchmark harness, ~13K LOC across a local JS CLI (`bench/cli.js`) and the Python/Modal remote harness.
- `tests/`—109 Jest files (~14K LOC) plus 6 Playwright e2e specs. No statically skipped tests.

## How SillyTavern loads this extension (critical)

**SillyTavern installs extensions via `git clone` only.** The user clones this repo into `public/scripts/extensions/third-party/SillyTavern-STARmem/` and ST loads `index.js` directly in the browser. **There is no build step. There is no `npm install` at install time.**

This means:

- **`package.json` is development-only.** `eslint`, `jest`, `typescript`, and anything in `devDependencies` exist solely for lint/typecheck/test at development time. **They are not available at runtime.**
- **`dependencies` must stay empty** (or at most contain libraries we've bundled into a single file via rollup and committed—we have not opted into this yet).
- **Runtime code (`index.js`, `src/**/*.js`) cannot `import` from `node_modules`.** Only valid imports are: relative paths inside this repo (`./src/...`), and SillyTavern's own exposed modules (`../../../../script.js`, `../../../extensions.js`, etc.).
- **No transpilation.** The code that runs in the browser is the code in the repo, as-is. Target: modern ES2022 modules, no TypeScript emit, no Babel.

If you find yourself wanting to `npm install <runtime-lib>`, stop. Either find a pure-JS implementation to vendor in `src/vendor/`, or implement it yourself. BM25, Jaccard, graph traversal, Leiden clustering—all of it gets hand-written in vanilla JS.

## Commands

```bash
npm test            # Jest unit + integration
npm run lint        # ESLint over src/ and tests/
npm run typecheck   # tsc --noEmit (JSDoc types)
npm run bench       # local benchmark CLI (bench/cli.js)
npm run test:e2e    # Playwright; needs a live local ST on localhost:8000 (skips if unreachable)
```

Jest gates the repo—run test, lint, and typecheck before declaring work done.

## Conventions

- **Internal identifier:** `STARmem` (capital STAR). Used in `chatMetadata['STARmem']`, `STARmemInterceptor`, etc. The package name (`starmem`) and repo slug (`SillyTavern-STARmem`) are the only lowercased exceptions—npm convention and ST naming convention.
- **Scope tags on entries:** `working | episodic | persona`. The graph is infrastructure, not a scope.
- **Edge types:** `mentions | supports | same_topic | temporal_next`. `contradicts` is reserved but not produced in v2.0.
- **Latency budgets are spec targets, not code.** Tier 0 <1ms, Tier 1 <5ms, Tier 2 <50ms, Tier 3 <100ms, Floor <5ms—design intent only; nothing in `src/` measures or enforces them.
- **Docs are code truth:** when a change moves a field, constant, pipeline order, or wiring status that `docs/reference/` cites, update the cited page in the same change.

## What NOT to do

- **Do not add embeddings or vector search beyond the persona-rebuild k-NN.** The retrieval path is deterministic BM25 + typed graph. If you think you need embeddings there, you don't.
- **Do not add LLM calls to the retrieval path.** Not even as a "fallback tier." Rejected by design.
- **Do not add consolidation triggers beyond the one rule** (buffer ≥ 10 or idle ≥ 60s). v1 had four. We collapsed them. Don't un-collapse.
- **Do not write migration code from v1.** Clean break. See spec §11.
- **Do not add a setup wizard, health checks, or debug console.** Explicitly cut in spec §8.
