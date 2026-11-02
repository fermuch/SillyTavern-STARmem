/**
 * Maintenance — clear and rebuild memory state for the current chat.
 *
 * "Clear" resets chatMetadata['STARmem'] to createEmptyState().
 * "Rebuild" = clear + backfill: seeds one `scope: 'working'` entry per
 * assistant message in the current chat (mirroring onMessageReceived's
 * capture rules — greeting/user/system skipped, reasoning stripped), then
 * drains the buffer through consolidate() in BATCH_SIZE chunks, reporting
 * progress via callback so the settings panel can render a live bar.
 *
 * @module integration/maintenance
 */

import { createEntry } from '../memory/entry.js';
import { createEmptyState } from '../core/schema.js';
import { loadState, persistState } from '../core/state.js';
import { withWriteLock } from '../core/lock.js';
import { consolidate } from '../consolidation/consolidate.js';
import { CONSOLIDATION } from '../core/constants.js';
import { getSettings } from './settings.js';
import { rebuildPersona } from '../consolidation/personaRebuild.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:maintenance');

/** @returns {any} */
function resolveContext() {
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') {
        throw new Error('[STARmem] SillyTavern.getContext() unavailable');
    }
    return st.getContext();
}

/** Current chat id (ST chat file name) or null when no chat is open. */
export function currentChatId() {
    try {
        const ctx = resolveContext();
        return typeof ctx.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null;
    } catch {
        return null;
    }
}

/**
 * Wipe all memory state for a chat.
 * @param {string} chatId
 */
export async function clearMemories(chatId) {
    await withWriteLock(chatId, async () => {
        await persistState(chatId, createEmptyState());
    });
    log.info(`cleared all memories for chat ${chatId}`);
}

/**
 * @typedef {object} RebuildProgress
 * @property {'clearing'|'seeding'|'extracting'|'done'|'cancelled'|'error'} phase
 * @property {number} seeded     - working entries created from chat history.
 * @property {number} done       - working entries drained so far.
 * @property {number} batch      - 1-based index of the current extraction batch.
 * @property {number} batches    - estimated total extraction batches.
 * @property {number} added      - cumulative episodic entries inserted.
 * @property {number} updated    - cumulative episodic entries updated (dedup).
 * @property {string} [message]  - human-readable detail for terminal phases.
 */

/**
 * Clear + re-extract memories from every existing assistant message of the
 * current chat. Extraction uses the configured connection profile, one LLM
 * call per CONSOLIDATION.BATCH_SIZE messages.
 *
 * @param {string} chatId
 * @param {object} [hooks]
 * @param {(p: RebuildProgress) => void} [hooks.onProgress]
 * @param {() => boolean} [hooks.shouldCancel] - checked between batches.
 * @returns {Promise<RebuildProgress>} final progress snapshot.
 */
export async function rebuildMemories(chatId, hooks = {}) {
    const { onProgress, shouldCancel } = hooks;
    /** @type {RebuildProgress} */
    const p = { phase: 'clearing', seeded: 0, done: 0, batch: 0, batches: 0, added: 0, updated: 0 };
    const report = () => { try { onProgress?.({ ...p }); } catch { /* UI errors must not kill the run */ } };
    report();

    const ctx = resolveContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const settings = getSettings();
    const opts = {
        profileId: settings.profileId,
        extractorLabel: `${settings.extractionModelLabel || 'unknown'}@rebuild`,
        messageOf: (/** @type {any} */ e) => ({ role: 'assistant', content: e.content }),
    };

    await clearMemories(chatId);

    // Seed working entries from chat history — same capture rules as
    // bootstrap.js#onMessageReceived: skip greeting (index 0 when not from
    // the user), skip user/system/empty messages, strip reasoning blocks.
    p.phase = 'seeding';
    report();
    const parseReasoning = typeof ctx.parseReasoningFromString === 'function'
        ? ctx.parseReasoningFromString : null;
    const first = chat.length > 0 && !chat[0].is_user ? 1 : 0;
    /** @type {any[]} */
    const toAdd = [];
    for (let i = first; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        if (typeof m.mes !== 'string' || m.mes.trim().length === 0) continue;
        let content = m.mes;
        if (parseReasoning) {
            try {
                const parsed = parseReasoning(m.mes, { strict: false });
                if (parsed && typeof parsed.content === 'string'
                    && (parsed.reasoning || parsed.content !== m.mes)) {
                    content = parsed.content;
                }
            } catch { /* keep raw mes */ }
        }
        if (typeof content !== 'string' || content.trim().length === 0) continue;
        toAdd.push(createEntry({
            scope: 'working',
            content,
            subject: null,
            tags: [],
            relations: [],
            provenance: { sourceMessages: [i], extractor: 'maintenance@rebuild-v1' },
            now: new Date(),
        }));
    }
    await withWriteLock(chatId, async () => {
        const state = await loadState(chatId);
        const entries = { ...state.entries };
        const workingBuffer = [...state.workingBuffer];
        for (const e of toAdd) {
            entries[e.id] = e;
            workingBuffer.push(e.id);
        }
        await persistState(chatId, { ...state, entries, workingBuffer });
    });
    p.seeded = toAdd.length;
    p.batches = Math.ceil(toAdd.length / CONSOLIDATION.BATCH_SIZE);
    report();

    if (toAdd.length === 0) {
        p.phase = 'done';
        p.message = 'No assistant messages to extract from.';
        report();
        return { ...p };
    }

    // Drain: consolidate() consumes min(BATCH_SIZE, remaining) per call.
    p.phase = 'extracting';
    report();
    for (;;) {
        if (shouldCancel?.()) {
            p.phase = 'cancelled';
            p.message = `${p.done}/${p.seeded} messages processed; the rest stay in the working buffer and will consolidate on normal triggers.`;
            report();
            return { ...p };
        }
        const r = await consolidate(chatId, opts);
        if (r && typeof r === 'object' && 'skipped' in r && r.skipped) {
            // Stale in-flight guard was cleared by consolidate; retry once
            // on the next loop turn. A live trigger may also hold the lock.
            const state = await loadState(chatId);
            if (state.workingBuffer.length === 0) break;
            continue;
        }
        const res = /** @type {any} */ (r);
        p.batch += 1;
        p.added += res.added || 0;
        p.updated += res.updated || 0;
        p.done = Math.min(p.seeded, p.done + (res.drained || 0));
        report();
        if ((res.drained || 0) === 0) break;
    }

    p.phase = 'done';
    p.message = `${p.seeded} messages → ${p.added} memories added, ${p.updated} updated.`;
    report();
    log.info(`rebuild for ${chatId}: ${p.message}`);
    return { ...p };
}

