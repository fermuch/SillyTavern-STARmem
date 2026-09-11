# Viewer

The Memory Viewer: the modal opened from the settings panel's "Open Memory Viewer" button. It is a five-tab inspection surface over the active chat's persisted `State`—nothing in it runs retrieval or consolidation except the Persona tab's explicit rebuild button. This page documents the shell (mount, tab switching, subject filter, close) and each tab's real behavior, including the trace badges that render the Tier-2 demolition honestly.

Source: `src/integration/viewer/mount.js` and `src/integration/viewer/tabs/` (`working.js`, `episodic.js`, `persona.js`, `graph.js`, `traces.js`), plus `src/integration/constants.js` (tab list, CSS prefix) and `src/consolidation/triggers.js` (`clearTraces`).

## Shell—`viewer/mount.js`

`openViewer(chatId, opts = {})` (`src/integration/viewer/mount.js:52-91`) builds the root element, wires tabs/filter/close, renders the initial tab, then mounts. The returned `ViewerState` holds `{ chatId, activeTab, subjectFilter, root, tabBody, close }`, with `activeTab` initialized to the first entry of `VIEWER_TABS`—`'working'` (`mount.js:56-63`; `constants.js:116-122`).

**Mount targets**, in preference order (`mount.js:72-82`): an explicit `opts.parent` (the test seam), else ST's `Popup`/`POPUP_TYPE.TEXT` with `{ wide: true }`, else `document.body`. `state.close` removes the root or completes the popup, and calls `opts.onClose` when supplied. A `starmem-is-revealing` class is added for the staged entrance animation and removed after 900 ms (`mount.js:84-88`).

**Skeleton** (`buildRootElement`, `mount.js:94-125`): a header (`h2` "Memory Viewer" + `aria-label="Close"` button), a filter row (`Subject:` label + `starmem-viewer-subject-input` with placeholder `(all subjects)`), a `nav role="tablist"` of one `role="tab"` button per tab (`data-tab`, `aria-controls` a shared panel id), a mobile `<select class="starmem-viewer-tab-select">` mirror, and a `starmem-viewer-body` `role="tabpanel"`. Every id/class is prefixed with `CSS_PREFIX = 'starmem'` (`constants.js:127`). Tab titles come from `titleFor()` (`mount.js:127-136`): Working, Episodic, Persona, Graph, Traces.

**Tab switching** (`wireTabs`, `mount.js:138-165`): each button's click sets `state.activeTab`, highlights, and re-renders; the mobile `<select>` mirrors the same state. Keyboard navigation (`wireTabKeyboard`, `mount.js:167-195`) handles ArrowRight/ArrowLeft (wrapping), Home, End, Enter, and Space, moving focus and re-rendering. `highlightActiveTab` (`mount.js:197-222`) sets `starmem-viewer-tab-active`, `aria-selected`, `tabindex`, the panel's `aria-labelledby`, and syncs the select.

**Subject filter** (`wireSubjectFilter`, `mount.js:224-234`): on each `input` event the value is trimmed into `state.subjectFilter` immediately, and re-render is debounced by **150 ms** (`mount.js:232`). The filter only affects tabs that read `ctx.subjectFilter`—Episodic, Persona, and Graph. Working and Traces ignore it.

**Close** (`wireClose`, `mount.js:236-243`): the header ✕ calls `state.close()` and then `opts.onClose`.

**Tab render dispatch** (`renderActiveTab`, `mount.js:245-260`): writes a `starmem-viewer-loading` "Loading…" placeholder, dynamically imports the tab module via `loadTabModule` (`mount.js:262-271`), calls `loadState(state.chatId)`, clears the body, then calls `tabModule.renderTab(body, { chatId, subjectFilter, state })`. Any throw is logged and rendered as a `starmem-viewer-error` message—HTML-escaped by `escapeHtml` (`mount.js:273-277`). Each tab exports a `renderTab(parent, ctx)` entry point; `traces.js` additionally exports `formatTierLabel` (`traces.js:104-113`) and `formatCauseLabel` (`traces.js:203-217`) for unit tests.

## Working tab—`tabs/working.js`

Resolves `state.workingBuffer` (a `string[]` of entry ids) against `state.entries`, skipping stale ids (`working.js:31-40`). Renders a header `Working buffer — N entries` (singular/plural handled, `working.js:46-49`) and an empty-state message when nothing resolves (`working.js:51-58`). Entries render **newest first** by iterating the resolved list back-to-front (`working.js:63-65`).

