// casabio.js — wires the Casabio upload panel to Tauri commands.
//
// All file decoding + JXL encoding happens in Rust (raw-pipeline + libjxl).
// This module only marshals UI state across the Tauri IPC boundary.

(() => {
    const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI__;
    if (!IS_TAURI) return; // pure-browser dev: panel stays inert.

    const invoke = window.__TAURI__.core.invoke;
    const $ = sel => document.querySelector(sel);

    const STORAGE_KEY = "casabio.baseUrl";

    function getBaseUrl() {
        const url = ($("#casabio-base-url").value || "").trim();
        if (!url) throw new Error("Set Casabio base URL first");
        return url;
    }

    function appendQueueItem(name) {
        const li = document.createElement("li");
        li.dataset.name = name;
        li.innerHTML = `<span class="qn"></span><span class="qs"></span>`;
        li.querySelector(".qn").textContent = name;
        $("#casabio-queue").appendChild(li);
        return li;
    }

    function setQueueStatus(li, status, cls) {
        li.querySelector(".qs").textContent = status;
        li.className = cls || "";
    }

    async function refreshExpeditions() {
        const sel = $("#casabio-expedition");
        sel.innerHTML = "";
        try {
            const baseUrl = getBaseUrl();
            const list = await invoke("casabio_list_expeditions", { baseUrl });
            const blank = document.createElement("option");
            blank.value = "";
            blank.textContent = "— none —";
            sel.appendChild(blank);
            for (const exp of list) {
                const opt = document.createElement("option");
                opt.value = String(exp.id);
                opt.textContent = exp.name;
                sel.appendChild(opt);
            }
        } catch (e) {
            alert("Failed to list expeditions: " + e);
        }
    }

    async function uploadFilesByPath(paths) {
        if (!paths || !paths.length) return;
        const baseUrl = getBaseUrl();
        const expSel = $("#casabio-expedition");
        const expeditionId = expSel.value ? Number(expSel.value) : null;
        const hqOverride = $("#casabio-hq-toggle").checked;

        for (const path of paths) {
            const name = path.split(/[\\/]/).pop();
            const li = appendQueueItem(name);
            setQueueStatus(li, "encoding…");
            try {
                const row = await invoke("casabio_upload_file", {
                    baseUrl, expeditionId, filePath: path, hqOverride,
                });
                setQueueStatus(li, `done (id=${row.id})`, "done");
            } catch (e) {
                setQueueStatus(li, "error: " + e, "error");
            }
        }
    }

    async function pickAndUpload() {
        try {
            const paths = await invoke("casabio_pick_files");
            await uploadFilesByPath(paths);
        } catch (e) {
            alert("Pick failed: " + e);
        }
    }

    function showPanel() {
        $("#casabio-panel").hidden = false;
    }
    function hidePanel() {
        $("#casabio-panel").hidden = true;
    }

    window.addEventListener("DOMContentLoaded", () => {
        // Restore last-used base URL.
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) $("#casabio-base-url").value = saved;
        $("#casabio-base-url").addEventListener("change", e => {
            localStorage.setItem(STORAGE_KEY, e.target.value.trim());
        });

        $("#casabio-toggle").addEventListener("click", showPanel);
        $("#casabio-close").addEventListener("click", hidePanel);

        $("#casabio-save-token").addEventListener("click", async () => {
            const token = $("#casabio-token").value;
            if (!token) return;
            try {
                await invoke("casabio_set_token", { token });
                $("#casabio-token").value = "";
                alert("Token saved to keychain.");
            } catch (e) {
                alert("Failed: " + e);
            }
        });

        $("#casabio-clear-token").addEventListener("click", async () => {
            try { await invoke("casabio_clear_token"); alert("Cleared."); }
            catch (e) { alert("Failed: " + e); }
        });

        $("#casabio-refresh-expeditions").addEventListener("click", refreshExpeditions);
        $("#casabio-drop-zone").addEventListener("click", pickAndUpload);
        $("#casabio-drop-zone").addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pickAndUpload();
            }
        });

        // Native drop with full paths (Tauri 2 emits tauri://drag-drop).
        const listen = window.__TAURI__?.event?.listen;
        if (listen) {
            listen("tauri://drag-drop", e => {
                if ($("#casabio-panel").hidden) return;
                const payload = e.payload || {};
                const paths = Array.isArray(payload) ? payload : payload.paths ?? [];
                if (paths.length) uploadFilesByPath(paths);
            });
        }
    });
})();
