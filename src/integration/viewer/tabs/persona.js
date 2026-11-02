/**
 * Persona tab — grouped Persona entries per subject + Rebuild button.
 *
 * @module integration/viewer/tabs/persona
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { CSS_PREFIX } from '../../constants.js';
import { getSettings } from '../../settings.js';
import { rebuildPersona, mergeSubjects } from '../../../consolidation/index.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:viewer:persona');

/** @type {AbortController | null} */
let activeRebuild = null;

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, subjectFilter: string, state: { entries?: Record<string, any> } }} ctx
 */
export async function renderTab(parent, ctx) {
    const all = Object.values(ctx?.state?.entries || {});
    const persona = all.filter(e => e && e.scope === 'persona');
    const groups = groupBySubject(persona, ctx.subjectFilter || '');
    const settings = getSettings();

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-persona`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-persona-header`;
    const subjectCount = groups.size;
    header.textContent = `Persona — ${persona.length} entries across ${subjectCount} subject${subjectCount === 1 ? '' : 's'}`;
    root.appendChild(header);

    const rerender = () => renderTab(parent, ctx);
    const overview = buildSubjectsOverview(all, ctx.chatId, settings, ctx.subjectFilter || '', rerender);
    if (overview) root.appendChild(overview);

    if (subjectCount === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = ctx.subjectFilter
            ? `No Persona entries for "${ctx.subjectFilter}" yet.`
            : 'No Persona entries yet. Rebuild a subject to generate them.';
        root.appendChild(empty);
        // Still render a rebuild form so the user has an entry point.
        root.appendChild(buildRebuildForm(parent, ctx.chatId, settings, rerender));
        parent.appendChild(root);
        return;
    }

    for (const [subject, entries] of groups) {
        root.appendChild(buildSubjectGroup(subject, entries, ctx.chatId, settings, rerender, countUnprocessed(all, subject)));
    }
    parent.appendChild(root);
}

/**
 * Count episodic entries for a subject that no Persona entry has distilled
 * yet. Persona entries record the chat-message indexes they were built from
 * (provenance.sourceMessages); an episodic entry is "unprocessed" when none
 * of its own source messages appear in that union. Entries with no recorded
 * source messages count as unprocessed (can't prove otherwise).
 *
 * @param {any[]} all
 * @param {string} subject
 * @returns {number}
 */
function countUnprocessed(all, subject) {
    const covered = new Set();
    for (const p of all) {
        if (!p || p.scope !== 'persona' || p.subject !== subject) continue;
        for (const m of p.provenance?.sourceMessages ?? []) covered.add(m);
    }
    if (covered.size === 0) return 0;
    let n = 0;
    for (const e of all) {
        if (!e || e.scope !== 'episodic' || e.subject !== subject) continue;
        const msgs = e.provenance?.sourceMessages ?? [];
        if (!msgs.some(m => covered.has(m))) n++;
    }
    return n;
}

/**
 * Aggregate every known subject (any scope, real subject strings only —
 * '(no subject)' placeholders excluded) with per-scope entry counts,
 * sorted A→Z. Powers the Subjects overview list.
 *
 * @param {any[]} entries
 * @returns {Map<string, { episodic: number, persona: number, working: number }>}
 */