/**
 * Serialize the full STARmem state of a chat as a JSON string for manual
 * backup. Includes a small envelope (kind/formatVersion) so imports can
 * reject foreign files.
 * @param {string} chatId
 * @returns {Promise<string>}
 */
export async function exportMemories(chatId) {
    const state = await loadState(chatId);
    return JSON.stringify({
        kind: 'starmem-chat-export',
        formatVersion: 1,
        chatId,
        exportedAt: new Date().toISOString(),
        entryCount: Object.keys(state.entries).length,
        state,
    }, null, 2);
}

/**
 * Restore STARmem state from an exportMemories() payload, REPLACING the
 * chat's current state. Merges onto createEmptyState() so fields introduced
 * in later versions exist after importing an older export.
 * @param {string} chatId
 * @param {string} json
 * @returns {Promise<{ entries: number, workingBuffer: number }>}
 */
export async function importMemories(chatId, json) {
    const data = JSON.parse(json); // throws SyntaxError on invalid JSON
    const state = data?.state;
    if (data?.kind !== 'starmem-chat-export'
        || !state || typeof state !== 'object'
        || typeof state.entries !== 'object' || state.entries === null
        || !Array.isArray(state.workingBuffer)
        || !state.graph || !Array.isArray(state.graph.edges)) {
        throw new Error('Not a STARmem export file (missing entries/workingBuffer/graph)');
    }
    const base = createEmptyState();
    const merged = {
        ...base,
        ...state,
        graph: { ...base.graph, ...state.graph },
        tierCaches: { ...base.tierCaches, ...(state.tierCaches || {}) },
        runtime: { ...base.runtime, ...(state.runtime || {}), consolidating: false },
    };
    await withWriteLock(chatId, async () => {
        await persistState(chatId, merged);
    });
    log.info(`imported ${Object.keys(merged.entries).length} entries for chat ${chatId}`);
    return {
        entries: Object.keys(merged.entries).length,
        workingBuffer: merged.workingBuffer.length,
    };
}

/** @type {boolean} */
let autoPersonaRunning = false;

/**
 * Auto persona rebuild driver, registered as the consolidation follow-up.
 * No-op unless the user enabled "Auto-rebuild persona" in settings AND the
 * chat's pendingPersonaRebuild suggestion flag is set (100+ new episodic
 * entries since the last rebuild). Rebuilds every subject that has episodic
 * entries; each successful rebuild clears the flag (raptor/atomic.js).
 * Serialized by a module-level guard — consolidations fire often.
 * @param {string} chatId
 */
export async function maybeAutoRebuildPersona(chatId) {
    if (!getSettings().autoPersonaRebuild) return;
    if (autoPersonaRunning) return;
    let state;
    try {
        state = await loadState(chatId);
    } catch {
        return;
    }
    if (state.runtime?.pendingPersonaRebuild !== true) return;
    const subjects = [...new Set(
        Object.values(state.entries)
            .filter((/** @type {any} */ e) => e.scope === 'episodic' && typeof e.subject === 'string' && e.subject.length > 0)
            .map((/** @type {any} */ e) => e.subject),
    )];
    if (subjects.length === 0) return;
    autoPersonaRunning = true;
    log.info(`auto persona rebuild: ${subjects.length} subject(s) — ${subjects.join(', ')}`);
    try {
        const settings = getSettings();
        for (const subject of subjects) {
            await rebuildPersona(chatId, subject, {
                profileId: settings.profileId,
                extractorLabel: `${settings.extractionModelLabel || 'unknown'}@auto-persona`,
                now: new Date(),
            });
        }
    } finally {
        autoPersonaRunning = false;
    }
}
