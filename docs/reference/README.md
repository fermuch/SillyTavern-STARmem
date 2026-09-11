# STARmem reference docs

These pages are the source-of-truth reference for STARmem v2's implemented behavior. They are **derived from the code, not the spec**: every factual claim carries a `file:line` citation into `src/`, and where the code and the design spec disagree, the code wins. The spec (`docs/specs/2026-04-20-starmem-v2-design.md`) remains the approved design-of-record; known disagreements are catalogued in the [drift register](./drift-register.md).

## Status legend

Pages flag every module, constant, or setting with one of three statuses:

| Status | Meaning |
| --- | --- |
| **Wired** | Defined and actually exercised by runtime code paths. |
| **Unwired** | Defined (and possibly persisted, validated, or exported) but no runtime caller—behaves as if it did not exist. |
| **Divergence** | Code behavior deliberately differs from the spec or from older docs; the drift register holds the authoritative entry. |

## Index

| Page | Covers | Status |
| --- | --- | --- |
| [architecture.md](./architecture.md) | Principles as enforced, module layering, boot sequence, write and retrieval lifecycles, state substrate. | current |
| [data-model.md](./data-model.md) | `Entry`/`Edge`/`State`/trace shapes, `chatMetadata` nesting, entry-id derivation, validators and guards. | current |
| [core.md](./core.md) | `constants.js` structure and the sweep-override mechanism, `schema.js` enums and guards, `state.js` backend and clone semantics, `lock.js`, `logger.js`. | current |
| [memory.md](./memory.md) | Entry construction and deterministic ids, graph ops, edge building (entity regex, explicit vs co-occurrence weights, cap and eviction). | current |
| [lifecycle.md](./lifecycle.md) | Recency formula, importance events and decay, maturity hysteresis—with wired/unwired status per function. | current |
| [retrieval.md](./retrieval.md) | End-to-end `retrieve()` flow, tiers 0–3 and floor, BM25+ formula, classifier, working-buffer prepend, trace and cache rules. | current |
| [consolidation.md](./consolidation.md) | Triggers, pipeline order, dedup, edge building, `extractFacts`, persona rebuild (RAPTOR + ST Vectors), traces, lock usage. | current |
| [integration.md](./integration.md) | Entry-point wiring, bootstrap and chat-lifecycle hooks, interceptor injection modes, settings schema (wired vs inert), macro, indicator. | current |
| [viewer.md](./viewer.md) | Memory Viewer mount, five tabs, trace badges, JSONL export, persona rebuild button. | current |
| [bench.md](./bench.md) | Benchmark harness: runners, corpora adapters, seeder, metrics, sweeps, Modal/remote story. | current |
| [testing.md](./testing.md) | Jest architecture, mocks and fixtures, test catalog by subsystem, invariant tests, e2e Playwright. | current |
| [constants.md](./constants.md) | Every runtime tunable: value, definition site, consumers, live/swept/inert status. | current |
| [drift-register.md](./drift-register.md) | Canonical list of spec-vs-code divergences with `file:line` evidence and status. | current |

## Maintenance rule

These pages describe code, so they go stale exactly when the code does. The rule: **when a change lands that moves a field name, constant value, pipeline order, or wiring status cited here, update the affected page in the same change and adjust the citation.** Cite the current code (`src/path/file.js:123`), not the change description. Unwired/Divergence statuses must be re-checked against callers, not comments.