function collectSubjects(entries) {
    /** @type {Map<string, { episodic: number, persona: number, working: number }>} */
    const map = new Map();
    for (const e of entries) {
        if (!e || typeof e.subject !== 'string' || e.subject.length === 0) continue;
        const rec = map.get(e.subject) ?? { episodic: 0, persona: 0, working: 0 };
        if (e.scope === 'episodic' || e.scope === 'persona' || e.scope === 'working') rec[e.scope]++;
        map.set(e.subject, rec);
    }
    return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Subjects overview section — one row per known subject with entry counts
 * and a Rebuild button, so subjects are discoverable even before any
 * Persona entries exist for them. Honours the viewer's subject filter.
 * Returns null when no subjects match.
 */
function buildSubjectsOverview(entries, chatId, settings, subjectFilter, onRerender) {
    const q = subjectFilter.toLowerCase();
    // Merge targets = every known subject. Display rows exclude subjects
    // that already have Persona entries — those have their own group with a
    // Rebuild button below, so listing them here would duplicate them.
    const allSubjects = [...collectSubjects(entries).keys()]
        .filter(s => !q || s.toLowerCase().includes(q));
    const rows = [...collectSubjects(entries).entries()]
        .filter(([s, counts]) => counts.persona === 0 && (!q || s.toLowerCase().includes(q)));
    if (rows.length === 0) return null;

    const section = document.createElement('section');
    section.className = `${CSS_PREFIX}-viewer-subjects`;
    const title = document.createElement('h3');
    title.className = `${CSS_PREFIX}-viewer-subjects-title`;
    title.textContent = `Subjects without persona (${rows.length})`;
    section.appendChild(title);

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-subjects-list`;
    for (const [subject, counts] of rows) {
        const item = document.createElement('li');
        item.className = `${CSS_PREFIX}-viewer-subjects-row`;
        item.setAttribute('data-subject', subject);

        const name = document.createElement('span');
        name.className = `${CSS_PREFIX}-viewer-subjects-name`;
        name.textContent = subject;
        item.appendChild(name);

        const meta = document.createElement('span');
        meta.className = `${CSS_PREFIX}-viewer-subjects-counts`;
        meta.textContent = `${counts.episodic} episodic · ${counts.persona} persona`;
        item.appendChild(meta);

        const actions = document.createElement('span');
        actions.className = `${CSS_PREFIX}-viewer-subjects-actions`;
        actions.appendChild(buildRebuildButton(chatId, subject, settings, item, onRerender));
        actions.appendChild(buildMergeControl(item, chatId, subject, allSubjects, onRerender));
        item.appendChild(actions);

        const progress = document.createElement('div');
        progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
        progress.setAttribute('aria-live', 'polite');
        item.appendChild(progress);

        list.appendChild(item);
    }
    section.appendChild(list);
    return section;
}

/**
 * Per-row "Merge…" button + inline target picker. Merging reassigns every
 * entry of this row's subject to the chosen target and folds duplicates
 * (maintenance.mergeSubjects).
 */
function buildMergeControl(item, chatId, subject, allSubjects, onRerender) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-subjects-merge`;
    btn.textContent = 'Merge…';
    const others = allSubjects.filter(s => s !== subject);
    if (others.length === 0) {
        btn.disabled = true;
        btn.title = 'No other subject to merge into.';
        return btn;
    }
    btn.title = 'Reassign all entries of this subject to another subject';

    btn.addEventListener('click', () => {
        const existing = item.querySelector(`.${CSS_PREFIX}-viewer-subjects-merge-form`);
        if (existing) { existing.remove(); return; }

        const form = document.createElement('div');
        form.className = `${CSS_PREFIX}-viewer-subjects-merge-form`;

        const label = document.createElement('span');
        label.className = `${CSS_PREFIX}-viewer-subjects-merge-label`;
        label.textContent = `Merge “${subject}” into:`;
        form.appendChild(label);

        const select = document.createElement('select');
        select.className = `text_pole ${CSS_PREFIX}-viewer-subjects-merge-select`;
        for (const other of others) {
            const o = document.createElement('option');
            o.value = other;
            o.textContent = other;
            select.appendChild(o);
        }
        form.appendChild(select);

        const status = document.createElement('span');
        status.className = `${CSS_PREFIX}-viewer-subjects-merge-status`;

        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = `menu_button ${CSS_PREFIX}-viewer-subjects-merge-ok`;
        ok.textContent = 'Merge';
        ok.addEventListener('click', async () => {
            const target = select.value;
            if (!target) return;
            ok.disabled = true;
            btn.disabled = true;
            status.textContent = 'Merging…';
            try {
                const r = await mergeSubjects(chatId, subject, target);
                status.textContent = r.moved === 0
                    ? 'Nothing to merge.'
                    : `Merged ${r.moved} entries` + (r.deduped > 0 ? `, folded ${r.deduped} duplicates.` : '.');
                setTimeout(() => onRerender(), 600);
            } catch (err) {
                status.textContent = `Failed: ${String(err?.message || err)}`;
                ok.disabled = false;
                btn.disabled = false;
            }
        });
        form.appendChild(ok);

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = `menu_button ${CSS_PREFIX}-viewer-subjects-merge-cancel`;
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => form.remove());
        form.appendChild(cancel);

        form.appendChild(status);
        item.appendChild(form);
    });
    return btn;
}

function groupBySubject(entries, subjectFilter) {
    // Use a Map so subject strings like "__proto__" don't collide with
    // Object.prototype (finding #1).
    const groups = new Map();
    const q = subjectFilter.toLowerCase();
    for (const e of entries) {
        const subj = e.subject ?? '(no subject)';
        if (q && !subj.toLowerCase().includes(q)) continue;
        if (!groups.has(subj)) groups.set(subj, []);
        groups.get(subj).push(e);
    }
    return groups;
}

