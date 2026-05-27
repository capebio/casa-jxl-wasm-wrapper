// info-popover-init.js — standalone (no ES module imports needed).
// Wire all [data-help-target] buttons to toggle their paired [data-help-popover] panels.
// Safe to include alongside pages that also call wireHelpPopovers() — uses a guard flag.
(function () {
  if (window.__infoPopoverWired) return;
  window.__infoPopoverWired = true;

  function init() {
    var allPopovers = Array.from(document.querySelectorAll('[data-help-popover]'));

    function closeAll() {
      allPopovers.forEach(function (p) { p.hidden = true; });
    }

    document.querySelectorAll('[data-help-target]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.dataset.helpTarget;
        var popover = document.querySelector('[data-help-popover="' + CSS.escape(id) + '"]');
        if (!popover) return;
        var shouldOpen = popover.hidden;
        closeAll();
        popover.hidden = !shouldOpen;
      });
    });

    allPopovers.forEach(function (p) {
      p.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
