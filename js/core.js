/* DevOps Dashboard — core helpers + shared namespace.
   Loaded first. Exposes window.DevOps for the rest of the bundle. */

(function () {
  var D = window.DevOps = window.DevOps || {};

  D.state = {
    capturedSnapshotCount: 0,
    tailPaused: false,
    wizardStepIdx: 0,
    shortcutsEnabled: true,
    suppressSpy: false,
    suppressTimer: null
  };

  D.labels = {
    'context-snap': 'Context-Snap',
    'docs-scraper': 'Quick-Docs Scraper',
    'dep-map': 'Dependency Map',
    'log-tail': 'Log-Tail Filter',
    'issue-filler': 'Issue Template Filler',
    'settings': 'Settings',
    'help': 'Help & Shortcuts'
  };

  D.hexToRgba = function (hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(h.substr(0, 2), 16),
        g = parseInt(h.substr(2, 2), 16),
        b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  };

  D.escapeHtml = function (s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Persistence — single source of truth for localStorage access.
  // Always use DevOps.store rather than calling localStorage directly so a
  // future swap to IndexedDB / sync only requires one site.
  D.store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
    },
    del: function (key) {
      try { localStorage.removeItem(key); return true; } catch (e) { return false; }
    },
    keys: function () {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('devops:') === 0) out.push(k);
      }
      return out;
    },
    size: function () {
      var total = 0;
      this.keys().forEach(function (k) { total += (localStorage.getItem(k) || '').length; });
      return total;
    },
    nuke: function () { this.keys().forEach(function (k) { localStorage.removeItem(k); }); }
  };

  // Application version — bump when shipping breaking changes.
  D.version = '1.0.0';
  D.brandName = 'DevOps Local';

  // Lazy toast: created on first call.
  var toastEl = null;
  D.toast = function (msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed; bottom: 24px; left: 50%;' +
        'transform: translateX(-50%) translateY(20px);' +
        'background: var(--bg-card); border: 1px solid var(--border);' +
        'border-radius: var(--radius); padding: 10px 16px; font-size: 13px;' +
        'color: var(--text-primary); box-shadow: var(--shadow-pop);' +
        'z-index: 200; opacity: 0; pointer-events: none;' +
        'transition: opacity 200ms, transform 200ms;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    toastEl.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(D.toast._t);
    D.toast._t = setTimeout(function () {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateX(-50%) translateY(20px)';
    }, 2000);
  };

  D.confirmAction = function (title, body, onConfirm) {
    var existing = document.getElementById('confirmModal');
    if (existing) existing.remove();
    var bd = document.createElement('div');
    bd.id = 'confirmModal';
    bd.className = 'modal-backdrop open';
    bd.innerHTML =
      '<div class="modal" style="max-width: 440px;">' +
        '<div class="modal-header"><div class="modal-title">' + title + '</div>' +
          '<button class="close-btn" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
        '</div>' +
        '<div class="modal-body" style="font-size: 13px; color: var(--text-body); line-height: 1.6;">' + body + '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn" data-c-cancel>Cancel</button>' +
          '<button class="btn btn-primary" data-c-ok style="background: var(--accent-crimson); border-color: var(--accent-crimson);">Confirm</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bd);
    function close() { bd.remove(); }
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    bd.querySelector('.close-btn').addEventListener('click', close);
    bd.querySelector('[data-c-cancel]').addEventListener('click', close);
    bd.querySelector('[data-c-ok]').addEventListener('click', function () { close(); if (onConfirm) onConfirm(); });
  };

  // Bind a click handler to every button inside `scope` whose visible text matches `text`.
  // Each matched button gets data-wired="1" to prevent double-binding and to opt it out of fallback.
  D.bindByText = function (scope, text, handler) {
    var scopeEl = typeof scope === 'string' ? document.querySelector(scope) : scope;
    if (!scopeEl) return;
    scopeEl.querySelectorAll('.btn, .icon-btn, button').forEach(function (b) {
      var t = b.textContent.replace(/\s+/g, ' ').trim();
      if (t === text || t.indexOf(text) === 0) {
        if (b.getAttribute('data-wired') === '1') return;
        b.setAttribute('data-wired', '1');
        b.addEventListener('click', function (e) { handler(b, e); });
      }
    });
  };
})();