function buildSubjectGroup(subject, entries, chatId, settings, onRerender, unprocessed = 0) {
    const section = document.createElement('section');
    section.className = `${CSS_PREFIX}-viewer-persona-group`;
    section.setAttribute('data-subject', subject);

    const head = document.createElement('div');
    head.className = `${CSS_PREFIX}-viewer-persona-group-head`;
    const title = document.createElement('h3');
    title.className = `${CSS_PREFIX}-viewer-persona-subject`;
    title.textContent = `${subject} (${entries.length})`;
    head.appendChild(title);
    if (unprocessed > 0) {
        const pending = document.createElement('span');
        pending.className = `${CSS_PREFIX}-viewer-persona-pending`;
        pending.textContent = `+${unprocessed} unprocessed`;
        pending.title = `${unprocessed} episodic entr${unprocessed === 1 ? 'y is' : 'ies are'} not distilled into this persona yet — Rebuild to include`;
        head.appendChild(pending);
    }
    head.appendChild(buildRebuildButton(chatId, subject, settings, section, onRerender));
    section.appendChild(head);

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-persona-list`;
    for (const e of entries) list.appendChild(buildPersonaItem(e));
    section.appendChild(list);

    const progress = document.createElement('div');
    progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
    progress.setAttribute('aria-live', 'polite');
    section.appendChild(progress);

    return section;
}

function buildPersonaItem(entry) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-persona-item`;
    li.setAttribute('data-id', entry.id);
    const content = document.createElement('div');
    content.className = `${CSS_PREFIX}-viewer-content`;
    content.textContent = entry.content ?? '';
    li.appendChild(content);
    const provenance = document.createElement('div');
    provenance.className = `${CSS_PREFIX}-viewer-provenance`;
    provenance.textContent = `from ${entry.provenance?.extractor ?? 'unknown'}`;
    li.appendChild(provenance);
    return li;
}

