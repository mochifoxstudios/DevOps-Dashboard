/* DevOps Dashboard — REAL developer-feature engines.
   Loaded after ui.js, before tools.js. Each tool gets a working implementation
   that processes real files and persists state to localStorage.

   Activation methods (per feature):
     Context-Snap   — click "Capture context", "Restore snapshot", "Export"
     Docs Scraper   — click "Fetch Document" (URL fetch) OR drop a .md / .txt / .html file
     Dep Map        — drop a manifest on the dropzone, click it to pick, or click "Re-scan"
     Log-Tail       — click "Load…" next to the log path, drop a .log / .txt file, click "Pause/Resume"
     Issue Filler   — type into the form for a live markdown preview, then "Copy" or "File issue"
*/

(function () {
  var D = window.DevOps;
  if (!D) { console.error('[DevOps] features.js needs core.js + ui.js'); return; }

  D.features = D.features || {};
  var STORE_KEY = {
    snapshots: 'devops:snapshots',
    docCache:  'devops:doc-cache',
    issueDrafts: 'devops:issue-drafts',
    activeManifest: 'devops:active-manifest'
  };

  // ------- Tiny localStorage helpers -------
  function loadList(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
  }
  function saveList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
  }
  function downloadFile(name, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  }
  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        input.remove();
        resolve(f || null);
      });
      input.click();
    });
  }
  function wireDropTarget(el, accept, onFile) {
    if (!el) return;
    ['dragenter', 'dragover'].forEach(function (e) {
      el.addEventListener(e, function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        el.classList.add('drag-over');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach(function (e) {
      el.addEventListener(e, function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        el.classList.remove('drag-over');
      });
    });
    el.addEventListener('drop', function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files[0]) onFile(files[0]);
    });
  }

  // Drag-over visual hint, injected once.
  var styleTag = document.createElement('style');
  styleTag.textContent =
    '.drag-over { outline: 2px dashed var(--accent-indigo) !important; outline-offset: 2px; background: var(--accent-indigo-soft) !important; }' +
    '.feature-active-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; background: var(--accent-emerald-soft); border: 1px solid rgba(16,185,129,0.3); color: #6ee7b7; }' +
    '.feature-active-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-emerald); }';
  document.head.appendChild(styleTag);

  // Find a button by visible text and claim it (set data-wired so tools.js skips it).
  function claim(scope, text, handler) {
    var scopeEl = typeof scope === 'string' ? document.querySelector(scope) : scope;
    if (!scopeEl) return null;
    var match = null;
    scopeEl.querySelectorAll('.btn, .icon-btn, button').forEach(function (b) {
      if (match) return;
      var t = b.textContent.replace(/\s+/g, ' ').trim();
      if (t === text || t.indexOf(text) === 0) match = b;
    });
    if (!match) return null;
    match.setAttribute('data-wired', '1');
    match.addEventListener('click', function (e) { handler(match, e); });
    return match;
  }

  // ===================================================================
  // 1) Context-Snap — real capture / restore / export with localStorage
  // ===================================================================
  D.features.contextSnap = (function () {
    var view = document.getElementById('view-context-snap');
    if (!view) return null;

    function gatherIncludes() {
      var includes = {};
      view.querySelectorAll('.check').forEach(function (c) {
        var label = c.querySelector('.check-label');
        var meta = c.querySelector('.check-meta');
        var input = c.querySelector('input[type="checkbox"]');
        if (!label) return;
        includes[label.textContent.trim()] = {
          checked: input ? input.checked : true,
          meta: meta ? meta.textContent.trim() : ''
        };
      });
      return includes;
    }

    function getFormState() {
      var nameInput = view.querySelector('.card-body input[type="text"]');
      var branchInput = view.querySelectorAll('.card-body input[type="text"]')[1];
      var workspaceInput = view.querySelectorAll('.card-body input[type="text"]')[2];
      var noteArea = view.querySelector('textarea');
      var stats = view.querySelectorAll('.stat-value');
      return {
        name: nameInput && nameInput.value ? nameInput.value.trim() : '',
        branch: (branchInput && branchInput.value) || (stats[3] ? stats[3].textContent.trim() : 'main'),
        workspace: (workspaceInput && workspaceInput.value) || (document.getElementById('wsName') ? document.getElementById('wsName').textContent : 'unknown'),
        notes: noteArea ? noteArea.value : '',
        envCount: stats[1] ? parseInt(stats[1].textContent, 10) || 37 : 37,
        pidCount: stats[2] ? parseInt(stats[2].textContent, 10) || 6 : 6
      };
    }

    function buildSnapshot() {
      var includes = gatherIncludes();
      var form = getFormState();
      var seq = D.state.capturedSnapshotCount + 1;
      var name = form.name || ('snapshot-' + String(seq).padStart(2, '0'));
      return {
        id: 'snap-' + Date.now(),
        seq: seq,
        name: name,
        timestamp: new Date().toISOString(),
        workspace: form.workspace,
        branch: form.branch,
        notes: form.notes,
        includes: includes,
        // synthesized environment scaffold — real backend would fill these
        capture: {
          env: includes['Environment variables'] && includes['Environment variables'].checked
            ? { count: form.envCount, sample: ['NODE_ENV=development', 'DATABASE_URL=postgres://localhost:5432/payments_dev', 'REDIS_URL=redis://127.0.0.1:6379/0'] }
            : null,
          pids: includes['Active processes (PIDs)'] && includes['Active processes (PIDs)'].checked
            ? { count: form.pidCount, sample: [{ pid: 48211, cmd: 'node ./bin/api.js' }, { pid: 48235, cmd: 'postgres -D ./data' }, { pid: 48243, cmd: 'redis-server' }] }
            : null,
          git: includes['Git branch & commit SHA'] && includes['Git branch & commit SHA'].checked
            ? { branch: form.branch, sha: 'a' + Math.random().toString(16).slice(2, 9) + '0' }
            : null,
          ports: includes['Open network ports'] && includes['Open network ports'].checked
            ? [3000, 5432, 6379]
            : null,
          diff: includes['Working tree diff'] && includes['Working tree diff'].checked
            ? { modified: 7, staged: 2, untracked: 1 }
            : null
        }
      };
    }

    function renderToCapturedPane(snap) {
      var pane = view.querySelector('.code-block');
      if (!pane) return;
      function esc(s) { return D.escapeHtml(String(s)); }
      var lines = [];
      lines.push('<span class="code-comment"># context-snap · ' + esc(snap.name) + ' · captured ' + esc(new Date(snap.timestamp).toLocaleString()) + '</span>');
      lines.push('<span class="code-meta">@ branch</span> <span class="code-string">"' + esc(snap.capture.git ? snap.capture.git.branch : snap.branch) + '"</span> <span class="code-meta">@ commit</span> <span class="code-string">"' + esc(snap.capture.git ? snap.capture.git.sha : '—') + '"</span>');
      if (snap.capture.env) {
        lines.push('');
        lines.push('<span class="code-key">env</span> · <span class="code-num">' + snap.capture.env.count + '</span> vars');
        snap.capture.env.sample.forEach(function (kv) {
          var eq = kv.indexOf('=');
          if (eq > 0) lines.push('  <span class="code-key">' + esc(kv.slice(0, eq)) + '</span><span class="code-meta">=</span><span class="code-string">"' + esc(kv.slice(eq + 1)) + '"</span>');
          else lines.push('  ' + esc(kv));
        });
      }
      if (snap.capture.pids) {
        lines.push('');
        lines.push('<span class="code-key">processes</span> · <span class="code-num">' + snap.capture.pids.count + '</span> running');
        snap.capture.pids.sample.forEach(function (p) {
          lines.push('  <span class="code-num">PID ' + p.pid + '</span>  <span class="code-string">' + esc(p.cmd) + '</span>');
        });
      }
      if (snap.capture.ports) {
        lines.push('');
        lines.push('<span class="code-key">ports</span> · ' + snap.capture.ports.map(function (p) { return '<span class="code-num">' + p + '</span>'; }).join(', '));
      }
      if (snap.capture.diff) {
        lines.push('');
        lines.push('<span class="code-key">tree-diff</span> · <span class="code-num">' + snap.capture.diff.modified + '</span> modified · <span class="code-num">' + snap.capture.diff.staged + '</span> staged · <span class="code-num">' + snap.capture.diff.untracked + '</span> untracked');
      }
      if (snap.notes) {
        lines.push('');
        lines.push('<span class="code-comment"># ' + esc(snap.notes) + '</span>');
      }
      pane.innerHTML = lines.join('\n');

      var meta = view.querySelector('.card-meta');
      if (meta) meta.textContent = 'snapshot · ' + snap.name + ' · just now';
    }

    // Merge a live agent payload into a buildSnapshot() shell. The shell still
    // owns id / seq / name / includes — we only replace `capture.*` with real
    // host data when the backend is reachable.
    function mergeLiveCapture(shell, live) {
      if (!live) return shell;
      shell.source = 'agent';
      shell.host = live.host || shell.host;
      shell.platform = live.platform || shell.platform;
      shell.workspace = live.workspaceName || shell.workspace;
      var cap = shell.capture;
      if (live.env && shell.includes['Environment variables'] && shell.includes['Environment variables'].checked) {
        cap.env = {
          count: live.env.count,
          redactedCount: live.env.redactedCount,
          sample: live.env.sample
        };
      }
      if (live.processes && shell.includes['Active processes (PIDs)'] && shell.includes['Active processes (PIDs)'].checked) {
        cap.pids = {
          count: live.processes.count,
          sample: live.processes.sample.slice(0, 10)
        };
      }
      if (live.git && shell.includes['Git branch & commit SHA'] && shell.includes['Git branch & commit SHA'].checked) {
        cap.git = {
          branch: live.git.branch || shell.branch,
          sha: live.git.shortSha || live.git.sha || '—',
          dirty: live.git.dirty,
          dirtyFiles: live.git.dirtyFiles,
          remote: live.git.remote
        };
      }
      if (live.ports && shell.includes['Open network ports'] && shell.includes['Open network ports'].checked) {
        cap.ports = live.ports.sample.slice(0, 20);
      }
      return shell;
    }

    function persistSnapshot(snap) {
      var list = loadList(STORE_KEY.snapshots);
      list.unshift(snap);
      if (list.length > 50) list.length = 50;
      saveList(STORE_KEY.snapshots, list);
      D.state.capturedSnapshotCount = snap.seq;
      var stat = view.querySelector('.stats .stat-value');
      if (stat) stat.textContent = D.state.capturedSnapshotCount;
      renderToCapturedPane(snap);
      var src = snap.source === 'agent' ? 'live' : 'local';
      D.toast('Captured · ' + snap.name + ' (' + list.length + ' on disk · ' + src + ')');
      return snap;
    }

    function capture() {
      var shell = buildSnapshot();
      shell.source = 'local';
      // If the agent is online, replace the synthesized capture with real host data.
      if (D.agent && D.agent.online) {
        var flags = {
          env:       !!(shell.includes['Environment variables'] && shell.includes['Environment variables'].checked),
          processes: !!(shell.includes['Active processes (PIDs)'] && shell.includes['Active processes (PIDs)'].checked),
          git:       !!(shell.includes['Git branch & commit SHA'] && shell.includes['Git branch & commit SHA'].checked),
          ports:     !!(shell.includes['Open network ports'] && shell.includes['Open network ports'].checked)
        };
        D.agent.captureSnapshot(flags).then(function (live) {
          persistSnapshot(mergeLiveCapture(shell, live));
        }).catch(function (err) {
          // Agent went away mid-call — keep the local shell and warn.
          D.toast('Agent error: ' + err.message + ' · saved local snapshot');
          persistSnapshot(shell);
        });
        return shell;
      }
      return persistSnapshot(shell);
    }

    function restoreModal() {
      var list = loadList(STORE_KEY.snapshots);
      if (!list.length) { D.toast('No snapshots yet — capture one first'); return; }
      var rows = list.map(function (s) {
        var ts = new Date(s.timestamp);
        var when = ts.toLocaleString();
        return '<button class="login-recent" data-snap-id="' + s.id + '" style="margin-bottom: 4px;">' +
          '<div class="gl" style="background: linear-gradient(135deg,#10b981,#059669);">' + (s.seq || '?') + '</div>' +
          '<div style="flex:1; min-width: 0;">' +
            '<div class="nm">' + D.escapeHtml(s.name) + '</div>' +
            '<div class="pt">' + D.escapeHtml(s.workspace) + ' · ' + D.escapeHtml(s.branch) + ' · ' + D.escapeHtml(when) + '</div>' +
          '</div>' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
          '</button>';
      }).join('');

      var bd = document.createElement('div');
      bd.id = 'snapshotsModal';
      bd.className = 'modal-backdrop open';
      bd.innerHTML =
        '<div class="modal" style="max-width: 540px;">' +
          '<div class="modal-header"><div class="modal-title">Restore snapshot · ' + list.length + ' saved</div>' +
            '<button class="close-btn" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
          '</div>' +
          '<div class="modal-body" style="max-height: 60vh;">' + rows + '</div>' +
          '<div class="modal-footer"><button class="btn" data-clear-snaps>Clear all</button><button class="btn" data-c-cancel>Close</button></div>' +
        '</div>';
      document.body.appendChild(bd);
      function close() { bd.remove(); }
      bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
      bd.querySelector('.close-btn').addEventListener('click', close);
      bd.querySelector('[data-c-cancel]').addEventListener('click', close);
      bd.querySelector('[data-clear-snaps]').addEventListener('click', function () {
        saveList(STORE_KEY.snapshots, []);
        D.state.capturedSnapshotCount = 0;
        var stat = view.querySelector('.stats .stat-value');
        if (stat) stat.textContent = 0;
        close();
        D.toast('Cleared all snapshots');
      });
      bd.querySelectorAll('[data-snap-id]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-snap-id');
          var snap = list.find(function (s) { return s.id === id; });
          if (!snap) return;
          renderToCapturedPane(snap);
          var nameInput = view.querySelector('.card-body input[type="text"]');
          if (nameInput) nameInput.value = snap.name;
          var noteArea = view.querySelector('textarea');
          if (noteArea && snap.notes) noteArea.value = snap.notes;
          close();
          D.toast('Restored · ' + snap.name);
        });
      });
    }

    function exportCurrent() {
      var list = loadList(STORE_KEY.snapshots);
      var snap = list[0];
      if (!snap) {
        D.toast('No snapshot to export — capture one first');
        return;
      }
      downloadFile(snap.name + '.snap.json', 'application/json', JSON.stringify(snap, null, 2));
      D.toast('Exported · ' + snap.name + '.snap.json');
    }

    // Hydrate snapshot count on load
    var existing = loadList(STORE_KEY.snapshots);
    if (existing.length) {
      D.state.capturedSnapshotCount = existing[0].seq || existing.length;
      var stat = view.querySelector('.stats .stat-value');
      if (stat) stat.textContent = D.state.capturedSnapshotCount;
      renderToCapturedPane(existing[0]);
    }

    // Drag-drop a previously-exported snapshot to restore it
    wireDropTarget(view, '.snap.json,.json', function (file) {
      readFile(file).then(function (txt) {
        try {
          var snap = JSON.parse(txt);
          if (!snap || !snap.capture) throw new Error('not a snapshot file');
          var list = loadList(STORE_KEY.snapshots);
          list.unshift(snap);
          saveList(STORE_KEY.snapshots, list);
          renderToCapturedPane(snap);
          D.toast('Imported · ' + (snap.name || file.name));
        } catch (e) {
          D.toast('Not a valid .snap.json file');
        }
      });
    });

    claim('#view-context-snap', 'Capture context', capture);
    claim('#view-context-snap', 'Snapshot now', capture);
    claim('#view-context-snap', 'Restore snapshot', restoreModal);
    claim('#view-context-snap', 'Export', exportCurrent);

    return { capture: capture, restoreModal: restoreModal, exportCurrent: exportCurrent };
  })();

  // Phase 5: Context-Snap "Compare" button + diff modal (structured + optional AI narration).
  (function snapshotCompare() {
    var view = document.getElementById('view-context-snap');
    if (!view) return;
    var actions = view.querySelector('.view-actions');
    if (!actions || actions.querySelector('[data-snap-compare]')) return;
    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.setAttribute('data-snap-compare', '1');
    btn.textContent = 'Compare';
    actions.appendChild(btn);
    btn.addEventListener('click', openCompareModal);

    function openCompareModal() {
      var snaps = D.store.get('devops:snapshots', []);
      if (snaps.length < 2) { D.toast('Need at least 2 snapshots to compare'); return; }
      var bd = document.createElement('div');
      bd.className = 'modal-backdrop open'; bd.id = 'snapCompareModal';
      bd.innerHTML =
        '<div class="modal" style="max-width:680px;">' +
          '<div class="modal-header"><div class="modal-title">Compare snapshots</div>' +
            '<button class="close-btn" data-close>×</button></div>' +
          '<div class="modal-body">' +
            '<div class="field-row">' +
              '<div class="field"><label class="field-label">A (older)</label>' +
                '<select class="select" data-snap-a>' +
                  snaps.map(function (s) { return '<option value="' + D.escapeHtml(s.id) + '">' + D.escapeHtml(s.name) + ' (' + new Date(s.timestamp).toLocaleString() + ')</option>'; }).join('') +
                '</select></div>' +
              '<div class="field"><label class="field-label">B (newer)</label>' +
                '<select class="select" data-snap-b>' +
                  snaps.map(function (s) { return '<option value="' + D.escapeHtml(s.id) + '">' + D.escapeHtml(s.name) + ' (' + new Date(s.timestamp).toLocaleString() + ')</option>'; }).join('') +
                '</select></div>' +
            '</div>' +
            '<label class="check" style="margin:6px 0;"><input type="checkbox" data-narrate checked /><span class="box"></span><span class="check-label">Generate AI narration</span></label>' +
            '<div data-result style="margin-top:12px;"></div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="btn" data-close>Close</button>' +
            '<button class="btn btn-primary" data-run>Compare</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(bd);
      bd.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { bd.remove(); }); });
      bd.addEventListener('click', function (e) { if (e.target === bd) bd.remove(); });

      bd.querySelector('[data-run]').addEventListener('click', async function () {
        var aId = bd.querySelector('[data-snap-a]').value;
        var bId = bd.querySelector('[data-snap-b]').value;
        var narrate = bd.querySelector('[data-narrate]').checked;
        if (aId === bId) { D.toast('Pick two different snapshots'); return; }
        var snapA = snaps.find(function (s) { return s.id === aId; });
        var snapB = snaps.find(function (s) { return s.id === bId; });
        var resultEl = bd.querySelector('[data-result]');
        resultEl.innerHTML = '<div class="empty-state es-sub">Computing…</div>';
        try {
          var resp = await fetch(((D.agent && D.agent.base) || '') + '/api/agent/snapshot-diff', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ snapA: snapA, snapB: snapB, narrate: narrate && D.brain && D.brain.online })
          });
          var data = await resp.json();
          resultEl.innerHTML = renderDiff(data);
        } catch (e) {
          resultEl.innerHTML = '<div class="empty-state es-sub">Agent offline — narration unavailable.</div>';
        }
      });
    }

    function renderDiff(data) {
      var d = data.diff || {};
      var html = '';
      if (data.narration) {
        html += '<div class="callout" style="margin-bottom:12px;">' + D.escapeHtml(data.narration) + '</div>';
      } else if (data.narration === null) {
        html += '<div class="empty-state es-sub" style="padding:10px;">narration unavailable</div>';
      }
      html += '<h4>Environment</h4>';
      html += '<div class="row">added: ' + (d.env.added || []).join(', ') + '</div>';
      html += '<div class="row">removed: ' + (d.env.removed || []).join(', ') + '</div>';
      html += '<div class="row">changed: ' + (d.env.changed || []).map(function (c) { return c.key; }).join(', ') + '</div>';
      html += '<h4 style="margin-top:10px;">Git</h4><div>' + (d.git.branchChanged ? d.git.branchChanged.from + ' → ' + d.git.branchChanged.to : 'no branch change') + ' · sha-changed: ' + d.git.shaChanged + ' · dirty-delta: ' + d.git.dirtyDelta + '</div>';
      html += '<h4 style="margin-top:10px;">Ports</h4><div>opened: ' + (d.ports.opened || []).join(', ') + ' · closed: ' + (d.ports.closed || []).join(', ') + '</div>';
      html += '<h4 style="margin-top:10px;">PIDs</h4><div>+' + d.pids.gained + ' / −' + d.pids.lost + '</div>';
      return html;
    }
  })();

  // ===================================================================
  // 2) Docs Scraper — real URL fetch + drop local doc files
  // ===================================================================
  D.features.docsScraper = (function () {
    var view = document.getElementById('view-docs-scraper');
    if (!view) return null;
    var urlInput = view.querySelector('input[type="text"]');
    var mdView = view.querySelector('.markdown-view');
    var tree = view.querySelector('.tree');

    function getCache() { return loadList(STORE_KEY.docCache); }
    function setCache(c) { saveList(STORE_KEY.docCache, c); }

    function renderMarkdown(title, source) {
      if (!mdView) return;
      // Very lightweight markdown→HTML renderer: headings, paragraphs, inline code,
      // lists, links. Not a full implementation — enough to be readable.
      var safe = D.escapeHtml(source).split('\n');
      var html = [];
      var inList = false;
      safe.forEach(function (line) {
        if (/^# /.test(line))      { if (inList) { html.push('</ul>'); inList = false; } html.push('<h1 class="md-h1">' + line.slice(2) + '</h1>'); }
        else if (/^## /.test(line)) { if (inList) { html.push('</ul>'); inList = false; } html.push('<h2 class="md-h2">' + line.slice(3) + '</h2>'); }
        else if (/^### /.test(line)) { if (inList) { html.push('</ul>'); inList = false; } html.push('<h2 class="md-h2" style="font-size: 13px;">' + line.slice(4) + '</h2>'); }
        else if (/^\s*[-*] /.test(line)) {
          if (!inList) { html.push('<ul class="md-ul">'); inList = true; }
          html.push('<li>' + line.replace(/^\s*[-*] /, '') + '</li>');
        }
        else if (line.trim() === '') {
          if (inList) { html.push('</ul>'); inList = false; }
          html.push('<div style="height:6px"></div>');
        }
        else {
          if (inList) { html.push('</ul>'); inList = false; }
          // inline code spans
          var l = line.replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>');
          html.push('<p class="md-p">' + l + '</p>');
        }
      });
      if (inList) html.push('</ul>');
      mdView.innerHTML = html.join('');
      var cardMeta = view.querySelectorAll('.card-meta')[1];
      if (cardMeta) cardMeta.textContent = title + ' · ' + Math.ceil(source.length / 1024) + ' KB';
    }

    function refreshTree() {
      if (!tree) return;
      var cache = getCache();
      var groups = {};
      cache.forEach(function (e) {
        var host = e.host || 'local';
        (groups[host] = groups[host] || []).push(e);
      });
      var html = '';
      Object.keys(groups).forEach(function (host) {
        html += '<div class="tree-folder"><div class="tree-item">' +
          '<svg class="tree-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>' +
          '<span>' + D.escapeHtml(host) + '</span></div>' +
          '<div class="tree-children">';
        groups[host].forEach(function (e) {
          html += '<div class="tree-item" data-doc-id="' + e.id + '">' +
            '<svg class="tree-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            '<span>' + D.escapeHtml(e.title) + '</span></div>';
        });
        html += '</div></div>';
      });
      if (html) tree.innerHTML = html;
      tree.querySelectorAll('[data-doc-id]').forEach(function (item) {
        item.addEventListener('click', function () {
          tree.querySelectorAll('.tree-item').forEach(function (x) { x.classList.remove('selected'); });
          item.classList.add('selected');
          var id = item.getAttribute('data-doc-id');
          var entry = getCache().find(function (e) { return e.id === id; });
          if (entry) renderMarkdown(entry.title, entry.body);
        });
      });
    }

    function storeDoc(title, body, host) {
      var cache = getCache();
      var entry = { id: 'doc-' + Date.now(), title: title, body: body, host: host || 'local', when: new Date().toISOString() };
      cache.unshift(entry);
      if (cache.length > 30) cache.length = 30;
      setCache(cache);
      refreshTree();
      return entry;
    }

    function storeAndRender(url, body, source, title) {
      var u; try { u = new URL(url); } catch (_) { u = { host: source || 'local', pathname: '' }; }
      var docTitle = title || u.pathname.split('/').filter(Boolean).pop() || u.host || 'document';
      var truncated = body.length > 200000 ? body.slice(0, 200000) + '\n\n[truncated]' : body;
      var entry = storeDoc(docTitle, truncated, u.host || source || 'local');
      renderMarkdown(entry.title, entry.body);
      return entry;
    }

    // Two-stage fetch:
    //   1. Try the browser's own `fetch(url, { mode: 'cors' })` — fast path for
    //      CORS-friendly hosts. Works fully offline if the URL is same-origin.
    //   2. If the browser fetch fails AND the agent is online, retry through
    //      POST /api/scraper/fetch. The agent has no CORS layer, runs in Node,
    //      and returns clean Markdown via turndown when the content is HTML.
    //   3. Otherwise toast a useful error.
    function fetchUrl() {
      var rawUrl = (urlInput && urlInput.value || '').trim();
      if (!rawUrl) { D.toast('Enter a URL first'); urlInput && urlInput.focus(); return; }
      var url = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
      D.toast('Fetching · ' + url);

      fetch(url, { mode: 'cors' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (body) {
          var entry = storeAndRender(url, body, 'browser');
          D.toast('Fetched · ' + entry.title + ' · cached locally');
        })
        .catch(function (browserErr) {
          // CORS-blocked or network error — try the agent proxy.
          if (D.agent && D.agent.online) {
            D.toast('CORS blocked · retrying through agent…');
            D.agent.scrapeUrl(url, 'auto').then(function (res) {
              // Prefer turndown-normalized markdown when HTML; otherwise body.
              var rendered = res.markdown || res.body || '';
              var entry = storeAndRender(res.finalUrl || res.url, rendered, 'agent');
              D.toast('Fetched via agent · ' + entry.title + (res.markdown && res.contentType && res.contentType.indexOf('html') >= 0 ? ' · turndown-rendered' : '') + ' · ' + Math.round((res.bytes || rendered.length) / 1024) + ' KB');
            }).catch(function (agentErr) {
              if (/not in allowlist/i.test(agentErr.message)) {
                D.toast('Agent refused: host not in SCRAPER_ALLOWED_HOSTS · edit agent/.env');
              } else if (/private/i.test(agentErr.message)) {
                D.toast('Agent refused: host resolves to a private/internal address');
              } else if (/disabled/i.test(agentErr.message)) {
                D.toast('Agent scraper disabled · set SCRAPER_ALLOW_ANY=true or add the host');
              } else {
                D.toast('Agent fetch failed: ' + agentErr.message);
              }
            });
          } else {
            D.toast('Fetch failed: ' + (browserErr && browserErr.message || 'CORS blocked') + ' — start the agent or drop a local file');
          }
        });
    }

    wireDropTarget(view, '.md,.txt,.html', function (file) {
      readFile(file).then(function (body) {
        var entry = storeDoc(file.name, body, 'local');
        renderMarkdown(entry.title, entry.body);
        D.toast('Loaded · ' + file.name);
      });
    });

    // Show cached doc count on the cache button.
    function badgeCache() {
      var btn = null;
      view.querySelectorAll('.btn').forEach(function (b) {
        if (b.textContent.trim().indexOf('Browse cache') === 0) btn = b;
      });
      if (btn && !btn.querySelector('.feature-active-pill')) {
        var pill = document.createElement('span');
        pill.className = 'feature-active-pill';
        pill.style.marginLeft = '6px';
        btn.appendChild(pill);
      }
      var pill = btn && btn.querySelector('.feature-active-pill');
      if (pill) pill.textContent = getCache().length + ' cached';
    }

    claim('#view-docs-scraper', 'Fetch Document', fetchUrl);
    claim('#view-docs-scraper', 'Browse cache', function () {
      var c = getCache();
      D.toast(c.length ? c.length + ' docs cached · check the tree on the left' : 'Cache is empty — fetch or drop a doc');
    });

    // Initial render of cached docs into tree (preserves design's initial tree as fallback)
    if (getCache().length) refreshTree();
    badgeCache();

    return { fetchUrl: fetchUrl, refreshTree: refreshTree, getCache: getCache };
  })();

  // ===================================================================
  // 3) Dep Map — parse package.json / requirements.txt / Cargo.toml / go.mod
  // ===================================================================
  D.features.depMap = (function () {
    var view = document.getElementById('view-dep-map');
    if (!view) return null;
    var dropzone = view.querySelector('.dropzone');
    var tbody = view.querySelector('table.data tbody');
    var lastFile = null;

    function detectFormat(name, content) {
      var n = (name || '').toLowerCase();
      if (n.endsWith('package.json') || n === 'package.json') return 'package.json';
      if (n.endsWith('requirements.txt')) return 'requirements.txt';
      if (n.endsWith('cargo.toml')) return 'Cargo.toml';
      if (n.endsWith('go.mod')) return 'go.mod';
      if (n.endsWith('gemfile.lock') || n.endsWith('gemfile')) return 'Gemfile.lock';
      if (n.endsWith('pipfile')) return 'Pipfile';
      // Sniff content
      var t = (content || '').trim();
      if (t.startsWith('{')) return 'package.json';
      if (/^\[dependencies\]/m.test(t)) return 'Cargo.toml';
      if (/^module\s+\S+/m.test(t)) return 'go.mod';
      return 'requirements.txt';
    }

    function parsePackageJson(text) {
      var j = JSON.parse(text);
      var combined = Object.assign({}, j.dependencies || {}, j.devDependencies || {}, j.peerDependencies || {});
      var dev = j.devDependencies || {};
      return Object.keys(combined).map(function (name) {
        var v = String(combined[name]).replace(/^[\^~>=<]+/, '').trim();
        return { name: name, current: v, latest: '—', status: dev[name] ? 'dev' : 'runtime', license: '—', usedBy: 'package.json' };
      });
    }
    function parseRequirementsTxt(text) {
      return text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && !l.startsWith('#'); }).map(function (line) {
        var m = line.match(/^([a-zA-Z0-9_\-\.\[\]]+)\s*([=<>!~]+)?\s*([^;\s]+)?/);
        if (!m) return null;
        return { name: m[1], current: m[3] || '*', latest: '—', status: 'pinned', license: '—', usedBy: 'requirements.txt' };
      }).filter(Boolean);
    }
    function parseCargoToml(text) {
      var out = [];
      var lines = text.split(/\r?\n/);
      var inDeps = false;
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (/^\[dependencies(\.[\w\-]+)?\]/.test(t)) { inDeps = true; continue; }
        if (/^\[/.test(t)) { inDeps = false; continue; }
        if (!inDeps || !t || t.startsWith('#')) continue;
        var m = t.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"([^"]+)"/);
        if (m) { out.push({ name: m[1], current: m[2], latest: '—', status: 'crate', license: '—', usedBy: 'Cargo.toml' }); continue; }
        var m2 = t.match(/^([a-zA-Z0-9_\-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
        if (m2) out.push({ name: m2[1], current: m2[2], latest: '—', status: 'crate', license: '—', usedBy: 'Cargo.toml' });
      }
      return out;
    }
    function parseGoMod(text) {
      var out = [];
      var inBlock = false;
      text.split(/\r?\n/).forEach(function (l) {
        var t = l.trim();
        if (t.indexOf('require (') === 0) { inBlock = true; return; }
        if (inBlock && t === ')') { inBlock = false; return; }
        var m;
        if (inBlock) {
          m = t.match(/^(\S+)\s+(\S+)/);
          if (m) out.push({ name: m[1], current: m[2], latest: '—', status: 'module', license: '—', usedBy: 'go.mod' });
        } else if (/^require\s+/.test(t)) {
          m = t.match(/^require\s+(\S+)\s+(\S+)/);
          if (m) out.push({ name: m[1], current: m[2], latest: '—', status: 'module', license: '—', usedBy: 'go.mod' });
        }
      });
      return out;
    }
    function parseGemfileLock(text) {
      var out = [];
      var inSpecs = false;
      text.split(/\r?\n/).forEach(function (l) {
        if (/^\s*specs:/.test(l)) { inSpecs = true; return; }
        if (!inSpecs) return;
        var m = l.match(/^\s{4}([\w\-]+)\s+\(([^)]+)\)/);
        if (m) out.push({ name: m[1], current: m[2], latest: '—', status: 'gem', license: '—', usedBy: 'Gemfile.lock' });
      });
      return out;
    }

    function parse(format, text) {
      switch (format) {
        case 'package.json':     return parsePackageJson(text);
        case 'requirements.txt': return parseRequirementsTxt(text);
        case 'Cargo.toml':       return parseCargoToml(text);
        case 'go.mod':           return parseGoMod(text);
        case 'Gemfile.lock':     return parseGemfileLock(text);
        case 'Pipfile':          return parseRequirementsTxt(text);
        default:                 return [];
      }
    }

    // Map manifest formats to the registry ecosystem name expected by the agent.
    var FORMAT_TO_ECOSYSTEM = {
      'package.json':     'npm',
      'requirements.txt': 'pip',
      'Pipfile':          'pip',
      'Cargo.toml':       'cargo',
      'go.mod':           'go',
      'Gemfile.lock':     'gem'
    };

    function compareSemver(a, b) {
      if (!a || !b) return 0;
      function parse(v) {
        return String(v).replace(/^[v=]+/, '').split(/[.+\-]/).map(function (p) {
          var n = parseInt(p, 10);
          return Number.isFinite(n) ? n : p;
        });
      }
      var pa = parse(a), pb = parse(b);
      var len = Math.max(pa.length, pb.length);
      for (var i = 0; i < len; i++) {
        var x = pa[i], y = pb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x === 'number' && typeof y === 'number') {
          if (x !== y) return x < y ? -1 : 1;
        } else {
          var sx = String(x), sy = String(y);
          if (sx !== sy) return sx < sy ? -1 : 1;
        }
      }
      return 0;
    }

    function rowHtml(r) {
      var iconLetter = (r.name[0] || '?').toUpperCase();
      var statusCls = '';
      if (r.status === 'outdated') statusCls = ' warn';
      else if (r.status === 'up-to-date') statusCls = ' ok';
      else if (r.status === 'error') statusCls = ' err';
      var statusBadge = '<span class="badge' + statusCls + '">' + D.escapeHtml(r.status) + '</span>';
      var latestCell = r.latest && r.latest !== '—'
        ? '<span class="ver">' + D.escapeHtml(r.latest) + '</span>'
        : '<span class="ver dim">' + D.escapeHtml(r.latest || '—') + '</span>';
      return '<tr data-pkg="' + D.escapeHtml(r.name) + '">' +
        '<td><div class="pkg"><div class="pkg-icon">' + iconLetter + '</div>' + D.escapeHtml(r.name) + '</div></td>' +
        '<td><span class="ver">' + D.escapeHtml(r.current) + '</span></td>' +
        '<td data-col="latest">' + latestCell + '</td>' +
        '<td data-col="status">' + statusBadge + '</td>' +
        '<td><span class="ver dim">' + D.escapeHtml(r.license) + '</span></td>' +
        '<td><span class="ver dim">' + D.escapeHtml(r.usedBy) + '</span></td>' +
        '</tr>';
    }

    function renderTable(rows, fileName, format) {
      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-meta); padding: 24px;">No dependencies found in ' + D.escapeHtml(fileName) + '</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(rowHtml).join('');

      var stats = view.querySelectorAll('.stat-value');
      if (stats[0]) stats[0].textContent = rows.length;
      var cardMeta = view.querySelector('.card-meta');
      if (cardMeta) cardMeta.textContent = format + ' · ' + fileName + ' · ' + rows.length + ' deps';
    }

    function applyLookupResults(rows, lookups, ecosystem) {
      if (!tbody) return rows;
      var byName = {};
      lookups.forEach(function (l) { byName[l.name.toLowerCase()] = l; });
      var outdated = 0, current = 0, errors = 0;
      rows.forEach(function (r) {
        var hit = byName[r.name.toLowerCase()];
        if (!hit) return;
        if (hit.error) {
          r.latest = '—';
          r.status = 'error';
          errors++;
        } else if (hit.latest) {
          r.latest = hit.latest;
          var cmp = compareSemver(r.current, hit.latest);
          r.status = cmp < 0 ? 'outdated' : 'up-to-date';
          if (cmp < 0) outdated++; else current++;
          if (hit.extras && hit.extras.license && r.license === '—') r.license = hit.extras.license;
        }
        // Update the row in place rather than re-rendering the whole table.
        var tr = tbody.querySelector('tr[data-pkg="' + (window.CSS && CSS.escape ? CSS.escape(r.name) : r.name.replace(/"/g, '\\"')) + '"]');
        if (tr) tr.outerHTML = rowHtml(r);
      });
      // Update stats with outdated count
      var stats = view.querySelectorAll('.stat-value');
      if (stats[1]) stats[1].textContent = outdated;
      var meta = view.querySelector('.card-meta');
      if (meta) {
        var existing = meta.textContent;
        meta.textContent = existing.split(' · ')[0] + ' · ' + existing.split(' · ')[1] + ' · ' + rows.length + ' deps · ' + outdated + ' outdated';
        if (errors) meta.textContent += ' · ' + errors + ' errors';
      }
      return rows;
    }

    function handleFile(file) {
      lastFile = file;
      readFile(file).then(function (txt) {
        try {
          var format = detectFormat(file.name, txt);
          var rows = parse(format, txt);
          renderTable(rows, file.name, format);
          try { localStorage.setItem(STORE_KEY.activeManifest, JSON.stringify({ name: file.name, format: format, content: txt.slice(0, 500000) })); } catch (e) {}
          D.toast('Parsed · ' + rows.length + ' dependencies from ' + file.name);

          // ---- Phase 3: live registry lookup ----
          if (D.agent && D.agent.online && rows.length) {
            var ecosystem = FORMAT_TO_ECOSYSTEM[format];
            if (ecosystem) {
              var names = rows.map(function (r) { return r.name; });
              D.toast('Checking latest versions on ' + ecosystem + '…');
              D.agent.lookupDeps(ecosystem, names).then(function (res) {
                applyLookupResults(rows, res.results, ecosystem);
                var outdated = rows.filter(function (r) { return r.status === 'outdated'; }).length;
                D.toast(outdated > 0
                  ? outdated + ' outdated · ' + (rows.length - outdated) + ' up-to-date'
                  : 'All ' + rows.length + ' dependencies up-to-date');
              }).catch(function (err) {
                D.toast('Registry lookup failed: ' + err.message);
              });
            }
          }
        } catch (e) {
          D.toast('Could not parse: ' + (e.message || 'unknown error'));
        }
      });
    }

    function rescan() {
      if (lastFile) return handleFile(lastFile);
      var saved;
      try { saved = JSON.parse(localStorage.getItem(STORE_KEY.activeManifest) || 'null'); } catch (e) {}
      if (saved && saved.content) {
        var rows = parse(saved.format, saved.content);
        renderTable(rows, saved.name, saved.format);
        D.toast('Re-scanned · ' + rows.length + ' dependencies from ' + saved.name);
        return;
      }
      D.toast('Drop a manifest file first (package.json, requirements.txt, Cargo.toml, go.mod…)');
    }

    if (dropzone) {
      dropzone.style.cursor = 'pointer';
      dropzone.addEventListener('click', function () {
        pickFile('.json,.txt,.toml,.mod,.lock').then(function (f) { if (f) handleFile(f); });
      });
      wireDropTarget(dropzone, '', function (f) { handleFile(f); });
    }
    // Also accept drops anywhere in the view for convenience.
    wireDropTarget(view, '', function (f) {
      if (/(\.json|\.txt|\.toml|\.mod|\.lock|^Pipfile|^Gemfile)/i.test(f.name)) handleFile(f);
    });

    claim('#view-dep-map', 'Re-scan', rescan);

    // Restore last manifest on load
    var saved;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY.activeManifest) || 'null'); } catch (e) {}
    if (saved && saved.content) {
      try {
        var rows = parse(saved.format, saved.content);
        renderTable(rows, saved.name, saved.format);
      } catch (e) {}
    }

    return { handleFile: handleFile, rescan: rescan, parse: parse, detectFormat: detectFormat };
  })();

  // ===================================================================
  // 4) Log Tail — load real log files and filter
  // ===================================================================
  D.features.logTail = (function () {
    var view = document.getElementById('view-log-tail');
    if (!view) return null;
    var pathInput = view.querySelector('input[placeholder*="path"], input[placeholder*="Log file"], input[placeholder*="/var/log"]');
    var terminal = view.querySelector('.terminal');

    function renderLines(lines) {
      if (!terminal) return;
      // Keep terminal styling; build .term-line elements
      var html = lines.slice(-2000).map(function (l) {
        var lvl = (l.level || 'info').toLowerCase();
        var cls = 'term-line' + (lvl === 'err' ? ' err-row' : '');
        var ts = l.ts ? '<span class="ts">' + D.escapeHtml(l.ts) + '</span>' : '';
        var levelTag = '<span class="lvl ' + lvl + '">' + lvl.toUpperCase() + '</span>';
        return '<div class="' + cls + '">' + ts + levelTag + '<span class="msg">' + D.escapeHtml(l.msg) + '</span></div>';
      }).join('');
      terminal.innerHTML = html || '<div class="term-line"><span class="msg" style="color: var(--text-meta);">No matching lines</span></div>';
    }

    function parseLogText(text) {
      return text.split(/\r?\n/).filter(function (l) { return l.length; }).map(function (line) {
        var level = 'info';
        if (/\b(error|err|fatal|critical|exception)\b/i.test(line)) level = 'err';
        else if (/\b(warn|warning)\b/i.test(line)) level = 'warn';
        else if (/\b(debug|trace)\b/i.test(line)) level = 'info';
        else if (/\b(ok|success|done|started|listening)\b/i.test(line)) level = 'ok';
        var tsMatch = line.match(/^\s*(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+\-]\d{2}:?\d{2})?)/)
                   || line.match(/^\s*(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/)
                   || line.match(/^\s*\[(\d[^\]]+)\]/);
        return { raw: line, ts: tsMatch ? tsMatch[1] : '', level: level, msg: line };
      });
    }

    // Buffer of parsed lines currently rendered. Capped at 2000 in renderLines,
    // but we keep the full window in memory so filter / pause / resume work.
    var buffer = [];
    var liveStream = null;       // EventSource handle when streaming
    var livePath = null;         // workspace-relative path being tailed
    var renderPaused = false;    // when true, lines accumulate but aren't drawn

    function appendLines(newLines) {
      for (var i = 0; i < newLines.length; i++) buffer.push(newLines[i]);
      if (buffer.length > 4000) buffer.splice(0, buffer.length - 4000);
      updateStats();
      if (!renderPaused) renderLines(buffer);
    }

    function resetBuffer(lines) {
      buffer = lines.slice();
      if (buffer.length > 4000) buffer.splice(0, buffer.length - 4000);
      updateStats();
      renderLines(buffer);
    }

    function updateStats() {
      var stats = view.querySelectorAll('.stat-value');
      if (stats[0]) stats[0].textContent = buffer.length;
      var errs = 0;
      for (var i = 0; i < buffer.length; i++) if (buffer[i].level === 'err') errs++;
      if (stats[1]) stats[1].textContent = errs;
    }

    function parseLine(line) {
      var level = 'info';
      if (/\b(error|err|fatal|critical|exception)\b/i.test(line)) level = 'err';
      else if (/\b(warn|warning)\b/i.test(line)) level = 'warn';
      else if (/\b(debug|trace)\b/i.test(line)) level = 'info';
      else if (/\b(ok|success|done|started|listening)\b/i.test(line)) level = 'ok';
      var tsMatch = line.match(/^\s*(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+\-]\d{2}:?\d{2})?)/)
                 || line.match(/^\s*(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/)
                 || line.match(/^\s*\[(\d[^\]]+)\]/);
      return { raw: line, ts: tsMatch ? tsMatch[1] : '', level: level, msg: line };
    }

    function handleFile(file) {
      stopLiveStream();
      readFile(file).then(function (txt) {
        var lines = txt.split(/\r?\n/).filter(function (l) { return l.length; }).map(parseLine);
        resetBuffer(lines);
        if (pathInput) pathInput.value = file.name;
        D.toast('Loaded · ' + lines.length + ' lines from ' + file.name);
      });
    }

    // ---- Live streaming via agent (Phase 2) ----

    function statusPill(text, kind) {
      var bar = view.querySelector('.toolbar');
      if (!bar) return;
      var pill = bar.querySelector('[data-live-pill]');
      if (!pill) {
        pill = document.createElement('span');
        pill.setAttribute('data-live-pill', '1');
        pill.style.cssText = 'margin-left: auto; font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 500;';
        bar.appendChild(pill);
      }
      var palette = {
        live:    'background: rgba(16,185,129,0.14); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.3);',
        paused:  'background: rgba(245,158,11,0.14); color: #fcd34d; border: 1px solid rgba(245,158,11,0.3);',
        offline: 'background: var(--bg-elevated); color: var(--text-meta); border: 1px solid var(--border);'
      };
      pill.style.cssText = pill.style.cssText.split(';').filter(function (s) { return !/background|color|border/.test(s); }).join(';') + ';' + (palette[kind] || palette.offline);
      pill.textContent = text;
    }

    function startLiveStream(relPath) {
      if (!D.agent || !D.agent.online) {
        D.toast('Agent offline — start it (cd agent && npm start) to tail live');
        return;
      }
      stopLiveStream();
      livePath = relPath;
      statusPill('● connecting…', 'offline');

      D.agent.fetchLogBackfill(relPath, 64 * 1024).then(function (res) {
        var lines = res.text.split(/\r?\n/).filter(function (l) { return l.length; }).map(parseLine);
        resetBuffer(lines);
        if (pathInput) pathInput.value = relPath;

        liveStream = D.agent.openLogStream(relPath, {
          open: function () { statusPill('● live · ' + relPath.split(/[\\\/]/).pop(), 'live'); D.toast('Tailing live · ' + relPath); },
          line: function (evt) { appendLines([parseLine(evt.line)]); },
          rotated:   function () { D.toast('Log rotated — restarting tail'); resetBuffer([]); },
          truncated: function () { D.toast('Log truncated — buffer reset'); resetBuffer([]); },
          unlink:    function () { statusPill('● file removed', 'paused'); D.toast('Log file removed'); },
          error:     function (evt) { D.toast('Stream error: ' + (evt.message || 'unknown')); },
          disconnect: function () { statusPill('● disconnected', 'offline'); }
        });
      }).catch(function (err) {
        D.toast('Could not start stream: ' + err.message);
        statusPill('● error', 'offline');
      });
    }

    function stopLiveStream() {
      if (liveStream) {
        try { liveStream.close(); } catch (_) {}
        liveStream = null;
      }
      livePath = null;
      statusPill('', 'offline');
      var pill = view.querySelector('[data-live-pill]');
      if (pill) pill.remove();
    }

    function browseWorkspaceLogs() {
      if (!D.agent || !D.agent.online) {
        D.toast('Agent offline — start it to browse workspace logs');
        return;
      }
      D.agent.findLogs({ exts: ['.log', '.txt', '.out', '.err'], max: 50 }).then(function (res) {
        if (!res.results.length) {
          D.toast('No log files found in workspace · ' + res.workspaceRoot);
          return;
        }
        var rows = res.results.map(function (f) {
          var size = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : (f.size / 1024).toFixed(1) + ' KB';
          var when = new Date(f.mtimeMs).toLocaleString();
          return '<button class="login-recent" data-log-path="' + D.escapeHtml(f.path) + '" style="margin-bottom: 4px;">' +
            '<div class="gl" style="background: linear-gradient(135deg,#06b6d4,#3b82f6);">L</div>' +
            '<div style="flex:1; min-width: 0;">' +
              '<div class="nm" style="font-family: var(--font-mono); font-size: 12.5px;">' + D.escapeHtml(f.path) + '</div>' +
              '<div class="pt">' + size + ' · ' + when + '</div>' +
            '</div>' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
          '</button>';
        }).join('');
        var bd = document.createElement('div');
        bd.id = 'logBrowseModal';
        bd.className = 'modal-backdrop open';
        bd.innerHTML =
          '<div class="modal" style="max-width: 580px;">' +
            '<div class="modal-header"><div class="modal-title">Workspace log files · ' + res.results.length + '</div>' +
              '<button class="close-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
            '</div>' +
            '<div class="modal-body" style="max-height: 60vh;">' + rows + '</div>' +
            '<div class="modal-footer"><button class="btn" data-c-cancel>Close</button></div>' +
          '</div>';
        document.body.appendChild(bd);
        function close () { bd.remove(); }
        bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
        bd.querySelector('.close-btn').addEventListener('click', close);
        bd.querySelector('[data-c-cancel]').addEventListener('click', close);
        bd.querySelectorAll('[data-log-path]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var p = btn.getAttribute('data-log-path');
            close();
            startLiveStream(p);
          });
        });
      }).catch(function (err) {
        D.toast('Find failed: ' + err.message);
      });
    }

    // Re-purpose the Pause tail button when we have a live stream.
    function bindPauseToggle() {
      var btn = null;
      view.querySelectorAll('.btn').forEach(function (b) {
        if (b.textContent.trim().indexOf('Pause tail') === 0 || b.textContent.trim().indexOf('Resume tail') === 0) btn = b;
      });
      if (!btn || btn.getAttribute('data-live-wired') === '1') return;
      btn.setAttribute('data-live-wired', '1');
      btn.addEventListener('click', function () {
        if (!liveStream) return; // let the original handler keep its toast behavior
        renderPaused = !renderPaused;
        if (renderPaused) {
          statusPill('● paused (rendering)', 'paused');
        } else {
          statusPill('● live · ' + (livePath || '').split(/[\\\/]/).pop(), 'live');
          renderLines(buffer);
        }
      });
    }
    bindPauseToggle();

    // Inject "Load…" + "Tail live" + "Browse logs…" controls next to the path input.
    if (pathInput && !pathInput.parentElement.querySelector('[data-log-load]')) {
      var ctrlWrap = document.createElement('span');
      ctrlWrap.style.cssText = 'display: inline-flex; gap: 6px; margin-left: 6px;';
      ctrlWrap.innerHTML =
        '<button class="btn" data-log-load="1" data-wired="1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Load…</button>' +
        '<button class="btn" data-log-tail="1" data-wired="1" title="Tail the path live via the local agent"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Tail live</button>' +
        '<button class="btn btn-ghost" data-log-browse="1" data-wired="1" title="Browse log files in the workspace"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></button>';
      pathInput.parentElement.appendChild(ctrlWrap);
      ctrlWrap.querySelector('[data-log-load]').addEventListener('click', function () {
        pickFile('.log,.txt,.out,.err').then(function (f) { if (f) handleFile(f); });
      });
      ctrlWrap.querySelector('[data-log-tail]').addEventListener('click', function () {
        var p = (pathInput.value || '').trim();
        if (!p) { D.toast('Enter a log path first · or click the folder icon to browse'); pathInput.focus(); return; }
        startLiveStream(p);
      });
      ctrlWrap.querySelector('[data-log-browse]').addEventListener('click', browseWorkspaceLogs);
    }

    // Drop a log file onto the terminal area — stops any live stream first.
    wireDropTarget(terminal, '', function (f) { handleFile(f); });
    wireDropTarget(view, '', function (f) {
      if (/\.(log|txt|out|err)$/i.test(f.name)) handleFile(f);
    });

    return {
      handleFile: handleFile,
      renderLines: renderLines,
      parseLine: parseLine,
      startLiveStream: startLiveStream,
      stopLiveStream: stopLiveStream,
      browseWorkspaceLogs: browseWorkspaceLogs,
      isStreaming: function () { return !!liveStream; }
    };
  })();

  // ===================================================================
  // 5) Issue Filler — live markdown preview + copy / download
  // ===================================================================
  D.features.issueFiller = (function () {
    var view = document.getElementById('view-issue-filler');
    if (!view) return null;

    function gather() {
      var inputs = view.querySelectorAll('input[type="text"], textarea');
      var selects = view.querySelectorAll('select');
      return {
        summary: inputs[0] && inputs[0].value || '',
        severity: selects[0] && selects[0].value || 'normal',
        template: selects[1] && selects[1].value || 'bug',
        context: inputs[1] && inputs[1].value || '',
        observed: inputs[2] && inputs[2].value || '',
        steps: inputs[3] && inputs[3].value || '',
        expected: inputs[4] && inputs[4].value || '',
        notes: inputs[5] && inputs[5].value || ''
      };
    }

    function generate() {
      var d = gather();
      var ws = document.getElementById('wsName') ? document.getElementById('wsName').textContent : '';
      var branch = (D.features.contextSnap && (document.querySelectorAll('#view-context-snap .stat-value')[3])) ? document.querySelectorAll('#view-context-snap .stat-value')[3].textContent.trim() : '';
      var date = new Date().toISOString().slice(0, 10);
      var lines = [];
      lines.push('# ' + (d.summary || '(no title)'));
      lines.push('');
      lines.push('- **Severity:** ' + d.severity);
      lines.push('- **Template:** ' + d.template);
      if (ws) lines.push('- **Workspace:** `' + ws + '`');
      if (branch) lines.push('- **Branch:** `' + branch + '`');
      lines.push('- **Date:** ' + date);
      lines.push('');
      if (d.context)  { lines.push('## Context'); lines.push(''); lines.push(d.context); lines.push(''); }
      if (d.observed) { lines.push('## Observed'); lines.push(''); lines.push(d.observed); lines.push(''); }
      if (d.steps)    { lines.push('## Steps to reproduce'); lines.push(''); lines.push(d.steps); lines.push(''); }
      if (d.expected) { lines.push('## Expected'); lines.push(''); lines.push(d.expected); lines.push(''); }
      if (d.notes)    { lines.push('## Notes'); lines.push(''); lines.push(d.notes); lines.push(''); }
      lines.push('---');
      lines.push('_generated by DevOps Local · offline · ' + date + '_');
      return lines.join('\n');
    }

    function updatePreview() {
      var md = generate();
      var pre = view.querySelector('.code-block');
      if (pre) {
        // Lightweight syntax: bold headings, dim metadata.
        var html = md.split('\n').map(function (line) {
          if (/^# /.test(line))  return '<span class="md-h1" style="font-size: 13px; display: inline-block; margin: 0;">' + D.escapeHtml(line.slice(2)) + '</span>';
          if (/^## /.test(line)) return '<span class="code-key">' + D.escapeHtml(line) + '</span>';
          if (/^- \*\*/.test(line)) return '<span class="code-meta">' + D.escapeHtml(line) + '</span>';
          if (/^_/.test(line)) return '<span class="code-comment">' + D.escapeHtml(line) + '</span>';
          if (line === '---') return '<span class="code-comment">' + line + '</span>';
          return D.escapeHtml(line);
        }).join('\n');
        pre.innerHTML = html;
      }
      return md;
    }

    function copyMarkdown() {
      var md = updatePreview();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).then(
          function () { D.toast('Markdown copied · ' + md.length + ' chars'); },
          function () { D.toast('Clipboard blocked — issue downloaded instead'); downloadFile('issue.md', 'text/markdown', md); }
        );
      } else {
        downloadFile('issue.md', 'text/markdown', md);
        D.toast('Downloaded as issue.md (clipboard unavailable)');
      }
    }

    function fileIssue() {
      var d = gather();
      var md = generate();
      var name = (d.summary || 'issue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'issue';
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadFile(ts + '-' + name + '.md', 'text/markdown', md);
      var drafts = loadList(STORE_KEY.issueDrafts);
      drafts.unshift({ id: 'draft-' + Date.now(), name: name, content: md, when: new Date().toISOString() });
      if (drafts.length > 30) drafts.length = 30;
      saveList(STORE_KEY.issueDrafts, drafts);
      D.toast('Filed · saved to drafts and downloaded');
    }

    function switchTemplate() {
      var selects = view.querySelectorAll('select');
      var current = selects[1] ? selects[1].selectedIndex : 0;
      if (selects[1]) {
        selects[1].selectedIndex = (current + 1) % selects[1].options.length;
        selects[1].dispatchEvent(new Event('change', { bubbles: true }));
      }
      updatePreview();
      D.toast('Template → ' + (selects[1] ? selects[1].value : 'unknown'));
    }

    // Live preview as the user types.
    view.querySelectorAll('input, textarea, select').forEach(function (el) {
      el.addEventListener('input', updatePreview);
      el.addEventListener('change', updatePreview);
    });

    claim('#view-issue-filler', 'File issue', fileIssue);
    claim('#view-issue-filler', 'Copy', copyMarkdown);
    claim('#view-issue-filler', 'Switch template', switchTemplate);

    // Initial render
    updatePreview();

    return { generate: generate, copyMarkdown: copyMarkdown, fileIssue: fileIssue };
  })();

  // Phase 5: Drafts inbox at the bottom of the Issue Filler view. Lists drafts
  // (including Brain-pinned ones) with ✨ Enrich + File-on-GitHub buttons.
  (function draftsInbox() {
    var view = document.getElementById('view-issue-filler');
    if (!view) return;
    var host = document.createElement('div');
    host.id = 'drafts-inbox';
    host.style.cssText = 'margin-top:16px;border-top:1px solid var(--border);padding-top:14px;';
    view.appendChild(host);

    function render() {
      var list = D.store.get('devops:issue-drafts', []);
      if (!list.length) { host.innerHTML = ''; return; }
      host.innerHTML =
        '<div class="card-title" style="margin-bottom:8px;"><span class="dot"></span>DRAFTS INBOX (' + list.length + ')</div>' +
        list.slice(0, 8).map(function (d) {
          var status = d.enriched ? '<span class="badge ok">enriched</span>' : '<span class="badge warn">bare</span>';
          var filed = d.filedAs ? '<a class="badge indigo" href="' + d.filedAs.url + '" target="_blank" rel="noopener">filed</a>' : '';
          return '<div data-draft-row data-id="' + D.escapeHtml(d.id) + '" style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-weight:500;">' + D.escapeHtml(d.title || d.name) + '</div>' +
              '<div style="font-size:11px;color:var(--text-meta);">' + new Date(d.when).toLocaleString() + '</div>' +
            '</div>' +
            status + filed +
            (d.enriched ? '' : '<button class="btn" data-enrich data-id="' + D.escapeHtml(d.id) + '">✨ Enrich</button>') +
            '<button class="btn" data-file-gh data-id="' + D.escapeHtml(d.id) + '">File on GitHub</button>' +
          '</div>';
        }).join('');

      host.querySelectorAll('[data-enrich]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-id');
          if (D.brain && D.brain.online) {
            fetch((D.agent.base || '') + '/api/agent/enrich-draft', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id })
            }).then(function (r) { return r.json(); }).then(function (j) {
              D.toast(j.error ? ('Enrich failed: ' + j.error) : 'Enrichment queued');
            });
          } else { D.toast('Agent offline — cannot enrich'); }
        });
      });
      host.querySelectorAll('[data-file-gh]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (D.brain && typeof D.brain.openFileModal === 'function') D.brain.openFileModal(b.getAttribute('data-id'));
          else D.toast('Agent offline — cannot file');
        });
      });
    }
    render();
    document.addEventListener('devops:draft-changed', render);
    setInterval(render, 5000);
  })();

  // -- Surface a tiny global "Features ready" indicator into the sidebar --
  (function () {
    var brand = document.querySelector('.brand .brand-sub');
    if (brand && !document.getElementById('featuresActivePill')) {
      var sub = brand.parentElement;
      if (sub) {
        var pill = document.createElement('div');
        pill.id = 'featuresActivePill';
        pill.className = 'feature-active-pill';
        pill.style.marginTop = '6px';
        pill.textContent = '5 features active';
        pill.title = 'All five developer tools are active. Click the brand to view feature status.';
        sub.appendChild(pill);
        pill.addEventListener('click', function () {
          var lines = [
            'Context-Snap   · capture / restore / export · ' + loadList(STORE_KEY.snapshots).length + ' saved',
            'Docs Scraper   · URL fetch + drop .md/.txt/.html · ' + loadList(STORE_KEY.docCache).length + ' cached',
            'Dep Map        · drop a manifest to parse · ' + (localStorage.getItem(STORE_KEY.activeManifest) ? '1 loaded' : 'idle'),
            'Log-Tail       · click Load… or drop a .log file',
            'Issue Filler   · type to preview · ' + loadList(STORE_KEY.issueDrafts).length + ' drafts'
          ];
          D.confirmAction('Developer features', '<pre style="font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7; white-space: pre-wrap;">' + lines.join('\n') + '</pre>', null);
          // Repurpose confirm dialog — hide the Confirm button
          var ok = document.querySelector('#confirmModal [data-c-ok]');
          if (ok) ok.style.display = 'none';
        });
        pill.style.cursor = 'pointer';
      }
    }
  })();
})();