Each row (`renderEntry`, `working.js:74-94`) shows `createdAt` (formatted) plus `msg <sourceMessages joined>` when present, then the content. Content longer than `MAX_INLINE_LEN = 200` (`working.js:15`) is truncated with a `(more)` button that swaps in the full text (`appendTruncated`, `working.js:96-114`). The subject filter is not consulted.

## Episodic tab—`tabs/episodic.js`

Filters entries to `scope === 'episodic'`, then applies the subject filter as a case-insensitive substring match on `entry.subject` (`episodic.js:27-29`, `40-44`). The header reports `Episodic—N/M entries`, where `N` is the filtered count and `M` the total episodic count; when the filtered count exceeds `MAX_RENDER` (500), the header appends `(showing first 500)` (`episodic.js:46-52`).

A sort `<select>` (`episodic.js:54-81`) offers four modes:

| Sort | Behavior | Site |
| --- | --- | --- |
| Importance ↓ (default) | `lifecycle.importance` descending. | `episodic.js:105-106` |
| Recency ↓ | `recencyAt(now, lifecycle.createdAt)` descending. | `episodic.js:107-108` |
| Added ↓ | `lifecycle.createdAt` string descending (`localeCompare`). | `episodic.js:109-110` |
| Subject (grouped) | Subjects A→Z via `localeCompare`; within a group, importance descending. | `episodic.js:172-186`, `133-135` |

Flat layouts render a `<ul>` and cap at `MAX_RENDER = 500` (`episodic.js:20`, `91-101`). The grouped layout emits one `<section data-subject>` per subject with a heading (`subject` + count) and a nested list; the same 500-entry budget is consumed across groups in alphabetical order, so trailing groups may be trimmed (`episodic.js:121-164`). Missing/empty subjects bucket as `(no subject)`.

Each row (`buildRow`, `episodic.js:196-244`) shows the subject (omitted inside a grouped layout, where it is the heading), a scores line `I=<importance> R=<recency> <maturity>·<boost>`, the content, and tag chips when present. A legacy maturity value outside the v2 enum is rendered verbatim with a neutral boost of `1` instead of throwing—`isMaturity` gates `maturityBoost` (`episodic.js:215-224`). Recency and maturity math live in [lifecycle.md](./lifecycle.md).

## Persona tab—`tabs/persona.js`

Filters entries to `scope === 'persona'` and groups them by subject; unlike Episodic, the groups are **not alphabetized**—`groupBySubject` preserves first-seen insertion order of a `Map` (deliberately, so `__proto__` cannot collide with `Object.prototype`—`persona.js:57-69`). The subject filter is a case-insensitive substring match; a missing subject is `(no subject)` (`persona.js:63-64`). The header reads `Persona — N entries across M subjects` (`persona.js:32-36`).

When no group survives the filter, the tab shows an empty message and still renders a **rebuild form**—a text input for a subject plus a Rebuild button (`persona.js:38-49`, `186-220`). Otherwise each subject group (`persona.js:71-96`) renders its entries (content plus `from <provenance.extractor>`, `persona.js:98-111`), a per-group Rebuild button, and a live progress region.

