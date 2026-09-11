# Memory—entries, graph, edge building

How STARmem constructs memory entries with deterministic ids, how the typed graph stores edges, and how edges get built for new entries during consolidation. These modules are pure infrastructure—no state I/O, no LLM calls—so every function here is testable without SillyTavern.

Source: `src/memory/entry.js`, `src/memory/graph.js`, `src/memory/edgeBuilder.js`, `src/memory/index.js`, `src/vendor/sha256.js`. Behavior confirmed against `tests/unit/memory/` (`entry.test.js`, `graph.test.js`, `edgeBuilder.test.js`, `determinism.test.js`, `index.test.js`).

## entry.js—the one construction site

`createEntry` is the one construction site: consolidation, the fact extractor, the persona-rebuild atomic replace, and the bootstrap working-entry hook all build entries through it, and nothing constructs entries ad-hoc (`entry.js:1-7`). Signature (`entry.js:70-147`):

```js
createEntry({ scope, content, subject, tags, relations = [], provenance, now })
```

`relations` defaults to `[]`; `now` defaults to `new Date()` and exists so tests can inject a fixed clock (`entry.js:115-116`).

### Validation (throws, never coerces)

Field guards run in order before any id is minted (`entry.js:71-113`):

| Guard | Rule |
| --- | --- |
| `fields` object | Non-null object required (`:71-73`). |
| `scope` | Must pass `isScope`—`'working' \| 'episodic' \| 'persona'` (`:75-77`). |
| `content` | Non-empty string (`:78-80`). |
| `subject` | String or exactly `null` (`:81-83`). |
| `tags` | Array of strings (`:84-86`, `:96-98`). |
| `relations` | Array; each item an object with `isEdgeType`-valid `type` and non-empty string `target` (`:87-89`, `:99-110`). |
| `provenance` | `{ sourceMessages: number[], extractor: string }` with every source message a non-negative integer (`:90-94`, `:111-113`). |

The returned entry is defensively copied—`tags: [...tags]`, relations re-mapped to `{ type, target }`, `sourceMessages: [...sourceMessages]` (`entry.js:127-146`)—so the caller's arrays cannot mutate the persisted shape after construction.

### Defaults and lifecycle baseline

The lifecycle block is created at spec §7 baseline (`entry.js:134-141`): `importance = 50`, `maturity = 'draft'`, `accessCount = 0`, `updateCount = 0`, and `createdAt === updatedAt` (both set to the same ISO timestamp, `entry.js:115-116`).

### Deterministic entry ids

Format: **`<prefix>_<ISO-seconds>_<sha256-seed-12hex>`**, e.g. `ep_2026-04-20T14:12:33_a3f124cde091` (`entry.js:32-35`, `:53`).

| Component | Derivation |
| --- | --- |
| Prefix | `SCOPE_PREFIX`—`working → wk`, `episodic → ep`, `persona → ps` (`entry.js:13-17`). |
| Timestamp | `now.toISOString().replace(/\.\d+Z$/, '')`—millisecond precision trimmed to whole seconds (`entry.js:52`). |
| Suffix | `sha256Hex(seed).slice(0, 12)`—12 hex chars = 48 bits, collision-safe for realistic corpora (`entry.js:21-30`; `src/vendor/sha256.js:37`). |

**Seed composition**—a pipe-joined string built inside `createEntry` (`entry.js:118-125`), in this exact order:

```text
scope | content | subject ?? '' | tags.sort().join(',') | sourceMessages.join(',') | provenance.extractor
```

Consequences, locked in by `tests/unit/memory/determinism.test.js`:

- Identical inputs produce identical ids—replayed extractions are id-stable rather than piling up duplicates (`determinism.test.js:27-32`).
- Tag insertion order does not change the id (sorted before hashing, `determinism.test.js:72-76`).
- `subject: null` and `subject: ''` yield the same id (`determinism.test.js:78-84`).
- Any change to content, subject, scope, source messages, or extractor changes the id (`determinism.test.js:34-70`); a one-second-later timestamp also changes it (`determinism.test.js:103-109`).
- `generateEntryId(scope, now, seed)` guards its own inputs—valid scope, valid `Date`, non-empty string seed (`entry.js:43-51`)—and is exported for direct use, though its only caller is `createEntry` itself (`entry.js:128`).

### `isValidEntry`—defined but unwired

The total validator (`entry.js:157-189`) checks the full shape: non-empty string `id`, valid `scope`, non-empty `content`, string-or-null `subject`, all-string `tags`, each relation `{ type ∈ EdgeType, target: non-empty string }`, a `lifecycle` with numeric `importance` in [0, 100], enum `maturity`, timestamps checked for string type only—not ISO format (`entry.js:179` compares `typeof`), non-negative counts, and a `provenance` with a numeric array and string `extractor` (`entry.js:157-189`).

