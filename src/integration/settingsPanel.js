/**
 * Settings panel — DOM wiring for settings.html.
 *
 * Reads settings via getSettings(), mutates via setSettings()/resetSettings(),
 * populates dropdowns from ST's connection-manager profile list, exposes a
 * callback for the "Open Memory Viewer" button.
 *
 * Plan-bug fixes:
 * - getAvailableScorerIds originally probed via getScorer(id), but getScorer()
 *   takes no args and returns the *active* scorer. Hardcoding ['default'] is
 *   the honest answer until retrieval/index.js exports listScorers().
 *   TODO(phase-9): add listScorers() to the retrieval barrel.
 *
 * @module integration/settingsPanel
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { getSettings, setSettings, resetSettings } from './settings.js';
import {
    CSS_PREFIX,
    INJECTION_MODE_AUTOMATIC,
    INJECTION_POSITION_IN_CHAT,
} from './constants.js';
import { createLogger } from '../core/logger.js';
import { clearMemories, rebuildMemories, currentChatId, exportMemories, importMemories } from './maintenance.js';

const log = createLogger({ debug: false }).scope('integration:settingsPanel');

/** @type {any} */
let testContext = null;

/** Test-only context injector. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context. */
export function _resetContextForTests() { testContext = null; }

/** @returns {any} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return {};
    return st.getContext();
}

/**
 * Read connection profiles from ST. Returns empty array on missing API.
 * Per Decision 10: profiles live at ctx.extensionSettings.connectionManager.profiles.
 *
 * @returns {{ id: string, name: string, api?: string }[]}
 */
export function getConnectionProfiles() {
    const ctx = resolveContext();
    const cm = ctx?.extensionSettings?.connectionManager;
    const profiles = Array.isArray(cm?.profiles) ? cm.profiles : [];
    return profiles
        .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
        .map(p => ({ id: p.id, name: p.name, api: p.api }));
}

/**
 * Registered scorer ids. The registry currently only exposes
 * getScorer() (no args, returns the active scorer) and setScorer(id)
 * (throws on unknown). No listing API yet.
 *
 * TODO(phase-9): add listScorers() to retrieval/index.js for proper
 * enumeration. Until then, hardcode 'default' (always registered by
 * retrieval/scorer.js module eval).
 *
 * @returns {string[]}
 */
export function getAvailableScorerIds() {
    return ['default'];
}

/**
 * Render the panel into the given parent. Idempotent — replaces prior content.
 *
 * @param {HTMLElement} parent
 * @param {{ onOpenViewer?: () => void }} [opts]
 */
export async function renderSettingsPanel(parent, opts = {}) {
    if (!parent) throw new Error('[STARmem] renderSettingsPanel: parent is required');

    const ctx = resolveContext();
    const renderer = ctx?.renderExtensionTemplateAsync;
    let html;
    if (typeof renderer === 'function') {
        html = await renderer('third-party/SillyTavern-STARmem', 'settings');
    } else {
        // Test / degraded-env fallback — inline a minimal template so tests
        // don't need a real ST template renderer.
        html = fallbackTemplate();
    }
    parent.innerHTML = html;

    const s = getSettings();
    populateProfileDropdown(`${CSS_PREFIX}-settings-profile-id`, s.profileId);
    populateProfileDropdown(`${CSS_PREFIX}-settings-embed-profile-id`, s.embedProfileId);
    populateScorerDropdown(s.scorerId);
    wireInputs(parent, s);
    wireActions(parent, opts);
    renderWarnings(parent);
}

