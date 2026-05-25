/* Frontend bindings for the Autonomous Brain (Phase 4 backend).
   Loaded after agent-client.js. When the agent is reachable AND the Brain
   endpoints respond, this:
     1. Pulls /api/agent/snapshots + /drafts on load, merges new entries into
        localStorage so the Context-Snap pane + Issue Filler drafts list show
        whatever the Brain captured while the UI was closed.
     2. Opens an SSE connection to /api/agent/events/stream and reacts to
        live events: log entries → activity buffer (notifications popover),
        snapshot → merge + refresh Context-Snap, draft → merge + toast,
        notification → toast with severity, throttle → recolor brand pill.
     3. Updates the brand pill to show BRAIN ACTIVE / THROTTLED state.
     4. Replaces the notifications popover contents with live Brain events
        (the four mock items shipped with the design get replaced).
     5. Pushes a curated set of Settings changes to /api/agent/settings so
        the Brain respects the user's toggles in real time.

   When the agent or Brain are NOT reachable, this module no-ops cleanly and
   the dashboard runs in its existing offline mode. */

(function () {
  var D = window.DevOps;
  if (!D) { console.error('[DevOps] brain-client.js needs core.js + agent-client.js'); return; }

  var SNAP_KEY  = 'devops:snapshots';
  var DRAFT_KEY = 'devops:issue-drafts';
  var MAX_LOCAL_SNAPSHOTS = 50;
  var MAX_LOCAL_DRAFTS = 30;
  var ACTIVITY_CAP = 100;

  D.brain = {
    online: false,
    status: null,
    activity: [],   // recent log events (cap ACTIVITY_CAP, newest first)
    es: null,       // EventSource handle

    /* Check whether the Brain endpoints respond. Requires DevOps.agent.online. */
    detect: function () {
      var self = this;
      if (!D.agent || !D.agent.online) {
        self.online = false; self.status = null;
        return Promise.resolve(false);
      }
      return fetch(D.agent.base + '/api/agent/status', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { self.online = true; self.status = j; return true; })
        .catch(function () { self.online = false; self.status = null; return false; });
    },

    refreshStatus: function () {
      var self = this;
      if (!self.online) return Promise.resolve(null);
      return fetch(D.agent.base + '/api/agent/status', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) { self.status = j; return j; })
        .catch(function () { return null; });
    },

    /* Pull brain-side snapshots + drafts and merge any IDs we don't already
       have into localStorage. Called on load so the UI reflects everything the
       Brain captured while the browser was closed. */
    syncBacklog: function () {
      var self = this;
      if (!self.online) return Promise.resolve({ snapshots: 0, drafts: 0 });
      var snapPromise = fetch(D.agent.base + '/api/agent/snapshots', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var local = D.store.get(SNAP_KEY, []);
          var existingIds = new Set(local.map(function (s) { return s.id; }));
          var fresh = (j.snapshots || []).filter(function (s) { return !existingIds.has(s.id); });
          if (!fresh.length) return 0;
          var merged = fresh.concat(local);
          merged.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
          if (merged.length > MAX_LOCAL_SNAPSHOTS) merged.length = MAX_LOCAL_SNAPSHOTS;
          D.store.set(SNAP_KEY, merged);
          // Update the snapshot counter (frontend tracks max seq locally too).
          var maxSeq = merged.reduce(function (m, s) { return s.seq > m ? s.seq : m; }, 0);
          if (maxSeq > D.state.capturedSnapshotCount) D.state.capturedSnapshotCount = maxSeq;
          return fresh.length;
        })
        .catch(function () { return 0; });

      var draftPromise = fetch(D.agent.base + '/api/agent/drafts', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var local = D.store.get(DRAFT_KEY, []);
          var existingIds = new Set(local.map(function (d) { return d.id; }));
          var fresh = (j.drafts || []).filter(function (d) { return !existingIds.has(d.id); });
          if (!fresh.length) return 0;
          var merged = fresh.concat(local);
          merged.sort(function (a, b) { return new Date(b.when) - new Date(a.when); });
          if (merged.length > MAX_LOCAL_DRAFTS) merged.length = MAX_LOCAL_DRAFTS;
          D.store.set(DRAFT_KEY, merged);
          return fresh.length;
        })
        .catch(function () { return 0; });

      return Promise.all([snapPromise, draftPromise]).then(function (counts) {
        return { snapshots: counts[0], drafts: counts[1] };
      });
    },

    /* Open the live SSE stream. Returns the EventSource handle. */
    openStream: function () {
      var self = this;
      if (!self.online) return null;
      self.closeStream();
      try {
        var url = D.agent.base + '/api/agent/events/stream';
        self.es = new EventSource(url);
      } catch (e) { return null; }

      function parse(e) { try { return JSON.parse(e.data); } catch (_) { return {}; } }

      self.es.addEventListener('status', function (e) {
        self.status = parse(e);
        updateBrandPill();
        refreshNotifPopover();
      });
      self.es.addEventListener('log', function (e) {
        var evt = parse(e);
        self.activity.unshift(evt);
        if (self.activity.length > ACTIVITY_CAP) self.activity.length = ACTIVITY_CAP;
        refreshNotifPopover();
      });
      self.es.addEventListener('snapshot', function (e) {
        var snap = parse(e);
        mergeOneSnapshot(snap);
        D.toast('Brain snapshot · ' + (snap.name || snap.id));
        if (location.hash || document.querySelector('.view.active')?.id === 'view-context-snap') {
          // refresh context-snap stats
          var stat = document.querySelector('#view-context-snap .stats .stat-value');
          if (stat) stat.textContent = D.store.get(SNAP_KEY, []).length;
        }
      });
      self.es.addEventListener('draft', function (e) {
        var draft = parse(e);
        mergeOneDraft(draft);
        D.toast('Brain pinned error · ' + (draft.title || draft.id));
      });
      self.es.addEventListener('draft-enriched', function (e) {
        var enriched = parse(e);
        replaceDraftInPlace(enriched);
        D.toast('Brain enriched draft · ' + (enriched.confidence || 'ok') + ' confidence');
      });
      self.es.addEventListener('scan', function (e) {
        var scan = parse(e);
        D.toast('Brain scan complete · ' + scan.outdatedCount + ' outdated' +
                (scan.errors && scan.errors.length ? ' · ' + scan.errors.length + ' errors' : ''));
      });
      self.es.addEventListener('notification', function (e) {
        var n = parse(e);
        D.toast(n.title || n.body || 'Brain notification');
      });
      self.es.addEventListener('throttle', function (e) {
        var t = parse(e);
        if (self.status) self.status.throttled = t.active;
        updateBrandPill();
        D.toast(t.active
          ? 'Brain throttled · CPU ' + (t.cpuPercent || '?') + '% > ' + (t.ceiling || '?') + '%'
          : 'Brain resumed · CPU back below ceiling');
      });
      self.es.onerror = function () {
        // Network blip — EventSource auto-reconnects. Don't toast on every blip.
      };
      return self.es;
    },

    closeStream: function () {
      if (this.es) {
        try { this.es.close(); } catch (_) {}
        this.es = null;
      }
    },

    /* POST a partial settings update to the Brain. Returns the merged settings. */
    pushSettings: function (partial) {
      if (!this.online) return Promise.resolve(null);
      return fetch(D.agent.base + '/api/agent/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(partial || {})
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
    },

    /* Trigger the scheduled scan immediately (manual). */
    runScanNow: function () {
      if (!this.online) return Promise.reject(new Error('brain offline'));
      return fetch(D.agent.base + '/api/agent/scan', { method: 'POST' })
        .then(function (r) { return r.json(); });
    },

    /* File a draft on GitHub. Opens a modal with editable owner/repo/title/body/labels. */
    openFileModal: function (draftId) {
      var draft = (D.store.get('devops:issue-drafts', []) || []).find(function (d) { return d.id === draftId; });
      if (!draft) { D.toast('Draft not found'); return; }
      var defaultOwner = (D.brain.status && D.brain.status.settings && D.brain.status.settings.defaultRepoOwner) || '';
      var defaultRepo  = (D.brain.status && D.brain.status.settings && D.brain.status.settings.defaultRepoName)  || '';
      var bd = document.createElement('div');
      bd.className = 'modal-backdrop open'; bd.id = 'ghFileModal';
      bd.innerHTML =
        '<div class="modal" style="max-width:560px;">' +
          '<div class="modal-header"><div class="modal-title">File on GitHub</div>' +
            '<button class="close-btn" data-close>×</button></div>' +
          '<div class="modal-body">' +
            '<div class="field-row">' +
              '<div class="field"><label class="field-label">Owner</label><input class="input" data-owner value="' + D.escapeHtml(defaultOwner) + '" /></div>' +
              '<div class="field"><label class="field-label">Repo</label><input class="input" data-repo value="' + D.escapeHtml(defaultRepo) + '" /></div>' +
            '</div>' +
            '<div class="field"><label class="field-label">Title</label><input class="input" data-title value="' + D.escapeHtml(draft.title || draft.name) + '" /></div>' +
            '<div class="field"><label class="field-label">Labels (comma-separated)</label><input class="input" data-labels value="bug' + (draft.confidence === 'high' ? ',priority-high' : '') + '" /></div>' +
            '<div class="field"><label class="field-label">Body</label><textarea class="textarea" data-body style="min-height:200px;">' + D.escapeHtml(draft.content) + '</textarea></div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="btn" data-close>Cancel</button>' +
            '<button class="btn btn-primary" data-submit>Create issue</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(bd);
      bd.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { bd.remove(); }); });
      bd.querySelector('[data-submit]').addEventListener('click', async function () {
        var payload = {
          owner: bd.querySelector('[data-owner]').value.trim(),
          repo:  bd.querySelector('[data-repo]').value.trim(),
          title: bd.querySelector('[data-title]').value,
          body:  bd.querySelector('[data-body]').value,
          labels: bd.querySelector('[data-labels]').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          draftId: draft.id
        };
        if (!payload.owner || !payload.repo) { D.toast('Owner + repo required'); return; }
        try {
          var resp = await fetch((D.agent.base || '') + '/api/github/file-issue', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
          });
          var data = await resp.json();
          if (resp.status === 202) { D.toast('Queued (GitHub temporary error) — will retry'); }
          else if (data.url) { D.toast('Filed · ' + data.url); }
          else { D.toast('File failed: ' + (data.error || resp.status)); }
          bd.remove();
        } catch (e) { D.toast('File failed: ' + e.message); }
      });
    }
  };

  // ====================================================================
  // Snapshot / draft merge helpers
  // ====================================================================
  function mergeOneSnapshot(snap) {
    if (!snap || !snap.id) return;
    var local = D.store.get(SNAP_KEY, []);
    if (local.some(function (s) { return s.id === snap.id; })) return;
    local.unshift(snap);
    if (local.length > MAX_LOCAL_SNAPSHOTS) local.length = MAX_LOCAL_SNAPSHOTS;
    D.store.set(SNAP_KEY, local);
    if (snap.seq > D.state.capturedSnapshotCount) D.state.capturedSnapshotCount = snap.seq;
  }
  function mergeOneDraft(draft) {
    if (!draft || !draft.id) return;
    var local = D.store.get(DRAFT_KEY, []);
    if (local.some(function (d) { return d.id === draft.id; })) return;
    local.unshift(draft);
    if (local.length > MAX_LOCAL_DRAFTS) local.length = MAX_LOCAL_DRAFTS;
    D.store.set(DRAFT_KEY, local);
    document.dispatchEvent(new CustomEvent('devops:draft-changed'));
  }

  // Replaces an existing draft by id (e.g. when enrichment lands) or merges as new.
  function replaceDraftInPlace(draft) {
    if (!draft || !draft.id) return;
    var local = D.store.get(DRAFT_KEY, []);
    var idx = local.findIndex(function (d) { return d.id === draft.id; });
    if (idx >= 0) { local[idx] = draft; D.store.set(DRAFT_KEY, local); document.dispatchEvent(new CustomEvent('devops:draft-changed')); }
    else mergeOneDraft(draft);
  }

  // ====================================================================
  // Brand pill — reflect brain state
  // ====================================================================
  function updateBrandPill() {
    var pill = document.querySelector('.brand .status-pill');
    if (!pill) return;
    if (!D.brain.online || !D.brain.status) {
      // Leave agent-client.js's existing pill alone (AGENT ONLINE or OFFLINE).
      return;
    }
    var dot = pill.querySelector('.pulse-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'pulse-dot';
      pill.insertBefore(dot, pill.firstChild);
    }
    // Recolor based on state
    var sentinelCount = (D.brain.status.sentinels || []).filter(function (s) {
      return s.state === 'watching' || s.state === 'sampling' || s.state === 'running';
    }).length;
    var thr = !!D.brain.status.throttled;
    pill.innerHTML = '';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(thr ? 'BRAIN THROTTLED' : 'BRAIN ACTIVE'));
    if (thr) {
      pill.style.background = 'rgba(245,158,11,0.14)';
      pill.style.borderColor = 'rgba(245,158,11,0.3)';
      pill.style.color = '#fcd34d';
      dot.style.background = 'var(--accent-amber)';
      dot.style.animation = 'pulse 1.8s ease-out infinite';
    } else {
      pill.style.background = 'rgba(16,185,129,0.14)';
      pill.style.borderColor = 'rgba(16,185,129,0.3)';
      pill.style.color = '#6ee7b7';
      dot.style.background = 'var(--accent-emerald)';
      dot.style.animation = 'pulse 1.8s ease-out infinite';
    }
    pill.title = 'Brain: ' + sentinelCount + ' active sentinel(s) · CPU ' + (D.brain.status.cpuPercent || 0) + '% · workspace ' + (D.brain.status.workspaceRoot || '');
  }

  // ====================================================================
  // Notifications popover — replace mocks with live brain events
  // ====================================================================
  function refreshNotifPopover() {
    var pop = document.getElementById('notifPopover');
    if (!pop) return;
    if (!D.brain.online) return;

    // Preserve the popover's existing header (with Mark all read).
    var header = pop.querySelector('.pop-section-label, .row');
    var headerHtml = header ? header.outerHTML : '<div class="pop-section-label">Recent activity</div>';

    var events = D.brain.activity.slice(0, 12);
    var rows;
    if (!events.length) {
      rows = '<div style="padding: 14px 12px; font-size: 12px; color: var(--text-meta); text-align: center;">No activity yet · brain is listening.</div>';
    } else {
      rows = events.map(function (evt) {
        var levelClass = ({ ok: 'ok', warn: 'warn', error: 'err' })[evt.level] || '';
        var when = new Date(evt.ts).toLocaleTimeString();
        return '<div class="notif-item">' +
          '<div class="notif-dot ' + levelClass + '"></div>' +
          '<div style="flex:1; min-width:0;">' +
            '<div class="ttl">' + D.escapeHtml(evt.source || 'brain') + '</div>' +
            '<div class="body">' + D.escapeHtml(evt.message || '') + '</div>' +
            '<div class="when">' + when + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Add a "Run scan now" button + activity log footer
    var actions =
      '<div class="pop-divider"></div>' +
      '<button class="pop-item" data-brain-scan>' +
        '<div class="gl" style="background: rgba(99,102,241,0.18); color: var(--accent-indigo);">▶</div>' +
        '<div style="flex:1; min-width:0;">' +
          '<div>Run scheduled scan now</div>' +
          '<div class="pt">Context-Snap + dep registry audit</div>' +
        '</div>' +
      '</button>';

    pop.innerHTML = headerHtml + rows + actions;

    var scanBtn = pop.querySelector('[data-brain-scan]');
    if (scanBtn) {
      scanBtn.addEventListener('click', function () {
        pop.classList.remove('open');
        D.toast('Triggering manual scan…');
        D.brain.runScanNow().then(function (r) {
          if (r && typeof r.outdatedCount === 'number') {
            D.toast('Scan complete · ' + r.outdatedCount + ' outdated' +
                    (r.depMap && r.depMap.totalDeps ? ' / ' + r.depMap.totalDeps + ' deps' : ''));
          }
        }).catch(function (e) { D.toast('Scan failed: ' + e.message); });
      });
    }
  }

  // ====================================================================
  // Settings → push to brain
  // ====================================================================
  // Map from a Settings row-title to the brain settings key it controls.
  // When the matching control changes, we POST { <brainKey>: <newValue> }.
  var SETTINGS_MAP = [
    { selector: '#s-watchers',  rowTitle: 'Auto-snapshot on branch switch', brainKey: 'gitSentinel',   type: 'switch' },
    { selector: '#s-watchers',  rowTitle: 'Pin log errors automatically',   brainKey: 'logWatchdog',   type: 'switch' },
    { selector: '#s-watchers',  rowTitle: 'Watched log paths',              brainKey: 'watchedLogPaths', type: 'list' },
    { selector: '#s-watchers',  rowTitle: 'Scheduled scan',                 brainKey: 'scheduledScanTime', type: 'text' },
    { selector: '#s-resources', rowTitle: 'CPU ceiling',                    brainKey: 'cpuCeiling',    type: 'range' },
    { selector: '#s-agent',     rowTitle: 'Launch at boot',                 brainKey: 'agentEnabled',  type: 'switch' },

    // Phase 5: s-ai panel — bound by data-* selector since markup uses data-llm-* hooks.
    { dataAttr: 'llm-enrich-toggle',   brainKey: 'aiEnrichDrafts', type: 'switch' },
    { dataAttr: 'gh-autofile-toggle',  brainKey: 'autoFileGitHub', type: 'switch' },
    { dataAttr: 'llm-cap',             brainKey: 'dailyLLMCap',    type: 'range' },
    { dataAttr: 'llm-endpoint',        brainKey: 'llmEndpoint',    type: 'text' },
    { dataAttr: 'llm-model',           brainKey: 'llmModel',       type: 'select' },
    { dataAttr: 'llm-redact',          brainKey: 'extraRedactPatterns', type: 'text' },
    { dataAttr: 'gh-owner',            brainKey: 'defaultRepoOwner', type: 'text' },
    { dataAttr: 'gh-repo',             brainKey: 'defaultRepoName',  type: 'text' }
  ];

  function findControl(spec) {
    if (spec.dataAttr) return document.querySelector('[data-' + spec.dataAttr + ']');
    var section = document.querySelector(spec.selector);
    if (!section) return null;
    var rows = section.querySelectorAll('.row-item');
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].querySelector('.row-title');
      if (!t) continue;
      var title = (t.textContent || '').replace(/\s+/g, ' ').trim();
      if (title === spec.rowTitle) {
        if (spec.type === 'switch') return rows[i].querySelector('input[type="checkbox"]');
        if (spec.type === 'range')  return rows[i].querySelector('input[type="range"]');
        if (spec.type === 'text' || spec.type === 'list') return rows[i].querySelector('input[type="text"], textarea');
        if (spec.type === 'select') return rows[i].querySelector('select');
      }
    }
    return null;
  }

  function readControl(spec, el) {
    if (spec.type === 'switch') return !!el.checked;
    if (spec.type === 'range')  return Number(el.value);
    if (spec.type === 'list')   return el.value.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    return el.value;
  }

  function wireSettingsBridge() {
    if (!D.brain.online) return;
    var mapped = SETTINGS_MAP.map(function (spec) {
      var el = findControl(spec);
      return { spec: spec, el: el };
    }).filter(function (m) { return !!m.el; });

    // Push current values once so brain starts with the UI's view of truth.
    var initial = {};
    mapped.forEach(function (m) { initial[m.spec.brainKey] = readControl(m.spec, m.el); });
    if (Object.keys(initial).length) {
      D.brain.pushSettings(initial);
    }

    // Wire change listeners
    mapped.forEach(function (m) {
      var evType = (m.spec.type === 'range' || m.spec.type === 'text' || m.spec.type === 'list') ? 'input' : 'change';
      m.el.addEventListener(evType, function () {
        var payload = {};
        payload[m.spec.brainKey] = readControl(m.spec, m.el);
        D.brain.pushSettings(payload);
      });
    });
  }

  // ====================================================================
  // Bootstrap
  // ====================================================================
  function init() {
    // Wait until agent-client has done its detection. agent-client dispatches
    // 'devops:agent-online' / 'devops:agent-offline'. If we missed the event
    // (race), poll for D.agent.online once.
    if (D.agent && D.agent.online) {
      go();
    } else {
      document.addEventListener('devops:agent-online', go, { once: true });
      // Also poll briefly in case agent-client races
      setTimeout(function () { if (!D.brain.online && D.agent && D.agent.online) go(); }, 800);
    }
  }

  function go() {
    D.brain.detect().then(function (ok) {
      if (!ok) return;
      D.brain.syncBacklog().then(function (counts) {
        if (counts.snapshots || counts.drafts) {
          D.toast('Brain sync · ' + counts.snapshots + ' snapshot(s), ' + counts.drafts + ' draft(s) pulled');
        }
      });
      D.brain.openStream();
      updateBrandPill();
      refreshNotifPopover();
      wireSettingsBridge();
      wireAIPanel();
    });
  }

  function wireAIPanel() {
    var seg = document.querySelector('[data-llm-provider]');
    if (seg) {
      seg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          seg.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          D.brain.pushSettings({ llmProvider: b.getAttribute('data-val') });
          loadModels();
        });
      });
    }
    function loadModels() {
      if (!D.brain.online) return;
      fetch((D.agent.base || '') + '/api/llm/models').then(function (r) { return r.json(); }).then(function (j) {
        var sel = document.querySelector('[data-llm-model]');
        if (sel) sel.innerHTML = (j.models || []).map(function (m) { return '<option>' + D.escapeHtml(m) + '</option>'; }).join('');
      }).catch(function () {});
    }
    loadModels();

    var saveKeyBtn = document.querySelector('[data-llm-save-key]');
    if (saveKeyBtn) saveKeyBtn.addEventListener('click', function () {
      var input = document.querySelector('[data-llm-apikey]');
      var seg2 = document.querySelector('[data-llm-provider] .seg-btn.active');
      var provider = seg2 ? seg2.getAttribute('data-val') : 'ollama';
      fetch((D.agent.base || '') + '/api/llm/key', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: provider, apiKey: input.value })
      }).then(function (r) { return r.json(); }).then(function () { input.value = ''; D.toast('Key saved'); });
    });

    var testBtn = document.querySelector('[data-llm-test]');
    if (testBtn) testBtn.addEventListener('click', function () {
      var pill = document.querySelector('[data-llm-test-pill]');
      if (pill) pill.textContent = 'testing…';
      fetch((D.agent.base || '') + '/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (pill) { pill.textContent = j.ok ? ('● ' + j.latencyMs + ' ms') : ('error: ' + j.error); pill.className = 'badge ' + (j.ok ? 'ok' : 'err'); }
        });
    });

    var savePATBtn = document.querySelector('[data-gh-save-pat]');
    if (savePATBtn) savePATBtn.addEventListener('click', function () {
      var input = document.querySelector('[data-gh-pat]');
      fetch((D.agent.base || '') + '/api/github/pat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: input.value }) })
        .then(function () { input.value = ''; D.toast('PAT saved'); });
    });

    var capRange = document.querySelector('[data-llm-cap]');
    var capPill = document.querySelector('[data-llm-cap-pill]');
    if (capRange && capPill) {
      var update = function () { capPill.textContent = capRange.value + ' / day'; };
      capRange.addEventListener('input', update); update();
    }

    var audView = document.querySelector('[data-audit-view]');
    if (audView) audView.addEventListener('click', function () {
      fetch((D.agent.base || '') + '/api/agent/audit?limit=200').then(function (r) { return r.json(); }).then(function (j) {
        var rows = j.records.map(function (r) {
          return '<tr><td>' + new Date(r.ts).toLocaleString() + '</td><td>' + D.escapeHtml(r.kind) + '</td><td>' + D.escapeHtml(r.feature || '') + '</td><td>' + D.escapeHtml(r.outcome) + '</td></tr>';
        }).join('');
        D.confirmAction('Audit log · ' + j.records.length + ' records',
          '<div style="max-height:60vh;overflow:auto;"><table class="data" style="width:100%;"><thead><tr><th>Time</th><th>Kind</th><th>Feature</th><th>Outcome</th></tr></thead><tbody>' + rows + '</tbody></table></div>',
          null);
        var ok = document.querySelector('#confirmModal [data-c-ok]'); if (ok) ok.style.display = 'none';
      });
    });

    var audExp = document.querySelector('[data-audit-export]');
    if (audExp) audExp.addEventListener('click', function () {
      window.open((D.agent.base || '') + '/api/agent/audit/export?format=jsonl', '_blank');
    });

    var audVer = document.querySelector('[data-audit-verify]');
    if (audVer) audVer.addEventListener('click', function () {
      fetch((D.agent.base || '') + '/api/agent/audit/verify').then(function (r) { return r.json(); }).then(function (j) {
        D.toast(j.ok ? ('Chain verified · ' + j.recordsVerified + ' records') : ('Chain broken at ' + j.brokenAt));
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