**Status: Unwired.** No call site in `src/`—it is referenced only in comments (`src/core/state.js:76`, `src/core/schema.js:5`) and the barrel export (`src/memory/index.js:9`). Load and persist enforce shape via `looksLikeState` (`state.js:81-93`), not via this validator; the "deep validation at use-sites" framing derives from a stale source comment (`state.js:74-76`)—in reality no production site deep-validates, and today the only exerciser of `isValidEntry` is the test suite (`entry.test.js:90-133`).

## graph.js—edge operations over the flat edge list

The graph store is a flat edge list at `state.graph.edges` plus per-call helpers (`graph.js:1-11`). Edges are **directional**; the dedup key is the triple **`(from, to, type)`**. Only the flat list is persisted—there is no persisted adjacency.

- **`addEdge(state, edge)`** (`graph.js:22-39`): pure—rebuilds the edges array into a new state object. If an edge with the same `(from, to, type)` exists, it is replaced in place by a shallow copy of the incoming edge—**the new weight wins**, and the array position of the replaced edge is kept (`:27-29`). Different types between the same pair and reverse-direction edges stay distinct (`graph.test.js:42-52`).
- **`removeEdge(state, from, to, type)`** (`graph.js:51-61`): filters out the exact triple; a miss is a no-op but still returns a new state object for API consistency (`graph.test.js:63-68`). Only the exact type match is removed (`graph.test.js:77-82`).
- **`listEdges(state)`** (`graph.js:69-71`): convenience reader returning a fresh copy. **Status: Unwired**—exported via the barrel but never called by production code; tests only.
- **`buildAdjacency(state)`** (`graph.js:80-92`): builds a `Map<fromId, Edge[]>` bucketing every edge under its source id, O(|edges|), called fresh at the top of each consumer—the same build-per-use pattern as the BM25 index. It is **never persisted**; `state.graph` holds only the flat list (`schema.js:87`). Consumers: Tier 3's beam search (`src/retrieval/tier3-graph.js:35`) and the Memory Viewer's Graph tab (`src/integration/viewer/tabs/graph.js:21`).
- **`neighborsOf(adjacency, entryId)`** (`graph.js:102-104`): returns the prebuilt bucket for an id, or `[]`. Tier 3 treats the returned array as read-only.

All graph operations are pure—none mutates its input—but they do not all return new state objects: `addEdge`/`removeEdge` return a new State (`graph.test.js:28-33`, `:70-75`), `listEdges` returns a fresh `Edge[]` copy (`graph.js:69-71`), `buildAdjacency` returns a newly built `Map` (`graph.js:80-92`), and `neighborsOf` returns the stored `Edge[]` bucket or `[]` (`graph.js:102-104`).

## edgeBuilder.js—edge construction for consolidation

`buildEdges(entry, allEntries, state)` is a pure function from an entry, the corpus, and the current state to `{ newEdges, evicted }` (`edgeBuilder.js:44-53`); `consolidate()` applies both under the write lock (`src/consolidation/consolidate.js:232-234`). `contradicts` edges are reserved in the schema but never emitted here (`edgeBuilder.js:11`).

### Entity extraction

- Regex: `/\b[A-Z][a-z]{2,}\b/g` (`edgeBuilder.js:19`)—case-sensitive match of an initial capital followed by two or more lowercase letters (minimum three-character words).
- Stop-word filter (`edgeBuilder.js:21`): a fixed 25-entry set of short sentence starters—`'A', 'I', 'The', 'It', 'Is', 'In', 'Of', 'Or', 'On', 'At', 'To', 'An', 'As', 'Be', 'By', 'Do', 'Go', 'He', 'Me', 'My', 'No', 'So', 'Up', 'Us', 'We'`. Mostly two-character words—but the set also holds two one-character members (`'A'`, `'I'`) and one three-character member (`'The'`). Since `ENTITY_RE` above can only match words of three or more characters, the one- and two-character members can never match and are dead set members—in practice the filter only ever drops `'The'`.
- `extractEntities(text)` (`edgeBuilder.js:31-36`) returns the matches deduplicated through a `Set`. Case sensitivity matters: lowercase `alice` is not an entity; `Alice` is (`edgeBuilder.test.js:52-54`). Non-string input returns `[]` (`:32-34`).

### The two edge sources

