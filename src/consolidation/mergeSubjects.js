/**
 * Merge subjects — consolidation-layer mutation (Spec §2 principle 2:
 * long-term mutations live here, not in integration/). Reassigns every entry
 * of one subject to another, then folds duplicate episodic entries under the
 * target using consolidation's dedup rule (same subject + Jaccard ≥ 0.7),
 * removing the losers' graph edges. Persona/working entries are renamed only.
 *
 * @module consolidation/mergeSubjects
 */

import { loadState, persistState } from '../core/state.js';
import { withWriteLock } from '../core/lock.js';
import { findDuplicate } from './dedup.js';
import { removeEdge } from '../memory/graph.js';
import { applyUpdateEvent } from '../lifecycle/index.js';
import { invalidateTier0Cache } from '../retrieval/tier0-exact.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('consolidation:mergeSubjects');

/**
 * Merge one subject into another: every entry whose subject is `fromSubject`
 * is reassigned to `toSubject`, then episodic entries under the target are
 * deduplicated with the same rule consolidation uses (same subject +
 * Jaccard ≥ 0.7 on tokenized content) — duplicates fold into the surviving
 * entry via applyUpdateEvent and their graph edges are removed.
 * Persona/working entries are renamed only. Tier caches are invalidated.
 *
 * @param {string} chatId
 * @param {string} fromSubject
 * @param {string} toSubject
 * @returns {Promise<{ moved: number, deduped: number }>}
 */
export async function mergeSubjects(chatId, fromSubject, toSubject) {
    if (typeof fromSubject !== 'string' || fromSubject.length === 0
        || typeof toSubject !== 'string' || toSubject.length === 0) {
        throw new Error('mergeSubjects: both subjects required');
    }
    if (fromSubject === toSubject) {
        throw new Error('mergeSubjects: source and target are the same subject');
    }
    return withWriteLock(chatId, async () => {
        const state = await loadState(chatId);

        // 1. Reassign subject on every affected entry.
        const entries = { ...state.entries };
        let moved = 0;
        for (const [id, e] of Object.entries(entries)) {
            if (e && e.subject === fromSubject) {
                entries[id] = { ...e, subject: toSubject };
                moved++;
            }
        }
        if (moved === 0) return { moved: 0, deduped: 0 };

        // 2. Dedup episodic entries under the target subject. Deterministic
        //    order (by id) so the survivor choice is stable across runs.
        const now = new Date();
        const targets = Object.values(entries)
            .filter(e => e && e.scope === 'episodic' && e.subject === toSubject)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        /** @type {any[]} */
        const kept = [];
        const removedIds = new Set();
        for (const e of targets) {
            const dup = findDuplicate(e, kept);
            if (dup) {
                const bumped = { ...dup, lifecycle: applyUpdateEvent(dup.lifecycle, now) };
                entries[dup.id] = bumped;
                kept[kept.indexOf(dup)] = bumped;
                delete entries[e.id];
                removedIds.add(e.id);
            } else {
                kept.push(e);
            }
        }

        // 3. Drop graph edges touching deleted entries.
        let graph = state.graph;
        if (removedIds.size > 0) {
            let work = { ...state, entries, graph };
            for (const edge of graph.edges) {
                if (removedIds.has(edge.from) || removedIds.has(edge.to)) {
                    work = removeEdge(work, edge.from, edge.to, edge.type);
                }
            }
            graph = work.graph;
        }

        // 4. Invalidate both retrieval tier caches and persist.
        let next = { ...state, entries, graph, tierCaches: { exact: {}, fuzzy: {} } };
        next = invalidateTier0Cache(next);
        await persistState(chatId, next);
        log.info(`merged subject "${fromSubject}" → "${toSubject}" (${moved} moved, ${removedIds.size} deduped)`);
        return { moved, deduped: removedIds.size };
    });
}