function fallbackTemplate() {
    return `
        <div class="${CSS_PREFIX}-settings-panel">
            <select id="${CSS_PREFIX}-settings-profile-id"></select>
            <select id="${CSS_PREFIX}-settings-embed-profile-id"></select>
            <select id="${CSS_PREFIX}-settings-scorer"></select>
            <input type="text" id="${CSS_PREFIX}-settings-extraction-label" />
            <input type="range" id="${CSS_PREFIX}-settings-buffer-size" min="1" max="50" />
            <span id="${CSS_PREFIX}-settings-buffer-size-value"></span>
            <input type="range" id="${CSS_PREFIX}-settings-idle-timeout" min="5" max="600" />
            <span id="${CSS_PREFIX}-settings-idle-timeout-value"></span>
            <input type="range" id="${CSS_PREFIX}-settings-traces-max" min="16" max="1024" />
            <span id="${CSS_PREFIX}-settings-traces-max-value"></span>
            <input type="checkbox" id="${CSS_PREFIX}-settings-debug-mode" />
            <select id="${CSS_PREFIX}-settings-injection-mode">
                <option value="automatic">Automatic</option>
                <option value="macro">Macro</option>
                <option value="off">Off</option>
            </select>
            <select id="${CSS_PREFIX}-settings-injection-position">
                <option value="1">In-chat</option>
                <option value="0">In-prompt</option>
            </select>
            <input type="range" id="${CSS_PREFIX}-settings-injection-depth" min="0" max="10" />
            <span id="${CSS_PREFIX}-settings-injection-depth-value"></span>
            <select id="${CSS_PREFIX}-settings-injection-role">
                <option value="0">System</option>
                <option value="1">User</option>
                <option value="2">Assistant</option>
            </select>
            <button id="${CSS_PREFIX}-settings-reset">Reset</button>
            <button id="${CSS_PREFIX}-settings-open-viewer">Viewer</button>
            <div id="${CSS_PREFIX}-settings-warnings"></div>
        </div>`;
}

/** Populate a profile <select>. */
function populateProfileDropdown(id, currentValue) {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById(id));
    if (!select) return;
    const profiles = getConnectionProfiles();
    select.innerHTML = '';
    // Always add a "None" option first.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— None —';
    select.appendChild(none);
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.api ? `${p.name} (${p.api})` : p.name;
        select.appendChild(opt);
    }
    select.value = currentValue || '';
}