1. **Explicit relations** (`edgeBuilder.js:58-66`): one edge per `entry.relations` item—`from = entry.id`, `to = rel.target`, `type = rel.type` (any EdgeType, including reserved-but-unproduced ones if a caller supplies them), `weight = RETRIEVAL.EXPLICIT_RELATION_WEIGHT` (1.0, `src/core/constants.js:86`).
2. **Entity co-occurrence** (`edgeBuilder.js:68-88`): if the entry has at least one entity, every corpus entry sharing at least one of them gets a `type: 'mentions'` edge, `weight = RETRIEVAL.COOCCURRENCE_WEIGHT` (0.5, `src/core/constants.js:88`). The scan skips the entry itself (`:72`) and skips `scope === 'working'` corpus entries (`:73`)—working entries are volatile and never edge targets. Sharing multiple entities still yields one edge per other entry.

### Merge, cap, and eviction

- **Candidate dedup, keep-highest** (`edgeBuilder.js:90-98`): candidates are keyed by a null-byte-joined `(from, to, type)` string (`:94`); on collision the higher weight survives, which is what makes an explicit relation (1.0) beat a co-occurrence (0.5) targeting the same pair and type (`edgeBuilder.test.js:111-119`).
- **Existing-key filter** (`edgeBuilder.js:100-107`): new candidates whose key already exists in `state.graph.edges` are discarded—the existing edge's weight is left untouched; refresh-by-rebuild is not part of the contract.
- **Cap enforcement** (`edgeBuilder.js:100-131`): the cap is `RETRIEVAL.EDGE_CAP_PER_ENTRY` (20, `src/core/constants.js:84`), enforced on the *combined* set of existing edges from this source plus the new candidates. The combined list is sorted by weight descending, with ties broken in favor of **new** edges—"fresher info wins" (`edgeBuilder.js:109-117`). The top 20 are kept; everything else from this source is dropped.
- **Eviction semantics**: an *existing* edge that falls out of the kept set is returned in `evicted` for the caller to remove (`edgeBuilder.js:123-125`); a *new* candidate in the discarded tail is simply never returned—dropped, not evicted (`edgeBuilder.js:126-131`).
- Under the cap nothing is evicted; over the cap the lowest-weight existing edges are evicted first and higher-weight ones survive (`edgeBuilder.test.js:130-169`).
- **Purity**: `buildEdges` mutates nothing—not `entry`, not `allEntries`, not `state` (`edgeBuilder.test.js:172-185`).

## index.js—the memory barrel

`src/memory/index.js` is the single import surface (`index.js:1-7`), re-exporting `createEntry`/`isValidEntry`/`generateEntryId`, the five graph operations, and `buildEdges`/`extractEntities` (`index.js:9-17`). Production import sites: `src/consolidation/consolidate.js:37` (`addEdge`, `removeEdge`, `buildEdges`) and `src/integration/viewer/tabs/graph.js:8` (`buildAdjacency`, `neighborsOf`); `createEntry` is imported directly from `entry.js` by `src/consolidation/extractFacts.js`, `src/consolidation/raptor/atomic.js`, and `src/integration/bootstrap.js:227`.

## Wiring summary

| Function | Wired production callers |
| --- | --- |
| `createEntry` | `src/consolidation/extractFacts.js:264`, `src/consolidation/raptor/atomic.js:97`, `src/integration/bootstrap.js:227` |
| `generateEntryId` | Internal—`createEntry` (`entry.js:128`) |
| `isValidEntry` | **None** (unwired; tests only) |
| `addEdge` / `removeEdge` | `src/consolidation/consolidate.js:233-234` |
| `buildEdges` | `src/consolidation/consolidate.js:232` |
| `buildAdjacency` / `neighborsOf` | `src/retrieval/tier3-graph.js:35,63`; `src/integration/viewer/tabs/graph.js:21,72-73,96` |
| `listEdges` | **None** (unwired; tests only) |
| `extractEntities` | Internal—`buildEdges` (`edgeBuilder.js:69,74`) |

## See also

- [data-model.md](./data-model.md)—the `Entry`, `Edge`, and `State.graph` shapes these functions produce.
- [core.md](./core.md)—the enum guards (`isScope`, `isEdgeType`) used during construction and validation.
- [lifecycle.md](./lifecycle.md)—the lifecycle block `createEntry` initializes.
- [consolidation.md](./consolidation.md)—where `buildEdges` output is applied under the write lock.
- [retrieval.md](./retrieval.md)—the Tier 3 consumer of `buildAdjacency`.
- [drift-register.md](./drift-register.md)—tracks defined-but-unwired exports such as `isValidEntry`.
- `docs/specs/2026-04-20-starmem-v2-design.md` §3.1, §4, §6.3—design intent (not code truth).
