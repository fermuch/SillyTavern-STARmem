# Integration

The SillyTavern-facing surface: how `index.js` registers the generation interceptor and boots on `APP_READY`, how `bootstrap.js` wires the five chat-lifecycle events and keeps the working buffer honest across deletes and swipes, how the interceptor performs retrieval and injects the result under the three injection modes, and what the settings panel, indicator, and `{{starmem-memories}}` macro actually do. The boot sequence itself is diagrammed in [architecture.md](./architecture.md#boot-sequence); this page focuses on the details that page summarizes.

Source: `index.js`, `settings.html`, `manifest.json`, and all of `src/integration/`: `bootstrap.js`, `constants.js`, `settings.js`, `settingsPanel.js`, `interceptor.js`, `indicator.js`, `macro.js`, `index.js` (barrel).

## Entry point—`index.js`

ST loads `index.js` directly as a module (no build step) and reads two globals from `manifest.json`: `js: "index.js"` and `generate_interceptor: "STARmemInterceptor"` (`manifest.json:6-7`), with `loading_order: 100` (`manifest.json:3`) placing the settings panel in the right-hand extensions column.

- **Interceptor global (synchronous, at module eval).** `globalThis.STARmemInterceptor` is assigned a thin async wrapper that delegates to `starmemInterceptor()` and catches every error, logging it and swallowing it, so a broken memory system cannot break the user's generation (`index.js:41-47`). ST calls it as `STARmemInterceptor(chat, contextSize, abort, type)` before each generation.
- **APP_READY subscription (at module eval).** If `SillyTavern.getContext` is unavailable the module logs a warning and defers (`index.js:59-63`); otherwise it subscribes `eventSource.on(event_types.APP_READY, …)` (`index.js:64-65`). Top-level `await` is not used here—the subscription runs inside a synchronous `try` block at module eval.
- **APP_READY handler, in order** (`index.js:65-114`): `bootstrap()` (subscribes the chat events, sets the state backend, scorer, and macro—`index.js:67`), then `mountIndicator()` with a lazily-resolved chat id (`index.js:75-78`), then the settings panel. A container `<div id="starmem-settings-container">` is appended to `#extensions_settings2` (falling back to `#extensions_settings`) and `renderSettingsPanel()` renders into it (`index.js:88-109`). The panel's "Open Memory Viewer" button resolves the current `chatId` and calls `openViewer(chatId)` (`index.js:96-108`).
- **Idempotency.** `bootstrap()` tears down prior subscriptions before re-subscribing (`bootstrap.js:375-377`); a second APP_READY fire is safe. The indicator's `mountIndicator` also unmounts first (`indicator.js:49`).

The integration barrel `src/integration/index.js` re-exports the public surface (`constants`, settings accessors, `starmemInterceptor`, `bootstrap`, indicator fns, `renderSettingsPanel`, `openViewer`) so the root entry point and JSDOM tests share one import target (`src/integration/index.js:21-30`). It notably has no `teardown`: `bootstrap()` returns an unsubscribe function, but production callers do not use it (`src/integration/index.js:14-15`, `bootstrap.js:430-433`).

## Bootstrap and the chat-lifecycle hooks

`bootstrap()` (`src/integration/bootstrap.js:374-434`) runs in this order:

1. Tear down previous subscriptions (`bootstrap.js:376-377`).
2. `setBackend(buildStateBackend())`—routes `loadState`/`persistState` through `chatMetadata['STARmem'][chatId]` (`bootstrap.js:382`; backend at `98-127`).
3. `getSettings()` then `setScorer(settings.scorerId)` inside a `try` (`bootstrap.js:385-388`). `getSettings()` fills and re-persists defaults on first call; `setScorer` throws on an unknown id, which is caught and logged.
4. `registerStarmemMacro()`—fire-and-forget, idempotent (`bootstrap.js:393-394`).
5. Seed `lastChatId` from `ctx.chatId` when it is a non-empty string (`bootstrap.js:397`).
6. Subscribe the five events (`bootstrap.js:410-416`); each is added only if `event_types` names it, and an unsubscribe closure pushes `removeListener`/`off` (`bootstrap.js:417-427`). Missing `eventSource`/`event_types` logs a warning and returns a no-op (`bootstrap.js:400-408`).

`buildStateBackend()` (`bootstrap.js:98-127`) validates ids with `assertSafeChatId` (`bootstrap.js:84-91`, reserved keys `__proto__`/`constructor`/`prototype` at `78`), reads `ctx.chatMetadata['STARmem'][id]`, creates that slot as `Object.create(null)` on first write (`bootstrap.js:116-120`), and calls `ctx.saveMetadataDebounced()` when available (`bootstrap.js:122-124`).

### The five hooks

| Event | Handler | Behavior |
| --- | --- | --- |
| `CHAT_CHANGED` | `onChatChanged` (`bootstrap.js:135-148`) | If the previous chat differs: cancels its idle timer, fires a fire-and-forget `maybeConsolidate(prevChatId, 'buffer', …)`, then sets `lastChatId` to the new id (or `null` when not a string). Errors are swallowed. |
| `MESSAGE_SENT` | `onMessageSent` (`bootstrap.js:157-164`) | Restarts the 60 s idle timer for the active chat (`resetIdleTimer`); a no-op when `lastChatId` is unset. |
| `MESSAGE_RECEIVED` | `onMessageReceived` (`bootstrap.js:180-254`) | Creates one `scope: 'working'` entry for the assistant reply, appends its id to `workingBuffer`, persists under the write lock, then fire-and-forget `maybeConsolidate(lastChatId, 'buffer', …)`. |
| `MESSAGE_DELETED` | `onMessageDeleted` (`bootstrap.js:264-299`) | Under the write lock, drops every buffered entry whose `provenance.sourceMessages` contains the deleted message id, and removes its id from `workingBuffer`. |
| `MESSAGE_SWIPED` | `onMessageSwiped` (`bootstrap.js:325-366`) | Resets the idle timer, then under the write lock drops only `scope === 'working'` buffered entries referencing the swiped message id. Already-consolidated entries survive. |

`onMessageSent`, `onMessageReceived`, `onMessageDeleted`, and `onMessageSwiped` early-return when `lastChatId` is unset. `onChatChanged` does not—it is the handler that re-seeds `lastChatId` on the first switch, so it only gates its cleanup branch on `lastChatId && lastChatId !== newChatId` and always refreshes `lastChatId = newChatId` afterwards (`bootstrap.js:135-148`). Every hook wraps its body in `try/catch`, logging and swallowing errors.

### `onMessageReceived` details

- **`first_message` replay is skipped.** ST re-emits the character greeting as `MESSAGE_RECEIVED` with `type === 'first_message'` on chat/character load; capturing it would re-add character-card lore on every load (`bootstrap.js:180-185`).
- The message at `messageId` is used when it is a valid index, otherwise the last chat element; `is_user`/`is_system` messages and empty `mes` are skipped (`bootstrap.js:191-197`).
- **Reasoning/CoT stripping.** When `ctx.parseReasoningFromString` exists, it is called with `{ strict: false }`; if it returns a string `content` and either extracted reasoning or changed the text, that content replaces the raw `mes` (`bootstrap.js:199-224`). A post-strip empty result is skipped (`bootstrap.js:224`).
- The entry is built by `createEntry` with `scope: 'working'`, `subject: null`, `tags: []`, `relations: []`, and `provenance: { sourceMessages: [idx], extractor: 'interceptor@working-v1' }` (`bootstrap.js:227-235`).
- The write (`entries[id] = entry`, `workingBuffer.push(id)`) and `persistState` happen inside `withWriteLock(lastChatId, …)` (`bootstrap.js:237-245`).

User messages are deliberately not captured as working entries; only assistant replies are (`bootstrap.js:11-14`).

### The deletion and swipe contract

Both handlers iterate **only the ids in `workingBuffer`** and only ever delete entries they drop from the buffer; entries outside the buffer are untouched. The asymmetry is intentional:

- `onMessageDeleted` drops any buffered entry whose `provenance.sourceMessages` includes the deleted index (`bootstrap.js:276-288`). Since the buffer only ever holds `working` entries, scope is not checked.
- `onMessageSwiped` additionally requires `e.scope === 'working'` (`bootstrap.js:343-345`). An already-consolidated `episodic`/`persona` entry that happens to reference the swiped message stays—once a fact has graduated to long-term memory, the user controls deletion through the memory UI, not via swipe side effects (`bootstrap.js:308-314`).
- Swiping also resets the idle timer, because swiping is engagement rather than idleness (`bootstrap.js:329-331`).
- New swiped content lands later through `MESSAGE_RECEIVED` with `type: 'swipe'`; swiping back to an existing variant emits no `MESSAGE_RECEIVED`, so that message intentionally has no per-`mesId` working entry and Tier 2 BM25 over chat history still surfaces it (`bootstrap.js:316-321`).

Both handlers skip when the buffer is empty or when nothing matched, avoiding a redundant persist (`bootstrap.js:271,285-286,336,351`).

### Consolidation options

`buildConsolidateOpts()` (`bootstrap.js:67-75`) assembles the `ConsolidateOptions` passed to every `maybeConsolidate` call from persisted settings: `profileId` (settings), `extractorLabel` (settings `extractionModelLabel` or the literal `'unknown@consolidation-v1'`), `messageOf` mapping a working entry to `{ role: 'assistant', content: e.content }`, and `now: new Date()` stamped at call time. Consolidation never reads settings itself—they cross the boundary by value ([consolidation.md](./consolidation.md)).

## Interceptor—retrieval and injection

`starmemInterceptor(chat, _contextSize, _abort, type)` (`src/integration/interceptor.js:215-298`) is called before every generation. It reads the `chat` array but never mutates it (`interceptor.js:5-6`).

1. **Resolve context and settings.** `resolveContext()` (`interceptor.js:78-92`) returns `{ chatId, setExtensionPrompt }`, both `null` when unavailable. `resolveInjectionSettings()` (`interceptor.js:182-200`) dynamically imports `settings.js` and returns `{ mode, position, depth, role }`; on any failure it falls back to `automatic` / IN_CHAT / depth 4 / SYSTEM (`interceptor.js:192-199`).
2. **No `setExtensionPrompt`** → log and return (`interceptor.js:219-222`).
3. **Mode `off`** → clear the prompt slot and the cached macro body, skip retrieval entirely (`interceptor.js:225-230`).
4. **No `chatId`** → clear the prompt slot, return (`interceptor.js:232-236`).
5. **No user query** (`extractLastUserQuery`, `interceptor.js:100-109`, scans backward for the last non-empty `is_user` `mes`) → clear prompt slot and macro body, return (`interceptor.js:238-244`).
6. **Retrieve under the write lock.** `withWriteLock(chatId, …)` loads state, calls `retrieve(state, query, { now, cause })`, and persists `result.state` when present; it returns the entries array (`interceptor.js:251-259`). `cause` is the ST generation `type`, or `'normal'` when absent/empty (`interceptor.js:251`). Persisting here matters because the ladder logs a trace and applies access events even for a zero-entry result.
7. **Format.** `formatMemoryMessage(entries, { header })` (`interceptor.js:130-137`) maps each entry to `- <content>`; the default includes a `Retrieved memories:` header, the headerless variant (`header: false`) is used for the macro. Scope tags are intentionally omitted (`interceptor.js:120-124`).
8. **Cache the macro body** for every mode (`setMemoryBody(chatId, macroBody)`, `interceptor.js:268`) so flipping to macro mid-session never shows a stale value.
9. **Dispatch by mode** (below).
10. **On error**, log a warning and clear both the prompt slot and the cached macro body so stale memories cannot leak into the next turn (`interceptor.js:287-297`). The root `index.js` wrapper swallows any error that escapes (`index.js:44-46`).

`injectMemoryPrompt(setExtensionPrompt, body, position, depth, role)` (`interceptor.js:154-169`) calls ST's `setExtensionPrompt` under the stable key `INJECTION_PROMPT_KEY = 'STARmem'` (`constants.js:19`) with `scan = false`. The defaults are `INJECTION_POSITION_IN_CHAT` (1), depth 4, `INJECTION_ROLE_SYSTEM` (0) (`constants.js:34-43`,`27`); production passes the settings-resolved values. An empty `body` clears the slot.

### Injection modes

| Mode | `setExtensionPrompt` | Macro cache | Retrieval |
| --- | --- | --- | --- |
| `automatic` (default) | Body with the `Retrieved memories:` header, at the configured position/depth/role (`interceptor.js:281`). | Headerless body cached (`interceptor.js:261-268`). | Runs. |
| `macro` | Cleared to `''` so the two surfaces never stack (`interceptor.js:273`). | Headerless body cached; the user places `{{starmem-memories}}` in their preset. | Runs. |
| `off` | Cleared to `''` (`interceptor.js:226`). | Cleared to `''` (`interceptor.js:227`). | Skipped entirely. |

Mode constants and the frozen `INJECTION_MODES` list are at `constants.js:56-63`; the semantics are documented in the panel template (`settings.html:71-95`). In `automatic` mode, position/depth/role come from settings; in macro mode they are persisted but unused. The interceptor's own `resolveInjectionSettings` fallback (when settings cannot be loaded) is `automatic`/IN_CHAT/4/SYSTEM (`interceptor.js:192-199`).

## Settings

Settings are persisted under `extension_settings['STARmem']` (`SETTINGS_KEY`, `constants.js:9`) at `SETTINGS_SCHEMA_VERSION = 1` (`constants.js:12`). `getSettings()` validates and fills the object from `SETTINGS_DEFAULTS`, writing it back, and re-persists via `saveSettingsDebounced()` when anything changed (`settings.js:169-180`). `setSettings(patch)` merge-patches, validates, and persists (`settings.js:188-197`); `resetSettings()` overwrites with defaults (`settings.js:200-207`).

### Defaults, bounds, and consumers

| Setting | Default | Bounds | Status |
| --- | --- | --- | --- |
| `schemaVersion` | `1` (`constants.js:91`) | — | Version gate; a mismatch resets the whole object to defaults (`settings.js:91-94`). |
| `profileId` | `''` (`constants.js:92`) | — | **Wired**: passed as `ConsolidateOptions.profileId` (`bootstrap.js:70`) and to `rebuildPersona` (`persona.js:154`). |
| `extractionModelLabel` | `''` (`constants.js:97`) | — | **Wired**: becomes `extractorLabel` (`bootstrap.js:71`) / persona `extractorLabel` (`persona.js:155`). |
| `scorerId` | `'default'` (`constants.js:96`) | — | **Wired**: `setScorer(settings.scorerId)` at bootstrap (`bootstrap.js:386`); validated by attempting activation (`settings.js:150-158`). |
| `injectionMode` | `'automatic'` (`constants.js:100`) | one of `automatic`/`macro`/`off` (`settings.js:124-126`) | **Wired**: read by the interceptor (`interceptor.js:187`). |
| `injectionPosition` | `IN_CHAT` = `1` (`constants.js:101`) | `1` or `0` (`settings.js:129-132`) | **Wired** in automatic mode. |
| `injectionDepth` | `4` (`constants.js:102`) | `0`–`10` (`constants.js:111`, clamped `settings.js:137-141`) | **Wired** in automatic/IN_CHAT mode. |
| `injectionRole` | `SYSTEM` = `0` (`constants.js:103`) | `0`/`1`/`2` (`settings.js:144-147`) | **Wired** in automatic mode. |
| `bufferSize` | `5` (`constants.js:94`) | `1`–`50` (`constants.js:108`, clamped `settings.js:97-101`) | **Unwired (drift #3)**: persisted/validated/exposed, but no runtime code reads it. |
| `idleTimeout` | `60000` (`constants.js:95`) | `5000`–`600000` (`constants.js:109`, clamped `settings.js:103-107`) | **Unwired (drift #3)**. |
| `tracesMaxLen` | `128` (`constants.js:98`) | `16`–`1024` (`constants.js:110`, clamped `settings.js:109-113`) | **Unwired (drift #3)**: the live trace cap is `TRACE_BUFFER_CAP = 128` in `src/core/constants.js`. |
| `debugMode` | `false` (`constants.js:99`) | boolean-coerced (`settings.js:121`) | **Unwired (drift #3)**. |
| `embedProfileId` | `''` (`constants.js:93`) | string-coerced (`settings.js:117`) | **Unwired (drift #3)**: persona rebuild uses `profileId`, not this. |

Consolidation actually uses the hardcoded `CONSOLIDATION.WORKING_BUFFER_THRESHOLD = 10` and `IDLE_TRIGGER_SECONDS = 60` (`src/consolidation/triggers.js:59,87`; constants in `src/core/constants.js:112,114`), not `bufferSize`/`idleTimeout`—see [consolidation.md](./consolidation.md) and drift #3 in the [drift register](./drift-register.md).

Validation is defensive: out-of-range numbers are rounded then clamped; non-numeric values fall back to defaults; unknown enum values fall back to the default; an unknown `scorerId` logs and falls back to `'default'` (`settings.js:85-161`). Note that `validateSettings` activates the scorer as a side effect of validation (`settings.js:151-158`), so merely loading settings makes the configured scorer live ([retrieval.md](./retrieval.md) covers why only Tier 3 consumes it—drift #8).

### Settings panel

`renderSettingsPanel(parent, { onOpenViewer })` (`src/integration/settingsPanel.js:80-102`) obtains the markup from ST's `renderExtensionTemplateAsync('third-party/SillyTavern-STARmem', 'settings')` when available, otherwise uses an inline fallback template (`settingsPanel.js:86-92`, `104-138`). The real template is `settings.html`; both share the `starmem-settings-*` ids.

- **Connection profiles** are read from `ctx.extensionSettings.connectionManager.profiles` (`settingsPanel.js:50-57`) and rendered into the extractor and embeddings dropdowns; a leading `— None —` option maps to `''` (`settingsPanel.js:146-157`).
- **Scorer** options come from `getAvailableScorerIds()`, which hardcodes `['default']` because no listing API exists (`settingsPanel.js:70-72`)—drift #8.
- **Every control is wired to `setSettings`** by `wireInputs` (`settingsPanel.js:176-311`): buffer/idle/depth/traces sliders (idle is stored in milliseconds: seconds × 1000, `settingsPanel.js:198`), profile/embed/scorer/extraction-label, debug checkbox, and the four injection controls. The scorer change also hot-swaps via `setScorer` (`settingsPanel.js:230-242`).
- **`applyInjectionEnableState()`** (`settingsPanel.js:328-349`) greys out—never hides—position/depth/role when mode is not `automatic`, and additionally greys depth when position is not `IN_CHAT`. Values remain persisted even while disabled.
- **Actions** (`wireActions`, `settingsPanel.js:352-366`): "Reset to defaults" calls `resetSettings()` then re-renders the panel; "Open Memory Viewer" invokes the `onOpenViewer` callback.
- **Warnings** (`renderWarnings`, `settingsPanel.js:374-389`): if no connection profiles exist, the panel appends "Connection Manager has no profiles configured—LLM-backed consolidation will fail."

## Indicator

`mountIndicator(getChatId)` (`src/integration/indicator.js:48-76`) unmounts any prior instance, creates `<div id="starmem-indicator">` in the idle class, and appends it to `#send_form` (falling back to `document.body` with a floating class when absent—`indicator.js:64-71`). It then polls every `POLL_INTERVAL_MS = 1000` (`indicator.js:34,74`).

`tick()` (`indicator.js:95-112`) resolves the chat id through the injected resolver; no chat id or a load error sets the idle state. Otherwise it calls `loadState(chatId)` and reads `state.runtime.consolidating`: true sets the busy state with `state.runtime` (`setBusy`, `indicator.js:124-134`), false/idle sets the quiet dot (`setIdle`, `indicator.js:114-119`). The busy title includes `runtime.lastConsolidation` when present. `unmountIndicator()` clears the interval and removes any element with the indicator id, defensively (`indicator.js:79-90`). `_tickForTests()` steps one poll without waiting (`indicator.js:93`).

## `{{starmem-memories}}` macro

The macro body is a per-chat in-memory cache, `Map<chatId, string>` (`src/integration/macro.js:28-29`). `setMemoryBody(chatId, body)` writes it and is called by the interceptor after every retrieval regardless of mode (`macro.js:61-64`); `getMemoryBody(chatId)` reads it, defaulting to `''` (`macro.js:72-75`).

`registerStarmemMacro()` (`macro.js:112-155`) is idempotent (`registered` flag) and dynamic-imports ST's engines at bootstrap so the static dependency graph never reaches into the ST tree. It tries the current `macros/macro-system.js` registry first (`macro.js:115-128`), then the legacy `macros.js` `MacrosParser` (`macro.js:134-146`), and returns `false` if neither is importable—typical in Jest/degraded environments (`macro.js:147-154`). `MACRO_NAME = 'starmem-memories'` (`constants.js:67`).

`memoriesMacroHandler()` (`macro.js:88-98`) resolves the active `chatId` at substitution time and returns its cached body; it never triggers retrieval. Errors are swallowed and render as `''`. Empty string is the neutral element when nothing has been cached (cold load, `off` mode, or an errored retrieval).

## See also

- [architecture.md](./architecture.md)—the boot sequence diagram, module layering, and how this page's wiring fits the two lifecycles.
- [retrieval.md](./retrieval.md)—what `retrieve()` does with the query the interceptor extracts, including the trace the Traces tab renders.
- [consolidation.md](./consolidation.md)—what the bootstrap triggers actually run.
- [viewer.md](./viewer.md)—the Memory Viewer opened by the settings panel.
- [data-model.md](./data-model.md)—the `State`/`Entry`/`Runtime` shapes the hooks read and write.
- [drift-register.md](./drift-register.md)—full entries for drift #3 (inert settings) and #8 (partial scorer pluggability).