/** Populate the scorer <select>. */
function populateScorerDropdown(currentValue) {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-scorer`));
    if (!select) return;
    const ids = getAvailableScorerIds();
    select.innerHTML = '';
    for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
    }
    select.value = ids.includes(currentValue) ? currentValue : 'default';
}

/** Attach input event handlers. */
function wireInputs(parent, initial) {
    const bufSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-buffer-size`));
    const bufLabel = document.getElementById(`${CSS_PREFIX}-settings-buffer-size-value`);
    if (bufSlider) {
        bufSlider.value = String(initial.bufferSize);
        if (bufLabel) bufLabel.textContent = String(initial.bufferSize);
        bufSlider.addEventListener('input', () => {
            const v = Number(bufSlider.value);
            if (bufLabel) bufLabel.textContent = String(v);
            setSettings({ bufferSize: v });
        });
    }

    const idleSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-idle-timeout`));
    const idleLabel = document.getElementById(`${CSS_PREFIX}-settings-idle-timeout-value`);
    if (idleSlider) {
        const seconds = Math.round(initial.idleTimeout / 1000);
        idleSlider.value = String(seconds);
        if (idleLabel) idleLabel.textContent = `${seconds}s`;
        idleSlider.addEventListener('input', () => {
            const v = Number(idleSlider.value);
            if (idleLabel) idleLabel.textContent = `${v}s`;
            setSettings({ idleTimeout: v * 1000 });
        });
    }

    const tracesSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-traces-max`));
    const tracesLabel = document.getElementById(`${CSS_PREFIX}-settings-traces-max-value`);
    if (tracesSlider) {
        tracesSlider.value = String(initial.tracesMaxLen);
        if (tracesLabel) tracesLabel.textContent = String(initial.tracesMaxLen);
        tracesSlider.addEventListener('input', () => {
            const v = Number(tracesSlider.value);
            if (tracesLabel) tracesLabel.textContent = String(v);
            setSettings({ tracesMaxLen: v });
        });
    }

    const profile = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-profile-id`));
    if (profile) {
        profile.addEventListener('change', () => {
            setSettings({ profileId: profile.value });
        });
    }

    const embed = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-embed-profile-id`));
    if (embed) {
        embed.addEventListener('change', () => {
            setSettings({ embedProfileId: embed.value });
        });
    }

    const scorer = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-scorer`));
    if (scorer) {
        scorer.addEventListener('change', async () => {
            setSettings({ scorerId: scorer.value });
            // Also hot-swap the active scorer. setSettings() already validates
            // and activates via setScorer(), so this is belt-and-suspenders —
            // but dynamic import keeps the DOM panel from pulling retrieval
            // into its static dep graph.
            try {
                const { setScorer } = await import('../retrieval/index.js');
                setScorer(scorer.value);
            } catch (err) {
                log.warn(`setScorer failed: ${err?.message || err}`);
            }
        });
    }

    const label = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-extraction-label`));
    if (label) {
        label.value = initial.extractionModelLabel;
        label.addEventListener('change', () => {
            setSettings({ extractionModelLabel: label.value });
        });
    }

    const debug = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-debug-mode`));
    if (debug) {
        debug.checked = initial.debugMode;
        debug.addEventListener('change', () => {
            setSettings({ debugMode: debug.checked });
        });
    }

    // --- Injection (mode / position / depth / role) ---
    const modeSel = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-injection-mode`));
    const posSel = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-injection-position`));
    const depthSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-injection-depth`));
    const depthLabel = document.getElementById(`${CSS_PREFIX}-settings-injection-depth-value`);
    const roleSel = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-injection-role`));

    if (modeSel) modeSel.value = String(initial.injectionMode);
    if (posSel) posSel.value = String(initial.injectionPosition);
    if (depthSlider) {
        depthSlider.value = String(initial.injectionDepth);
        if (depthLabel) depthLabel.textContent = String(initial.injectionDepth);
    }
    if (roleSel) roleSel.value = String(initial.injectionRole);

    applyInjectionEnableState({
        mode: initial.injectionMode,
        position: initial.injectionPosition,
    });

    if (modeSel) {
        modeSel.addEventListener('change', () => {
            const merged = setSettings({ injectionMode: /** @type {any} */ (modeSel.value) });
            applyInjectionEnableState({
                mode: merged.injectionMode,
                position: merged.injectionPosition,
            });
        });
    }
    if (posSel) {
        posSel.addEventListener('change', () => {
            const merged = setSettings({ injectionPosition: Number(posSel.value) });
            applyInjectionEnableState({
                mode: merged.injectionMode,
                position: merged.injectionPosition,
            });
        });
    }
    if (depthSlider) {
        depthSlider.addEventListener('input', () => {
            const v = Number(depthSlider.value);
            if (depthLabel) depthLabel.textContent = String(v);
            setSettings({ injectionDepth: v });
        });
    }
    const kSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-retrieval-k`));
    const kLabel = document.getElementById(`${CSS_PREFIX}-settings-retrieval-k-value`);
    if (kSlider) {
        kSlider.value = String(initial.retrievalK);
        if (kLabel) kLabel.textContent = String(initial.retrievalK);
        kSlider.addEventListener('input', () => {
            const v = Number(kSlider.value);
            if (kLabel) kLabel.textContent = String(v);
            setSettings({ retrievalK: v });
        });
    }
    if (roleSel) {
        roleSel.addEventListener('change', () => {
            setSettings({ injectionRole: Number(roleSel.value) });
        });
    }
}

/**
 * Gray out — never hide — placement controls when they aren't applicable.
 *
 *   mode != 'automatic' → position / depth / role are inert. The user's
 *                         preset (macro mode) or nothing at all (off mode)
 *                         decides placement; our values are still persisted
 *                         but unused.
 *   position != IN_CHAT → depth is inert (depth is only meaningful for
 *                         depth-anchored in-chat injections).
 *
 * Hiding would imply the setting is gone; greying signals "still here, not
 * doing anything right now."
 *
 * @param {{ mode: string, position: number }} state
 */
