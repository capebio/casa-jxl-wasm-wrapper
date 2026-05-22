// Lightweight pipeline debug console.
// Usage:
//   import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
//   initDebugConsole(document.getElementById('dbg-btn'));
//   dbgLog('▶ encode start', 'rgba 220×180 → jxl');

const entries = [];
let listEl = null;
let countEl = null;
const t0 = performance.now();
let seq = 0;

function ts() {
    return `+${((performance.now() - t0) / 1000).toFixed(3)}s`;
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRow(entry) {
    if (!listEl) return;
    const row = document.createElement('div');
    row.className = 'dbg-row' + (entry.kind ? ` dbg-${entry.kind}` : '');
    row.dataset.seq = entry.seq;
    let html = `<span class="dbg-ts">${esc(entry.ts)}</span><span class="dbg-msg">${esc(entry.text)}</span>`;
    if (entry.detail) {
        html += `<pre class="dbg-detail">${esc(entry.detail)}</pre>`;
    }
    row.innerHTML = html;
    listEl.appendChild(row);
    listEl.scrollTop = listEl.scrollHeight;
}

function updateCount() {
    if (countEl) countEl.textContent = `${entries.length}`;
}

export function dbgLog(text, detail = '', kind = '') {
    const entry = { seq: seq++, ts: ts(), text, detail, kind };
    entries.push(entry);
    renderRow(entry);
    updateCount();
    return entry;
}

export function initDebugConsole(toggleBtn) {
    const panel = document.createElement('div');
    panel.className = 'dbg-panel';
    panel.hidden = true;
    panel.innerHTML = `
        <div class="dbg-bar">
            <span class="dbg-bar-title">Pipeline Console</span>
            <span class="dbg-bar-count"><span id="dbg-entry-count">0</span> entries</span>
            <button class="dbg-bar-action" id="dbg-copy-all" type="button">Copy all</button>
            <button class="dbg-bar-action" id="dbg-clear-btn" type="button">Clear</button>
            <button class="dbg-bar-action dbg-bar-close" id="dbg-close-btn" type="button">✕</button>
        </div>
        <div class="dbg-list" id="dbg-list"></div>
    `;
    document.body.appendChild(panel);
    listEl = panel.querySelector('#dbg-list');
    countEl = panel.querySelector('#dbg-entry-count');

    // Flush any entries logged before init
    for (const e of entries) renderRow(e);
    updateCount();

    let open = false;
    function setOpen(val) {
        open = val;
        panel.hidden = !open;
        toggleBtn.classList.toggle('is-active', open);
        if (open) listEl.scrollTop = listEl.scrollHeight;
    }

    toggleBtn.addEventListener('click', () => setOpen(!open));

    panel.querySelector('#dbg-close-btn').addEventListener('click', () => setOpen(false));

    panel.querySelector('#dbg-clear-btn').addEventListener('click', () => {
        entries.length = 0;
        seq = 0;
        listEl.innerHTML = '';
        updateCount();
    });

    panel.querySelector('#dbg-copy-all').addEventListener('click', () => {
        const text = entries.map(e => `${e.ts} ${e.text}${e.detail ? '\n  ' + e.detail : ''}`).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            const btn = panel.querySelector('#dbg-copy-all');
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1800);
        });
    });
}
