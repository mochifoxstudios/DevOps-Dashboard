/* DevOps Dashboard — persistence + first-run cleanup + dynamic chrome.
   Loaded after ui.js, before features.js.

   Responsibilities:
   - Strip every piece of mock data from the design template on first run.
   - Persist and restore: profile, session, workspaces, every Settings control,
     theme / density / accent / monospace font.
   - Render workspace switcher + login recents from saved workspaces.
   - Make Profile modal save form values + avatar to localStorage.
   - Make every Settings control auto-persist via a single delegated handler.
   - Wire About panel for real diagnostics + clear-state nuke.
*/

(function () {
  var D = window.DevOps;
  if (!D || !D.store) { console.error('[DevOps] persist.js needs core.js'); return; }

  var STORE = D.STORE = {
    profile:     'devops:profile',
    session:     'devops:session',
    settings:    'devops:settings',
    workspaces:  'devops:workspaces',
    firstRun:    'devops:initialized'
  };

  var defaults = {
    profile: {
      displayName: '',
      handle: '',
      email: '',
      role: 'developer',
      shell: 'bash',
      twoFA: false,
      avatar: null,           // data URL or null
      host: ''                // free-form host descriptor for sidebar
    },
    session: {
      workspaceId: null,
      signedIn: true,
      keepSignedIn: false,
      lastLoginAt: null
    },
    settings: {},             // per-key, e.g. settings['s-agent:Launch agent at boot'] = true
    workspaces: []            // [{ id, name, path, colorStart, colorEnd, initials, addedAt }]
  };

  // Inject empty-state CSS once.
  (function injectEmptyCSS () {
    var s = document.createElement('style');
    s.textContent =
      '.empty-state { padding: 40px 24px; text-align: center; }' +
      '.empty-state .es-ico { width: 56px; height: 56px; margin: 0 auto 14px; border-radius: 14px; background: var(--bg-elevated); border: 1px solid var(--border); display: grid; place-items: center; color: var(--text-meta); }' +
      '.empty-state .es-title { color: var(--text-primary); font-weight: 500; font-size: 14px; }' +
      '.empty-state .es-sub { color: var(--text-meta); font-size: 12.5px; margin-top: 4px; }' +
      '.empty-state .es-hint { color: var(--text-muted); font-size: 11.5px; margin-top: 10px; font-family: var(--font-mono); letter-spacing: 0.01em; }' +
      '.empty-state .es-actions { margin-top: 16px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }' +
      '.term-empty { color: var(--text-meta); font-family: var(--font-mono); font-size: 12.5px; padding: 18px 24px; line-height: 1.7; }';
    document.head.appendChild(s);
  })();

  // -------- helpers --------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') Object.assign(n.style, attrs[k]);
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function emptyHTML(opts) {
    var icon = opts.icon || '<rect x="3" y="3" width="18" height="18" rx="2"/>';
    var actions = (opts.actions || []).map(function (a) {
      return '<button class="btn ' + (a.primary ? 'btn-primary' : '') + '" data-empty-action="' + a.id + '">' + (a.icon ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + a.icon + '</svg>' : '') + a.label + '</button>';
    }).join('');
    return '<div class="empty-state">' +
      '<div class="es-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg></div>' +
      '<div class="es-title">' + opts.title + '</div>' +
      (opts.sub ? '<div class="es-sub">' + opts.sub + '</div>' : '') +
      (opts.hint ? '<div class="es-hint">' + opts.hint + '</div>' : '') +
      (actions ? '<div class="es-actions">' + actions + '</div>' : '') +
      '</div>';
  }

  function settingsKey(group, label) {
    return 'k:' + (group || '_') + '::' + (label || '_').replace(/\s+/g, ' ').trim();
  }
  function rowLabel(rowItem) {
    var t = rowItem.querySelector('.row-title');
    return t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function controlGroupId(controlEl) {
    var grp = controlEl.closest('.settings-group');
    return grp ? grp.id : '';
  }
  function controlLabel(controlEl) {
    var row = controlEl.closest('.row-item');
    if (row) return rowLabel(row);
    // Some controls live outside row-items (Appearance segs). Use neighboring label.
    var lbl = controlEl.closest('label') || controlEl.previousElementSibling;
    return lbl ? (lbl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) : '';
  }

  // =========================================================
  // Empty-state: strip mock data unless storage already has it
  // =========================================================
  function stripContextSnapMock () {
    var view = document.getElementById('view-context-snap');
    if (!view) return;
    // Stat values → 0/—
    var stats = view.querySelectorAll('.stat-value');
    if (stats[0]) stats[0].textContent = '0';
    if (stats[1]) stats[1].textContent = '—';
    if (stats[2]) stats[2].textContent = '—';
    if (stats[3]) stats[3].textContent = '—';
    // Stat deltas → blank
    view.querySelectorAll('.stat-delta').forEach(function (d) { d.textContent = ''; });

    // Name input + textarea cleared
    view.querySelectorAll('.card-body input[type="text"]').forEach(function (i) { i.value = ''; });
    var ta = view.querySelector('textarea'); if (ta) ta.value = '';

    // Uncheck all but Env + Git (sensible defaults)
    view.querySelectorAll('.check input[type="checkbox"]').forEach(function (cb) {
      var label = cb.closest('.check').querySelector('.check-label');
      var t = label ? label.textContent.trim() : '';
      cb.checked = (t === 'Environment variables' || t.indexOf('Git branch') === 0);
      // Also clear meta counts that look like fake numbers
      var meta = cb.closest('.check').querySelector('.check-meta');
      if (meta && /\d/.test(meta.textContent)) meta.textContent = '';
    });

    // Captured-environment pane → empty state
    var pane = view.querySelector('.code-block');
    if (pane) {
      pane.outerHTML = '<div class="code-block" style="padding: 0; min-height: 320px; display: grid; place-items: center;">' + emptyHTML({
        icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>',
        title: 'No snapshot captured yet',
        sub: 'Snapshots live entirely on this machine. Configure the parameters on the left, then capture.',
        hint: '⌘1 · or palette: Capture snapshot now'
      }) + '</div>';
    }
    // Card meta (timestamp)
    view.querySelectorAll('.card-meta').forEach(function (m) { m.textContent = 'awaiting first capture'; });
  }

  function stripDocsScraperMock () {
    var view = document.getElementById('view-docs-scraper');
    if (!view) return;
    // URL input
    var url = view.querySelector('input[type="text"]'); if (url) url.value = '';
    // Tree → empty
    var tree = view.querySelector('.tree');
    if (tree) tree.innerHTML = '<div class="term-empty">No cached documents yet. Fetch a URL or drop a .md / .txt / .html file.</div>';
    // Markdown view → empty state
    var md = view.querySelector('.markdown-view');
    if (md) {
      md.innerHTML = emptyHTML({
        icon: '<path d="M4 4h10l6 6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M14 4v6h6"/>',
        title: 'No document loaded',
        sub: 'Enter a URL above and click Fetch Document, or drop a local markdown file anywhere on this view.',
        hint: '⌘2 · supports .md · .txt · .html'
      });
    }
    // Card meta
    view.querySelectorAll('.card-meta').forEach(function (m) { m.textContent = ''; });
  }

  function stripDepMapMock () {
    var view = document.getElementById('view-dep-map');
    if (!view) return;
    // Stats → 0
    view.querySelectorAll('.stat-value').forEach(function (s, i) { s.textContent = i === 0 ? '0' : '—'; });
    view.querySelectorAll('.stat-delta').forEach(function (d) { d.textContent = ''; });
    // Filter input → empty
    var filt = view.querySelector('input[placeholder*="Filter packages"]'); if (filt) filt.value = '';
    // Table → empty state
    var tbody = view.querySelector('table.data tbody');
    if (tbody) {
      var cols = view.querySelectorAll('table.data thead th').length || 6;
      tbody.innerHTML = '<tr><td colspan="' + cols + '" style="padding: 0;">' + emptyHTML({
        icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
        title: 'No manifest loaded',
        sub: 'Drop a package.json, requirements.txt, Cargo.toml, go.mod, Gemfile.lock, or Pipfile on the dropzone — or click the dropzone to browse.',
        hint: '⌘3 · supports npm · pip · cargo · go · bundler'
      }) + '</td></tr>';
    }
    var meta = view.querySelector('.card-meta'); if (meta) meta.textContent = 'no manifest';
  }

  function stripLogTailMock () {
    var view = document.getElementById('view-log-tail');
    if (!view) return;
    // Stats → 0
    view.querySelectorAll('.stat-value').forEach(function (s) { s.textContent = '0'; });
    view.querySelectorAll('.stat-delta').forEach(function (d) { d.textContent = ''; });
    // Filter + path
    var filt = view.querySelector('input[placeholder*="Filter"]'); if (filt) filt.value = '';
    var path = view.querySelector('input[placeholder*="path"]'); if (path) path.value = '';
    // Terminal → empty
    var term = view.querySelector('.terminal');
    if (term) {
      term.innerHTML = emptyHTML({
        icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
        title: 'No log file loaded',
        sub: 'Click Load… next to the path field, or drop a .log / .txt file onto this view.',
        hint: '⌘4 · errors and warnings auto-highlighted'
      });
    }
    var pill = view.querySelector('.badge.ok'); if (pill) pill.style.opacity = '0.5';
  }

  function stripIssueFillerMock () {
    var view = document.getElementById('view-issue-filler');
    if (!view) return;
    // Reset wizard to step 0
    D.state.wizardStepIdx = 0;
    var steps = view.querySelectorAll('.wizard-step');
    steps.forEach(function (s, i) {
      s.classList.remove('active', 'done');
      if (i === 0) s.classList.add('active');
      var num = s.querySelector('.num');
      if (num) num.textContent = String(i + 1);
    });
    // Clear all form fields
    view.querySelectorAll('input, textarea').forEach(function (i) { i.value = ''; });
    // Re-render markdown preview (features.js will pick up empty state)
  }

  function applyEmptyStates () {
    // Only strip what's truly empty in storage.
    if (!(D.store.get('devops:snapshots', []) || []).length) stripContextSnapMock();
    if (!(D.store.get('devops:doc-cache', []) || []).length) stripDocsScraperMock();
    if (!localStorage.getItem('devops:active-manifest')) stripDepMapMock();
    // Log + Issue have no persistent data, always empty initially.
    stripLogTailMock();
    // Issue filler form is always cleared unless we have drafts to restore — but we don't auto-restore drafts.
    stripIssueFillerMock();
  }

  // =========================================================
  // Workspace switcher: render from storage, support Add/Remove
  // =========================================================
  function getWorkspaces () { return D.store.get(STORE.workspaces, []); }
  function setWorkspaces (list) { D.store.set(STORE.workspaces, list); }
  function getSession () { return Object.assign({}, defaults.session, D.store.get(STORE.session, {})); }
  function setSession (s) { D.store.set(STORE.session, s); }

  function applyWorkspaceToHeader (ws) {
    var nameEl = document.getElementById('wsName');
    var pathEl = document.getElementById('wsPath');
    var glyph = document.getElementById('wsGlyph');
    if (!nameEl) return;
    if (!ws) {
      nameEl.textContent = 'No workspace';
      pathEl.textContent = 'click to add one';
      if (glyph) {
        glyph.textContent = '+';
        glyph.style.background = 'var(--bg-elevated)';
        glyph.style.color = 'var(--text-meta)';
        glyph.style.border = '1px dashed var(--border-strong)';
      }
    } else {
      nameEl.textContent = ws.name;
      pathEl.textContent = ws.path;
      if (glyph) {
        glyph.textContent = ws.initials || ws.name.slice(0, 2).toUpperCase();
        glyph.style.background = 'linear-gradient(135deg, ' + (ws.colorStart || '#6366f1') + ', ' + (ws.colorEnd || '#8b5cf6') + ')';
        glyph.style.color = '#fff';
        glyph.style.border = '';
      }
    }
  }

  function renderWorkspacePopover () {
    var pop = document.getElementById('workspacePopover');
    if (!pop) return;
    var session = getSession();
    var list = getWorkspaces();
    var rows = '<div class="pop-section-label">Workspaces</div>';
    if (!list.length) {
      rows += '<div style="padding: 14px 12px; font-size: 12px; color: var(--text-meta); text-align: center;">No workspaces yet</div>';
    } else {
      rows += list.map(function (w) {
        var active = w.id === session.workspaceId;
        return '<button class="pop-item' + (active ? ' active' : '') + '" data-ws-id="' + w.id + '">' +
          '<div class="gl" style="background: linear-gradient(135deg, ' + (w.colorStart || '#6366f1') + ', ' + (w.colorEnd || '#8b5cf6') + ');">' + (w.initials || w.name.slice(0, 2).toUpperCase()) + '</div>' +
          '<div style="flex: 1; min-width: 0;"><div>' + D.escapeHtml(w.name) + '</div><div class="pt">' + D.escapeHtml(w.path) + '</div></div>' +
          (active ? '<span class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' : '') +
          '</button>';
      }).join('');
    }
    rows += '<div class="pop-divider"></div>' +
            '<button class="pop-item" data-ws-add>' +
              '<div class="gl" style="background: var(--bg-elevated); border: 1px dashed var(--border-strong); color: var(--text-meta);">+</div>' +
              '<div style="flex: 1; min-width: 0;"><div>Add workspace…</div><div class="pt">point to a local folder</div></div>' +
            '</button>';
    if (list.length) {
      rows += '<button class="pop-item" data-ws-manage>' +
                '<div class="gl" style="background: var(--bg-elevated); color: var(--text-meta);"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></div>' +
                '<div style="flex: 1; min-width: 0;"><div>Manage workspaces…</div><div class="pt">' + list.length + ' saved</div></div>' +
              '</button>';
    }
    pop.innerHTML = rows;

    pop.querySelectorAll('[data-ws-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ws-id');
        switchWorkspace(id);
        pop.classList.remove('open');
      });
    });
    var addBtn = pop.querySelector('[data-ws-add]');
    if (addBtn) addBtn.addEventListener('click', function () {
      pop.classList.remove('open');
      addWorkspaceModal();
    });
    var manageBtn = pop.querySelector('[data-ws-manage]');
    if (manageBtn) manageBtn.addEventListener('click', function () {
      pop.classList.remove('open');
      manageWorkspacesModal();
    });
  }

  function switchWorkspace (id) {
    var list = getWorkspaces();
    var ws = list.find(function (w) { return w.id === id; });
    if (!ws) return;
    var session = getSession();
    session.workspaceId = id;
    setSession(session);
    applyWorkspaceToHeader(ws);
    renderWorkspacePopover();
    renderLoginRecents();
    D.toast('Switched to ' + ws.name);
  }

  function generateId () {
    return 'ws-' + Math.random().toString(36).slice(2, 9);
  }

  function pickGradient () {
    // A small curated palette of gradients to give each workspace a distinct glyph.
    var palettes = [
      ['#6366f1', '#8b5cf6'], ['#10b981', '#059669'], ['#f59e0b', '#ef4444'],
      ['#06b6d4', '#3b82f6'], ['#ec4899', '#a855f7'], ['#f97316', '#dc2626'],
      ['#22c55e', '#0ea5e9'], ['#eab308', '#84cc16']
    ];
    return palettes[Math.floor(Math.random() * palettes.length)];
  }

  function addWorkspaceModal (initial) {
    var bd = document.createElement('div');
    bd.id = 'wsModal';
    bd.className = 'modal-backdrop open';
    var g = pickGradient();
    bd.innerHTML =
      '<div class="modal" style="max-width: 480px;">' +
        '<div class="modal-header"><div class="modal-title">Add workspace</div>' +
          '<button class="close-btn" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="field"><label class="field-label">Workspace name</label>' +
            '<input class="input" data-ws-name placeholder="e.g. payments-gateway" autocomplete="off" /></div>' +
          '<div class="field"><label class="field-label">Local path</label>' +
            '<input class="input" data-ws-path placeholder="~/code/my-project" autocomplete="off" style="font-family: var(--font-mono);" /></div>' +
          '<div class="field-row">' +
            '<div class="field"><label class="field-label">Initials</label>' +
              '<input class="input" data-ws-initials placeholder="PG" maxlength="3" autocomplete="off" style="font-family: var(--font-mono); text-transform: uppercase;" /></div>' +
            '<div class="field"><label class="field-label">Glyph color</label>' +
              '<input class="input" data-ws-color type="color" value="' + g[0] + '" style="padding: 4px; height: 38px;" /></div>' +
          '</div>' +
          '<div class="callout" style="margin: 12px 0 0; padding: 10px 12px; background: rgba(99,102,241,0.06); border: 1px solid rgba(99,102,241,0.2); border-left: 3px solid var(--accent-indigo); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: 12.5px; color: var(--text-body);">Workspaces only exist locally. The path is stored as a string — the real autonomous agent (when bound) reads it to scope its watchers.</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn" data-c-cancel>Cancel</button>' +
          '<button class="btn btn-primary" data-c-ok>Add workspace</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bd);
    var name = bd.querySelector('[data-ws-name]');
    var path = bd.querySelector('[data-ws-path]');
    var initials = bd.querySelector('[data-ws-initials]');
    var color = bd.querySelector('[data-ws-color]');
    name.focus();
    if (initial) {
      if (initial.name) name.value = initial.name;
      if (initial.path) path.value = initial.path;
    }
    function close () { bd.remove(); }
    function submit () {
      var n = name.value.trim();
      var p = path.value.trim();
      if (!n) { name.focus(); D.toast('Name is required'); return; }
      var ws = {
        id: generateId(),
        name: n,
        path: p || '~/' + n,
        initials: (initials.value.trim() || n.slice(0, 2)).toUpperCase().slice(0, 3),
        colorStart: color.value,
        colorEnd: shadeHex(color.value, -22),
        addedAt: new Date().toISOString()
      };
      var list = getWorkspaces();
      list.unshift(ws);
      setWorkspaces(list);
      close();
      switchWorkspace(ws.id);
      D.toast('Added workspace · ' + ws.name);
    }
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    bd.querySelector('.close-btn').addEventListener('click', close);
    bd.querySelector('[data-c-cancel]').addEventListener('click', close);
    bd.querySelector('[data-c-ok]').addEventListener('click', submit);
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    path.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function manageWorkspacesModal () {
    var list = getWorkspaces();
    var bd = document.createElement('div');
    bd.id = 'wsManageModal';
    bd.className = 'modal-backdrop open';
    var rows = list.map(function (w) {
      return '<div class="row-item" data-ws-row="' + w.id + '">' +
        '<div class="ws-glyph" style="background: linear-gradient(135deg, ' + (w.colorStart || '#6366f1') + ', ' + (w.colorEnd || '#8b5cf6') + ');">' + D.escapeHtml(w.initials) + '</div>' +
        '<div class="row-meta">' +
          '<div class="row-title">' + D.escapeHtml(w.name) + '</div>' +
          '<div class="row-sub" style="font-family: var(--font-mono);">' + D.escapeHtml(w.path) + '</div>' +
        '</div>' +
        '<button class="btn" data-ws-remove="' + w.id + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Remove</button>' +
      '</div>';
    }).join('') || '<div style="padding: 24px; color: var(--text-meta); text-align: center;">No workspaces yet.</div>';
    bd.innerHTML =
      '<div class="modal" style="max-width: 520px;">' +
        '<div class="modal-header"><div class="modal-title">Manage workspaces · ' + list.length + '</div>' +
          '<button class="close-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
        '</div>' +
        '<div class="modal-body" style="max-height: 60vh; padding: 0;">' + rows + '</div>' +
        '<div class="modal-footer"><button class="btn" data-c-cancel>Close</button><button class="btn btn-primary" data-c-ok>Add new…</button></div>' +
      '</div>';
    document.body.appendChild(bd);
    function close () { bd.remove(); }
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    bd.querySelector('.close-btn').addEventListener('click', close);
    bd.querySelector('[data-c-cancel]').addEventListener('click', close);
    bd.querySelector('[data-c-ok]').addEventListener('click', function () { close(); addWorkspaceModal(); });
    bd.querySelectorAll('[data-ws-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ws-remove');
        var nextList = getWorkspaces().filter(function (w) { return w.id !== id; });
        setWorkspaces(nextList);
        var session = getSession();
        if (session.workspaceId === id) {
          session.workspaceId = nextList[0] ? nextList[0].id : null;
          setSession(session);
          applyWorkspaceToHeader(nextList[0] || null);
        }
        renderWorkspacePopover();
        renderLoginRecents();
        var row = bd.querySelector('[data-ws-row="' + id + '"]');
        if (row) row.remove();
        D.toast('Workspace removed');
      });
    });
  }

  function shadeHex (hex, percent) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(h, 16);
    var amt = Math.round(2.55 * percent);
    var r = Math.max(0, Math.min(255, (num >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amt));
    var b = Math.max(0, Math.min(255, (num & 0xff) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // =========================================================
  // Login recents — rendered from workspaces, recency by lastOpenedAt
  // =========================================================
  function renderLoginRecents () {
    var recents = document.querySelector('.login-recents');
    if (!recents) return;
    var list = getWorkspaces().slice(0, 4);
    if (!list.length) {
      recents.innerHTML = '<div style="padding: 18px; text-align: center; color: var(--text-meta); font-size: 12.5px; border: 1px dashed var(--border); border-radius: var(--radius-sm);">No saved workspaces. Add one after signing in.</div>';
      return;
    }
    recents.innerHTML = list.map(function (w) {
      return '<button class="login-recent" type="button" data-login data-ws-id="' + w.id + '">' +
        '<div class="gl" style="background: linear-gradient(135deg, ' + (w.colorStart || '#6366f1') + ', ' + (w.colorEnd || '#8b5cf6') + ');">' + D.escapeHtml(w.initials) + '</div>' +
        '<div style="flex: 1; min-width: 0;">' +
          '<div class="nm">' + D.escapeHtml(w.name) + '</div>' +
          '<div class="pt">' + D.escapeHtml(w.path) + '</div>' +
        '</div>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</button>';
    }).join('');
    recents.querySelectorAll('[data-ws-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchWorkspace(btn.getAttribute('data-ws-id'));
        if (D.hideLogin) D.hideLogin();
      });
    });
  }

  // =========================================================
  // Profile: persist form values + avatar
  // =========================================================
  function getProfile () { return Object.assign({}, defaults.profile, D.store.get(STORE.profile, {})); }
  function setProfile (p) { D.store.set(STORE.profile, p); }

  function applyProfileToSidebar () {
    var p = getProfile();
    var avatar = document.querySelector('.sidebar-footer .avatar');
    var name = document.querySelector('.sidebar-footer .user-name');
    var host = document.querySelector('.sidebar-footer .user-host');
    if (!name) return;
    if (!p.displayName && !p.email) {
      name.textContent = 'Sign in to get started';
      if (host) host.textContent = 'click here';
      if (avatar) { avatar.textContent = '?'; avatar.style.background = 'var(--bg-elevated)'; avatar.style.color = 'var(--text-meta)'; }
      return;
    }
    name.textContent = p.handle || p.displayName || (p.email ? p.email.split('@')[0] : 'user');
    if (host) host.textContent = p.host || (p.email || '');
    if (avatar) {
      if (p.avatar) {
        avatar.textContent = '';
        avatar.style.backgroundImage = 'url(' + p.avatar + ')';
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
      } else {
        var initials = (p.displayName || p.email || '??').split(/[\s@]+/).map(function (s) { return s[0]; }).join('').slice(0, 2).toUpperCase();
        avatar.textContent = initials || '??';
        avatar.style.background = 'linear-gradient(135deg, #475569, #1f2937)';
        avatar.style.color = 'var(--text-body)';
        avatar.style.backgroundImage = '';
      }
    }
  }

  function applyProfileToModal () {
    var p = getProfile();
    var modal = document.getElementById('profileModal');
    if (!modal) return;
    var nameInput = modal.querySelector('input[type="text"]');
    var emailInput = modal.querySelector('input[type="email"]');
    var passInput = modal.querySelector('input[type="password"]');
    var selects = modal.querySelectorAll('select');
    var twoFA = modal.querySelector('input[type="checkbox"]');
    var bigAvatar = modal.querySelector('.avatar-lg');
    if (nameInput) nameInput.value = p.displayName || '';
    if (emailInput) emailInput.value = p.email || '';
    if (passInput) passInput.value = '';
    if (selects[0]) selects[0].value = p.role || 'developer';
    if (selects[1]) selects[1].value = p.shell || 'bash';
    if (twoFA) twoFA.checked = !!p.twoFA;
    if (bigAvatar) {
      if (p.avatar) {
        bigAvatar.textContent = '';
        bigAvatar.style.backgroundImage = 'url(' + p.avatar + ')';
        bigAvatar.style.backgroundSize = 'cover';
        bigAvatar.style.backgroundPosition = 'center';
      } else {
        var initials = (p.displayName || p.email || '??').split(/[\s@]+/).map(function (s) { return s[0]; }).join('').slice(0, 2).toUpperCase();
        bigAvatar.textContent = initials || '??';
        bigAvatar.style.backgroundImage = '';
        bigAvatar.style.background = 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)';
      }
    }
  }

  function wireProfileSave () {
    var modal = document.getElementById('profileModal');
    if (!modal) return;
    var saveBtn = modal.querySelector('.modal-footer .btn-primary');
    if (!saveBtn) return;

    // Capture all prior listeners by cloning. Then re-attach close-on-data-close.
    var fresh = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(fresh, saveBtn);
    fresh.addEventListener('click', function () {
      var p = getProfile();
      var nameInput = modal.querySelector('input[type="text"]');
      var emailInput = modal.querySelector('input[type="email"]');
      var selects = modal.querySelectorAll('select');
      var twoFA = modal.querySelector('input[type="checkbox"]');
      p.displayName = nameInput ? nameInput.value.trim() : '';
      p.email = emailInput ? emailInput.value.trim() : '';
      p.role = selects[0] ? selects[0].value : 'developer';
      p.shell = selects[1] ? selects[1].value : 'bash';
      p.twoFA = twoFA ? !!twoFA.checked : false;
      // Derive handle from email or name
      p.handle = p.displayName
        ? p.displayName.split(/\s+/).slice(0, 2).join(' ').toLowerCase().replace(/\s+/, '.')
        : (p.email ? p.email.split('@')[0] : '');
      p.host = p.email || p.host || 'local';
      setProfile(p);
      applyProfileToSidebar();
      if (D.closeProfile) D.closeProfile();
      D.toast('Profile saved');
    });

    // Avatar upload — hijack the "Upload photo" button
    var uploadBtn = null;
    modal.querySelectorAll('.btn').forEach(function (b) {
      if (b.textContent.trim().indexOf('Upload photo') === 0) uploadBtn = b;
    });
    if (uploadBtn) {
      uploadBtn.setAttribute('data-wired', '1');
      uploadBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var f = input.files && input.files[0];
          input.remove();
          if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            var p = getProfile();
            p.avatar = fr.result;
            setProfile(p);
            applyProfileToModal();
            applyProfileToSidebar();
            D.toast('Avatar updated');
          };
          fr.readAsDataURL(f);
        });
        input.click();
      });
    }

    // Remove avatar
    var removeBtn = null;
    modal.querySelectorAll('.btn').forEach(function (b) {
      if (b.textContent.trim() === 'Remove') removeBtn = b;
    });
    if (removeBtn) {
      removeBtn.setAttribute('data-wired', '1');
      removeBtn.addEventListener('click', function () {
        var p = getProfile();
        p.avatar = null;
        setProfile(p);
        applyProfileToModal();
        applyProfileToSidebar();
        D.toast('Avatar cleared');
      });
    }

    // Open profile triggers a fresh form load.
    var origOpen = D.openProfile;
    D.openProfile = function () {
      applyProfileToModal();
      if (origOpen) origOpen();
    };
  }

  // =========================================================
  // Settings: blanket persistence for every form control
  // =========================================================
  function readControl (el) {
    if (el.type === 'checkbox' || el.type === 'radio') return !!el.checked;
    if (el.type === 'range' || el.type === 'number') return Number(el.value);
    return el.value;
  }
  function applyControl (el, val) {
    if (val === undefined || val === null) return;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!val;
    else if (el.type === 'range') {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    else el.value = val;
  }

  function persistSettingsControls () {
    var view = document.getElementById('view-settings');
    if (!view) return;
    var saved = D.store.get(STORE.settings, {});
    view.querySelectorAll('input, select, textarea').forEach(function (ctrl) {
      // Skip the search/find inputs that aren't settings (none currently but defensive)
      if (ctrl.closest('.settings-rail')) return;
      var grp = controlGroupId(ctrl);
      var lbl = controlLabel(ctrl);
      // Use position-based fallback if no label
      if (!lbl) {
        var siblings = Array.prototype.slice.call(ctrl.closest('.settings-group').querySelectorAll('input, select, textarea'));
        lbl = '#' + siblings.indexOf(ctrl);
      }
      var key = settingsKey(grp, lbl);
      ctrl.setAttribute('data-pkey', key);
      // Restore
      if (saved[key] !== undefined) applyControl(ctrl, saved[key]);
      // Save on change
      var ev = (ctrl.type === 'range' || ctrl.tagName.toLowerCase() === 'input' && (ctrl.type === 'text' || ctrl.type === 'password' || ctrl.type === 'number' || ctrl.type === '')) ? 'input' : 'change';
      ctrl.addEventListener(ev, function () {
        var s = D.store.get(STORE.settings, {});
        s[key] = readControl(ctrl);
        D.store.set(STORE.settings, s);
      });
    });

    // Also persist seg-btn groups (theme, density, leader-key) by tracking active.
    view.querySelectorAll('.seg').forEach(function (seg) {
      var grp = seg.closest('.settings-group');
      if (!grp) return;
      var row = seg.closest('.row-item');
      var lbl = row ? rowLabel(row) : '';
      var key = settingsKey(grp.id, lbl || 'seg');
      seg.setAttribute('data-pkey', key);
      var saved2 = D.store.get(STORE.settings, {});
      if (saved2[key]) {
        var match = null;
        seg.querySelectorAll('.seg-btn').forEach(function (b) {
          if (b.textContent.trim().toLowerCase() === String(saved2[key]).toLowerCase()) match = b;
        });
        if (match) {
          seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.remove('active'); });
          match.classList.add('active');
          // Re-trigger handler so the effect (theme class, density class) applies
          match.dispatchEvent(new Event('click', { bubbles: true }));
        }
      }
      seg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var s = D.store.get(STORE.settings, {});
          s[key] = b.textContent.trim();
          D.store.set(STORE.settings, s);
        });
      });
    });
  }

  // =========================================================
  // Appearance restoration: theme, density, accent, mono
  // =========================================================
  function applyAppearanceFromStore () {
    var s = D.store.get(STORE.settings, {});
    // Theme key auto-saved via seg persistence; we double-check by class on body.
    // Density same path.
    // Accent — store under devops:accent for backward compat.
    var accent = D.store.get('devops:accent', null);
    if (accent) {
      document.documentElement.style.setProperty('--accent-indigo', accent);
      document.documentElement.style.setProperty('--accent-indigo-soft', D.hexToRgba(accent, 0.12));
      document.documentElement.style.setProperty('--accent-indigo-ring', D.hexToRgba(accent, 0.35));
    }
    var mono = D.store.get('devops:mono', null);
    if (mono) {
      document.documentElement.style.setProperty('--font-mono', '"' + mono + '", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace');
      var sel = document.querySelector('#s-appearance select');
      if (sel) {
        var match = [...sel.options].find(function (o) { return o.value === mono; });
        if (match) sel.value = mono;
      }
    }
  }

  function wireAppearancePersist () {
    var picker = document.getElementById('accentPicker');
    if (picker) {
      picker.querySelectorAll('[data-accent]').forEach(function (sw) {
        sw.addEventListener('click', function () {
          D.store.set('devops:accent', sw.getAttribute('data-accent'));
        });
      });
    }
    var sel = document.querySelector('#s-appearance select');
    if (sel) sel.addEventListener('change', function () { D.store.set('devops:mono', sel.value); });
  }

  // =========================================================
  // About panel — real diagnostics, version, nuke option
  // =========================================================
  function wireAboutPanel () {
    var about = document.getElementById('s-about');
    if (!about) return;
    // Update version pills if present
    about.querySelectorAll('.row-sub, .row-title, code, .ic').forEach(function (n) {
      if (/0\.\d+\.\d+/.test(n.textContent)) n.textContent = n.textContent.replace(/0\.\d+\.\d+/, D.version);
    });
    // "Copy diagnostics" → real diagnostics
    about.querySelectorAll('.btn').forEach(function (b) {
      var t = b.textContent.replace(/\s+/g, ' ').trim();
      if (t === 'Copy diagnostics' || t === 'Copy diagnostics →') {
        b.setAttribute('data-wired', '1');
        b.addEventListener('click', function () {
          var diag = buildDiagnostics();
          if (navigator.clipboard) {
            navigator.clipboard.writeText(diag).then(function () { D.toast('Diagnostics copied · ' + diag.length + ' chars'); },
              function () { downloadDiag(diag); });
          } else { downloadDiag(diag); }
        });
      }
    });
  }

  function buildDiagnostics () {
    var sess = getSession();
    var p = getProfile();
    var workspaces = getWorkspaces();
    var lines = [
      D.brandName + ' · diagnostics',
      'version: ' + D.version,
      'generated: ' + new Date().toISOString(),
      '',
      '## Runtime',
      'userAgent: ' + navigator.userAgent,
      'platform: ' + (navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform),
      'language: ' + navigator.language,
      'cores: ' + (navigator.hardwareConcurrency || 'n/a'),
      'memory: ' + (navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'n/a'),
      'online: ' + navigator.onLine,
      '',
      '## Session',
      'workspaceId: ' + (sess.workspaceId || 'none'),
      'signedIn: ' + sess.signedIn,
      'keepSignedIn: ' + sess.keepSignedIn,
      '',
      '## Profile',
      'handle: ' + (p.handle || '(unset)'),
      'email: ' + (p.email || '(unset)'),
      'role: ' + p.role,
      'shell: ' + p.shell,
      'twoFA: ' + p.twoFA,
      'hasAvatar: ' + !!p.avatar,
      '',
      '## Storage',
      'devopsKeys: ' + D.store.keys().length,
      'devopsSize: ' + D.store.size() + ' chars',
      'workspaces: ' + workspaces.length,
      'snapshots: ' + (D.store.get('devops:snapshots', []) || []).length,
      'docCache: ' + (D.store.get('devops:doc-cache', []) || []).length,
      'manifestLoaded: ' + (!!localStorage.getItem('devops:active-manifest')),
      'issueDrafts: ' + (D.store.get('devops:issue-drafts', []) || []).length,
      '',
      '## Active appearance',
      'theme: ' + (document.body.classList.contains('theme-light') ? 'light' : 'dark'),
      'density: ' + ((document.body.className.match(/density-(\w+)/) || [])[1] || 'cozy'),
      'accent: ' + getComputedStyle(document.documentElement).getPropertyValue('--accent-indigo').trim()
    ];
    return lines.join('\n');
  }

  function downloadDiag (text) {
    var blob = new Blob([text], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'devops-diagnostics-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    D.toast('Diagnostics downloaded');
  }

  // =========================================================
  // Settings → Erase override (uses real D.store.nuke after confirm)
  // =========================================================
  function wireErase () {
    var settings = document.getElementById('view-settings');
    if (!settings) return;
    settings.querySelectorAll('.btn').forEach(function (b) {
      var t = b.textContent.replace(/\s+/g, ' ').trim();
      if (t === 'Erase…' || t === 'Erase' || t.indexOf('Erase…') === 0) {
        b.setAttribute('data-wired', '1');
        // Clone to drop prior listeners (features.js does NOT touch this button; tools.js does).
        var clone = b.cloneNode(true);
        b.parentNode.replaceChild(clone, b);
        clone.setAttribute('data-wired', '1');
        clone.addEventListener('click', function () {
          D.confirmAction(
            'Erase all local data?',
            'This permanently deletes every snapshot, cached doc, manifest, draft, profile, workspace, and setting from this browser\'s storage. <br><br><strong>Total: ' + D.store.size() + ' chars across ' + D.store.keys().length + ' keys.</strong><br><br><span style="color:#fca5a5;">This cannot be undone.</span>',
            function () {
              D.store.nuke();
              D.toast('All local data erased · reloading…');
              setTimeout(function () { location.reload(); }, 800);
            }
          );
        });
      }
    });
  }

  // =========================================================
  // Login: remember sign-in state
  // =========================================================
  function wireLoginPersistence () {
    var form = document.getElementById('loginForm');
    if (!form) return;
    var keepCheck = form.querySelector('input[type="checkbox"]');
    var emailInput = form.querySelector('input[type="text"], input[type="email"]');

    form.addEventListener('submit', function () {
      var sess = getSession();
      sess.signedIn = true;
      sess.keepSignedIn = keepCheck ? !!keepCheck.checked : false;
      sess.lastLoginAt = new Date().toISOString();
      setSession(sess);
      // Optionally update profile email from the login field
      if (emailInput && emailInput.value.trim()) {
        var p = getProfile();
        if (!p.email) {
          p.email = emailInput.value.trim();
          if (!p.handle) p.handle = p.email.split('@')[0];
          setProfile(p);
          applyProfileToSidebar();
        }
      }
    });

    var signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', function () {
        var sess = getSession();
        sess.signedIn = false;
        setSession(sess);
      });
    }
  }

  // =========================================================
  // Bootstrap
  // =========================================================
  function init () {
    var firstRun = !D.store.get(STORE.firstRun, false);
    if (firstRun) {
      D.store.set(STORE.firstRun, true);
      // Clean state for first-time install
      D.store.set(STORE.workspaces, []);
      D.store.set(STORE.session, defaults.session);
      D.store.set(STORE.profile, defaults.profile);
    }

    // Empty-state cleanup for views with no data.
    applyEmptyStates();

    // Render workspace switcher + login recents from saved workspaces.
    renderWorkspacePopover();
    renderLoginRecents();
    var sess = getSession();
    var list = getWorkspaces();
    var activeWs = sess.workspaceId ? list.find(function (w) { return w.id === sess.workspaceId; }) : list[0] || null;
    if (activeWs && !sess.workspaceId) {
      sess.workspaceId = activeWs.id;
      setSession(sess);
    }
    applyWorkspaceToHeader(activeWs);

    // Apply persisted profile + wire Save.
    applyProfileToSidebar();
    wireProfileSave();

    // Settings persistence — must run AFTER ui.js has wired the seg-btns.
    persistSettingsControls();

    // Appearance restore (accent, mono) — theme/density are persisted via seg auto-trigger.
    applyAppearanceFromStore();
    wireAppearancePersist();

    // About panel + Erase.
    wireAboutPanel();
    wireErase();

    // Login persistence.
    wireLoginPersistence();

    // If first run and no workspaces, open the Add Workspace flow once user
    // clicks the empty workspace pill. (We don't auto-open the modal because
    // it would be intrusive on initial render.)
  }

  // Expose pieces for testing.
  D.persist = {
    getProfile: getProfile, setProfile: setProfile,
    getWorkspaces: getWorkspaces, addWorkspaceModal: addWorkspaceModal,
    manageWorkspacesModal: manageWorkspacesModal,
    applyEmptyStates: applyEmptyStates,
    buildDiagnostics: buildDiagnostics,
    renderWorkspacePopover: renderWorkspacePopover,
    renderLoginRecents: renderLoginRecents,
    switchWorkspace: switchWorkspace
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