**Rebuild button** (`buildRebuildButton`, `persona.js:113-184`) is the only production trigger of `rebuildPersona()`—persona rebuild is never automatic (drift #9; see [consolidation.md](./consolidation.md)). Behavior:

- Disabled with title "Configure extractor LLM in settings first." when `settings.profileId` is empty (`persona.js:119-123`).
- Only one rebuild runs at a time: while active, the active button reads "Cancel" and aborts via its `AbortController`; all other rebuild buttons are disabled (`persona.js:125-140`, `222-228`).
- Calls `rebuildPersona(chatId, subject, { profileId, extractorLabel, signal, onProgress, now })` (`persona.js:153-164`); `onProgress` appends lines like `stage • depth=N • clusters=N`.
- On completion appends `Done — N new / M replaced in Xms`; on abort "Cancelled."; otherwise `Failed: <message>` (`persona.js:165-172`).
- Re-renders the tab 300 ms after settling so new Persona entries appear (`persona.js:178-180`).

`getSettings()` is read on every render to pick up `profileId`/`extractionModelLabel` (`persona.js:26`).

## Graph tab—`tabs/graph.js`

Renders a textual adjacency listing, not a drawn graph. It filters entries by the subject filter (`graph.js:59-67`), rebuilds adjacency from `state` via `buildAdjacency` (`graph.js:21`; see [memory.md](./memory.md)), and ranks nodes by neighbor degree descending (`rankByDegree`, `graph.js:69-77`). The header reads `Graph — N nodes, M edges`, where `N` is the filtered node count and `M` is the **full** `state.graph.edges` count (not filtered—`graph.js:19,30`).

`MAX_ENTRIES = 200` nodes render; a note reports how many were hidden (`graph.js:10`, `44-54`). Each node row (`buildNodeRow`, `graph.js:79-117`) shows the subject and an 80-char content preview. Neighbors come from `neighborsOf(adj, entry.id)`, capped at `MAX_NEIGHBORS_PER_ENTRY = 10` (`graph.js:11`), each as `[type] (w=<weight.toFixed(2)>) → <targetSubject>: <40-char preview>`; a `+N more neighbors` line follows when truncated (`graph.js:96-114`). Adjacency is forward-only and never persisted.

## Traces tab—`tabs/traces.js`

Reads `state.runtime.traces` (the shared ring buffer, cap 128—see [retrieval.md](./retrieval.md)) and renders **latest first** (`traces.js:14-15`, `44-46`). Header: `Traces — N entries` (`traces.js:21-24`).

### JSONL export and clear

- **Download JSONL** (`traces.js:51-71`): disabled when empty. On click it joins `JSON.stringify(trace)` per trace with `\n`, appends a trailing newline, and downloads a `Blob` of type `application/x-ndjson` as `starmem-traces-<YYYY-MM-DDTHH-MM-SS>.jsonl`, revoking the object URL afterwards (`traces.js:57-69`).
- **Clear** (`traces.js:73-90`): confirms, calls `clearTraces(chatId)` (which runs under the write lock—`src/consolidation/triggers.js:119-127`), and re-renders with an empty trace projection. Failures alert.

### Trace badges

Each trace item is a summary line plus a `<details>` "raw" block containing pretty-printed JSON (`traces.js:136-146`, `169-179`). Consolidation traces are distinguished by `kind === 'consolidate'` and get a `consolidate` badge; their summary is `timestamp · factCount facts · durationMs · extractor`, with ` · failed` appended when `summary.error` is set (`traces.js:122-133`). Retrieval traces show a tier badge and an optional cause badge (`traces.js:149-167`).

**Tier badge**—`formatTierLabel(tier)` (`traces.js:104-113`):

| `tierResolved` | Badge |
| --- | --- |
| `0` | `T0` |
| `1` | `T1` |
| `2` or `3` | `T3` |
| `'floor'` | `Floor` |
| `'bm25only'` | `BM25` |
| `'recency'` | `Recent` |
| `'random'` | `Rand` |
| anything else | `?` |

The `2 || 3 → 'T3'` collapse (`traces.js:107`) is the legacy path: Tier 2 was demolished as a resolver, but a persisted trace with `tierResolved: 2` renders as `T3` because it exercised the seed-into-Tier-3 path (drift #1; [retrieval.md](./retrieval.md)). The displayed `top` score is read from `trace.perTier[String(tierResolved)][0].score` (`getTopScore`, `traces.js:183-190`), so a legacy `2` reads `perTier['2']` correctly. The summary text is `timestamp · classifier · top=<score, 2dp or n/a> · "<query truncated to 60>"` (`traces.js:150-166`).

**Cause badge**—`formatCauseLabel(cause)` (`traces.js:203-217`) maps ST generation types to short labels: `swipe`→`swipe`, `continue`→`continue`, `regenerate`→`regen`, `impersonate`→`impersonate`, `quiet`→`quiet`; `normal`, empty, and unknown values produce **no badge** (a missing badge reads as a fresh user turn). The badge is rendered by `buildCauseBadge` with classes `starmem-tier-badge starmem-cause-badge starmem-cause-<label>` and a title `Generation type: <cause>` (`traces.js:226-234`), so same-query reruns (swipe/regenerate/continue) are visually distinct from ordinary turns.

## See also

- [architecture.md](./architecture.md)—the retrieval path whose traces this tab renders, and the boot that mounts the panel.
- [retrieval.md](./retrieval.md)—trace shape, the 128-entry ring cap, and why `tierResolved` is never `2` in current code.
- [consolidation.md](./consolidation.md)—`rebuildPersona` internals and why the rebuild is manual-only (drift #9).
- [lifecycle.md](./lifecycle.md)—`recencyAt` and `maturityBoost`, which the Episodic tab displays.
- [memory.md](./memory.md)—`buildAdjacency`/`neighborsOf`, which the Graph tab uses.
- [integration.md](./integration.md)—the settings panel that opens this viewer and the `{{starmem-memories}}` macro it complements.
- [drift-register.md](./drift-register.md)—full entries for drifts #1 (Tier 2 demolition) and #9 (manual persona rebuild).