export function applyInjectionEnableState(state) {
    const ids = [
        `${CSS_PREFIX}-settings-injection-position`,
        `${CSS_PREFIX}-settings-injection-depth`,
        `${CSS_PREFIX}-settings-injection-role`,
    ];
    const automatic = state.mode === INJECTION_MODE_AUTOMATIC;
    for (const id of ids) {
        const el = /** @type {HTMLInputElement | HTMLSelectElement | null} */ (document.getElementById(id));
        if (!el) continue;
        const isDepth = id.endsWith('-depth');
        const inChatGate = isDepth ? state.position === INJECTION_POSITION_IN_CHAT : true;
        el.disabled = !(automatic && inChatGate);
    }
    // Mirror disabled-state on the label/value span next to the depth slider
    // so it visibly grays alongside the control.
    const depthLabel = document.getElementById(`${CSS_PREFIX}-settings-injection-depth-value`);
    if (depthLabel) {
        const inChat = state.position === INJECTION_POSITION_IN_CHAT;
        depthLabel.style.opacity = (automatic && inChat) ? '' : '0.5';
    }
}

/** Attach action button handlers. */
function wireActions(parent, opts) {
    const reset = document.getElementById(`${CSS_PREFIX}-settings-reset`);
    if (reset) {
        reset.addEventListener('click', () => {
            resetSettings();
            // Re-render with new defaults.
            renderSettingsPanel(parent, opts);
        });
    }

    const openViewer = document.getElementById(`${CSS_PREFIX}-settings-open-viewer`);
    if (openViewer && typeof opts.onOpenViewer === 'function') {
        openViewer.addEventListener('click', () => opts.onOpenViewer());
    }
    wireMaintenance(parent);
}

