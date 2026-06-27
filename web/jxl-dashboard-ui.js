export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

let helpCloseWired = false;

export function wireSlideoutPanel({
    panel,
    openButton,
    closeButton,
    defaultOpen = false,
} = {}) {
    if (!panel) return { setOpen() {}, isOpen: () => false };

    const setOpen = (open) => {
        const next = Boolean(open);
        panel.dataset.open = next ? 'true' : 'false';
        panel.setAttribute('aria-hidden', next ? 'false' : 'true');
        if (openButton) openButton.setAttribute('aria-expanded', next ? 'true' : 'false');
    };

    openButton?.addEventListener('click', () => {
        setOpen(panel.dataset.open !== 'true');
    });
    closeButton?.addEventListener('click', () => setOpen(false));
    // Per-panel Escape handler: each wired panel closes itself when it is open.
    // (A previous module-global guard meant only the first panel ever responded
    // to Escape.) The open-check keeps this inert for closed panels.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && panel.dataset.open === 'true') setOpen(false);
    });

    setOpen(defaultOpen);
    return {
        setOpen,
        isOpen: () => panel.dataset.open === 'true',
    };
}

export function wireHelpPopovers(root = document) {
    if (!root) return { closeAll() {}, toggle() {} };
    const buttons = [...root.querySelectorAll('[data-help-target]')];
    const popovers = [...root.querySelectorAll('[data-help-popover]')];

    const closeAll = () => {
        for (const popover of popovers) popover.hidden = true;
    };

    const toggle = (targetId) => {
        const popover = root.querySelector(`[data-help-popover="${CSS.escape(targetId)}"]`);
        if (!popover) return;
        const shouldOpen = popover.hidden;
        closeAll();
        popover.hidden = !shouldOpen ? true : false;
    };

    for (const button of buttons) {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            toggle(button.dataset.helpTarget);
        });
    }

    for (const popover of popovers) {
        popover.addEventListener('click', (event) => event.stopPropagation());
    }

    if (!helpCloseWired) {
        document.addEventListener('click', closeAll);
        helpCloseWired = true;
    }
    return { closeAll, toggle };
}

export function setGroupDisabled(group, disabled, reason = '') {
    if (!group) return;
    group.classList.toggle('is-disabled', Boolean(disabled));
    group.setAttribute('aria-disabled', Boolean(disabled) ? 'true' : 'false');
    if (reason) group.dataset.reason = reason;

    const controls = [...group.querySelectorAll('button, input, select, textarea')];
    for (const control of controls) {
        if (control.classList.contains('info-btn') || control.classList.contains('dashboard-toggle') || control.classList.contains('dashboard-close')) {
            continue;
        }
        control.disabled = Boolean(disabled);
    }
}

export function bindRangeLabel(input, label, format = (value) => String(value)) {
    if (!input || !label) return () => {};
    const sync = () => {
        label.textContent = format(input.value);
    };
    input.addEventListener('input', sync);
    sync();
    return sync;
}

export function setCssVar(name, value, root = document.documentElement) {
    root.style.setProperty(name, String(value));
}