function buildRebuildButton(chatId, subject, settings, section, onRerender) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${CSS_PREFIX}-viewer-persona-rebuild menu_button`;
    btn.textContent = 'Rebuild';

    if (!settings.profileId) {
        btn.disabled = true;
        btn.title = 'Configure extractor LLM in settings first.';
        return btn;
    }

    btn.addEventListener('click', async () => {
        if (activeRebuild) {
            // This button's rebuild is the active one → cancel.
            if (btn.dataset.active === '1') {
                activeRebuild.abort();
                return;
            }
            // Another subject's rebuild is running; the button should already be disabled.
            return;
        }

        const ac = new AbortController();
        activeRebuild = ac;
        btn.dataset.active = '1';
        btn.textContent = 'Cancel';
        disableOtherRebuildButtons(true);

        const progressEl = /** @type {HTMLElement} */ (section.querySelector(`.${CSS_PREFIX}-viewer-persona-progress`));
        progressEl.innerHTML = '';
        const reportProgress = createProgressReporter(progressEl);
        reportProgress.line('Starting rebuild…');

        try {
            const result = await rebuildPersona(chatId, subject, {
                profileId: settings.profileId,
                extractorLabel: settings.extractionModelLabel || 'unknown@persona-rebuild-v1',
                signal: ac.signal,
                onProgress: (p) => reportProgress.stage(p),
                now: new Date(),
            });
            reportProgress.line(`Done — ${result.newCount} new / ${result.replacedCount} replaced in ${result.duration}ms`);
        } catch (err) {
            if (err?.name === 'AbortError') {
                reportProgress.line('Cancelled.');
            } else {
                reportProgress.line(`Failed: ${String(err?.message || err)}`);
                log.warn('rebuildPersona failed:', err);
            }
        } finally {
            activeRebuild = null;
            btn.dataset.active = '';
            btn.textContent = 'Rebuild';
            disableOtherRebuildButtons(false);
            // Re-render to pick up new Persona entries. Defer so the user sees
            // the "Done" line for a beat.
            setTimeout(() => onRerender(), 300);
        }
    });
    return btn;
}

/**
 * Compact progress reporter for persona rebuilds. The pipeline emits one
 * `summarize` event PER CLUSTER per depth — an append-only log floods with
 * dozens of identical lines (and every line looks the same). Instead:
 * each pipeline stage owns ONE line, updated in place; the active stage is
 * marked ▸ and completed stages ✓; summarize lines carry cluster x/y.
 *
 * @param {HTMLElement} progressEl
 */
function createProgressReporter(progressEl) {
    /** @type {Map<string, HTMLElement>} stage key → its line element */
    const stageLines = new Map();
    /** @type {HTMLElement | null} */
    let activeLine = null;

    const scroll = () => { progressEl.scrollTop = progressEl.scrollHeight; };

    const markDone = () => {
        if (activeLine) {
            activeLine.classList.remove(`${CSS_PREFIX}-viewer-progress-line-active`);
            activeLine.textContent = `✓ ${activeLine.textContent.slice(2)}`;
            activeLine = null;
        }
    };

    /** @param {string} text */
    const line = (text) => {
        markDone();
        const p = document.createElement('div');
        p.className = `${CSS_PREFIX}-viewer-progress-line`;
        p.textContent = text;
        progressEl.appendChild(p);
        scroll();
    };

    /**
     * @param {{ stage: string, depth?: number, cluster?: number, clusters?: number,
     *           count?: number, leaves?: number, gamma?: number }} p
     */
    const stage = (p) => {
        let key = p.stage;
        let text;
        switch (p.stage) {
            case 'snapshot':
                text = 'Snapshotting state'; break;
            case 'chunk':
                text = `Chunking ${p.count ?? '?'} facts`; break;
            case 'knn':
                key = `${p.stage}:${p.depth}`;
                text = `Depth ${p.depth}: k-NN graph (${p.leaves ?? '?'} leaves)`; break;
            case 'cluster':
                key = `${p.stage}:${p.depth}`;
                text = `Depth ${p.depth}: clustering`; break;
            case 'summarize': {
                key = `${p.stage}:${p.depth}`;
                const cur = (p.cluster ?? 0) + 1;
                text = p.clusters != null
                    ? `Depth ${p.depth}: summarizing cluster ${cur}/${p.clusters}`
                    : `Depth ${p.depth}: summarizing cluster ${cur}`;
                break;
            }
            case 'summarize-root':
                text = 'Merging root summary'; break;
            case 'summarize-root-direct':
                text = 'Summarizing (too few facts to cluster)'; break;
            case 'atomic-swap':
                text = `Writing ${p.count ?? '?'} persona entries`; break;
            default:
                text = p.stage;
        }
        const existing = stageLines.get(key);
        if (existing) {
            existing.textContent = `▸ ${text}`;
        } else {
            markDone();
            const el = document.createElement('div');
            el.className = `${CSS_PREFIX}-viewer-progress-line ${CSS_PREFIX}-viewer-progress-line-active`;
            el.textContent = `▸ ${text}`;
            progressEl.appendChild(el);
            stageLines.set(key, el);
            activeLine = el;
        }
        scroll();
    };

    return { line, stage };
}

function buildRebuildForm(parent, chatId, settings, onRerender) {
    // Offered when no Persona entries exist yet. Requires a subject typed in.
    const form = document.createElement('div');
    form.className = `${CSS_PREFIX}-viewer-persona-rebuild-form`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Subject to rebuild (e.g. alice)';
    input.className = `${CSS_PREFIX}-viewer-persona-subject-input`;
    form.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-persona-rebuild`;
    btn.textContent = 'Rebuild';
    if (!settings.profileId) {
        btn.disabled = true;
        btn.title = 'Configure extractor LLM in settings first.';
    } else {
        btn.addEventListener('click', async () => {
            const subject = input.value.trim();
            if (!subject) return;
            // Synthesize a section-like container for progress; reuse buildSubjectGroup's progress style.
            const sec = document.createElement('section');
            sec.className = `${CSS_PREFIX}-viewer-persona-group`;
            const progress = document.createElement('div');
            progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
            sec.appendChild(progress);
            form.appendChild(sec);
            // Build a standalone button for running and reuse its handler.
            const trigger = buildRebuildButton(chatId, subject, settings, sec, onRerender);
            trigger.click();
        });
    }
    form.appendChild(btn);
    return form;
}

function disableOtherRebuildButtons(disabled) {
    const btns = document.querySelectorAll(`.${CSS_PREFIX}-viewer-persona-rebuild`);
    for (const b of btns) {
        if (/** @type {HTMLButtonElement} */ (b).dataset.active === '1') continue;
        /** @type {HTMLButtonElement} */ (b).disabled = disabled;
    }
}