/** Attach Maintenance section handlers (clear + rebuild with progress). */
function wireMaintenance(_parent) {
    const clearBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-clear`));
    const rebuildBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-rebuild`));
    const cancelBtn = document.getElementById(`${CSS_PREFIX}-settings-rebuild-cancel`);
    const progressBox = document.getElementById(`${CSS_PREFIX}-settings-rebuild-progress`);
    const barFill = document.getElementById(`${CSS_PREFIX}-settings-rebuild-bar-fill`);
    const status = document.getElementById(`${CSS_PREFIX}-settings-rebuild-status`);
    if (!clearBtn || !rebuildBtn) return;

    const toast = (/** @type {string} */ msg, /** @type {string} */ type = 'info') => {
        const t = /** @type {any} */ (globalThis).toastr;
        if (t && typeof t[type] === 'function') t[type](msg, 'STARmem');
        else log.info(msg);
    };

    const setBusy = (/** @type {boolean} */ busy) => {
        clearBtn.disabled = busy;
        rebuildBtn.disabled = busy;
    };

    clearBtn.addEventListener('click', async () => {
        const chatId = currentChatId();
        if (!chatId) { toast('No chat is open.', 'warning'); return; }
        if (!globalThis.confirm('Wipe ALL STARmem memories for the current chat? This cannot be undone.')) return;
        setBusy(true);
        try {
            await clearMemories(chatId);
            toast('Memories cleared.', 'success');
        } catch (err) {
            log.warn(`clear failed: ${err?.message || err}`);
            toast(`Clear failed: ${err?.message || err}`, 'error');
        } finally {
            setBusy(false);
        }
    });

    let cancelled = false;
    cancelBtn?.addEventListener('click', () => { cancelled = true; });

    rebuildBtn.addEventListener('click', async () => {
        const chatId = currentChatId();
        if (!chatId) { toast('No chat is open.', 'warning'); return; }
        if (!globalThis.confirm('Rebuild wipes existing memories for this chat and re-extracts them from every assistant message (one LLM call per 5 messages). Continue?')) return;

        cancelled = false;
        setBusy(true);
        if (progressBox) progressBox.hidden = false;
        const render = (/** @type {any} */ p) => {
            if (barFill) {
                const pct = p.seeded > 0 ? Math.round((p.done / p.seeded) * 100) : 0;
                barFill.style.width = `${pct}%`;
            }
            if (status) {
                status.textContent = p.phase === 'extracting'
                    ? `Batch ${p.batch}/${p.batches} — ${p.done}/${p.seeded} messages, ${p.added} added, ${p.updated} updated`
                    : p.phase === 'seeding' ? 'Reading chat history…'
                    : p.phase === 'clearing' ? 'Clearing existing memories…'
                    : (p.message || p.phase);
            }
        };
        try {
            const final = await rebuildMemories(chatId, { onProgress: render, shouldCancel: () => cancelled });
            toast(final.message || `Rebuild ${final.phase}.`, final.phase === 'done' ? 'success' : 'info');
        } catch (err) {
            log.warn(`rebuild failed: ${err?.message || err}`);
            toast(`Rebuild failed: ${err?.message || err}`, 'error');
        } finally {
            setBusy(false);
            if (progressBox && status && status.textContent === '') progressBox.hidden = true;
        }
    });

    const exportBtn = document.getElementById(`${CSS_PREFIX}-settings-export`);
    const importBtn = document.getElementById(`${CSS_PREFIX}-settings-import`);
    const importFile = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-import-file`));
    const autoPersona = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-auto-persona`));

    if (autoPersona) {
        autoPersona.checked = Boolean(getSettings().autoPersonaRebuild);
        autoPersona.addEventListener('change', () => {
            setSettings({ autoPersonaRebuild: autoPersona.checked });
            toast(`Auto persona rebuild ${autoPersona.checked ? 'enabled' : 'disabled'}.`, 'info');
        });
    }

    exportBtn?.addEventListener('click', async () => {
        const chatId = currentChatId();
        if (!chatId) { toast('No chat is open.', 'warning'); return; }
        try {
            const json = await exportMemories(chatId);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            a.href = url;
            a.download = `starmem-${chatId.replace(/[^\w.-]+/g, '_')}-${stamp}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            toast('Memories exported.', 'success');
        } catch (err) {
            log.warn(`export failed: ${err?.message || err}`);
            toast(`Export failed: ${err?.message || err}`, 'error');
        }
    });

    importBtn?.addEventListener('click', () => {
        const chatId = currentChatId();
        if (!chatId) { toast('No chat is open.', 'warning'); return; }
        importFile?.click();
    });

    importFile?.addEventListener('change', async () => {
        const file = importFile.files?.[0];
        importFile.value = ''; // allow re-picking the same file
        if (!file) return;
        const chatId = currentChatId();
        if (!chatId) { toast('No chat is open.', 'warning'); return; }
        if (!globalThis.confirm(`Import "${file.name}"? This REPLACES all STARmem memories of the current chat.`)) return;
        try {
            const json = await file.text();
            const r = await importMemories(chatId, json);
            toast(`Imported ${r.entries} memories (${r.workingBuffer} pending consolidation).`, 'success');
        } catch (err) {
            log.warn(`import failed: ${err?.message || err}`);
            toast(`Import failed: ${err?.message || err}`, 'error');
        }
    });
}

/** Render warnings about missing ST APIs.
 *
 * Signature takes `parent` for symmetry with other helpers (wireInputs,
 * wireActions) even though lookup is by id from document — so the unused
 * name is prefixed with `_` to satisfy lint.
 */
function renderWarnings(_parent) {
    const box = document.getElementById(`${CSS_PREFIX}-settings-warnings`);
    if (!box) return;
    const warnings = [];
    const profiles = getConnectionProfiles();
    if (profiles.length === 0) {
        warnings.push('Connection Manager has no profiles configured—LLM-backed consolidation will fail.');
    }
    box.innerHTML = '';
    for (const w of warnings) {
        const p = document.createElement('p');
        p.className = `${CSS_PREFIX}-settings-warning`;
        p.textContent = w;
        box.appendChild(p);
    }
}
