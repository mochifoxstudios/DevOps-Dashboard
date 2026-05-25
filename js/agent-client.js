/* DevOps Dashboard — agent client.
   Detects whether the local backend agent (./agent/server.js) is reachable on
   the same origin, and exposes a small client API that engines can call
   instead of (or in addition to) their browser-only paths.

   Load order: after core.js, before features.js — so features.js can branch on
   DevOps.agent.online during its own initialization. */

(function () {
  var D = window.DevOps;
  if (!D) { console.error('[DevOps] agent-client.js needs core.js'); return; }

  var DETECT_TIMEOUT_MS = 1500;

  D.agent = {
    base: '',           // empty = same origin; can be overridden, e.g. http://localhost:3737
    online: false,
    info: null,         // last /api/health response
    detectedAt: null,
    error: null,

    setBase: function (url) { this.base = (url || '').replace(/\/$/, ''); },

    detect: function () {
      var self = this;
      // AbortSignal.timeout is supported in modern browsers; falls back to manual.
      var signal;
      try { signal = AbortSignal.timeout(DETECT_TIMEOUT_MS); }
      catch (e) {
        var c = new AbortController();
        setTimeout(function () { c.abort(); }, DETECT_TIMEOUT_MS);
        signal = c.signal;
      }
      return fetch(self.base + '/api/health', { signal: signal, cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          self.online = true;
          self.info = j;
          self.detectedAt = new Date().toISOString();
          self.error = null;
          document.dispatchEvent(new CustomEvent('devops:agent-online', { detail: j }));
          return j;
        })
        .catch(function (err) {
          self.online = false;
          self.info = null;
          self.error = err.message || String(err);
          document.dispatchEvent(new CustomEvent('devops:agent-offline', { detail: { reason: self.error } }));
          return null;
        });
    },

    // ---- Context-Snap ----
    captureSnapshot: function (includes) {
      return this._post('/api/context-snap/capture', { includes: includes || {} });
    },
    getEnv: function (full) { return this._get('/api/context-snap/env' + (full ? '?full=1' : '')); },
    getProcesses: function () { return this._get('/api/context-snap/processes'); },
    getGit: function () { return this._get('/api/context-snap/git'); },
    getPorts: function () { return this._get('/api/context-snap/ports'); },

    // ---- Log-Tail ----
    findLogs: function (opts) {
      var qs = [];
      if (opts && opts.exts) qs.push('exts=' + encodeURIComponent(opts.exts.join(',')));
      if (opts && opts.max)  qs.push('max=' + opts.max);
      return this._get('/api/log-tail/find' + (qs.length ? '?' + qs.join('&') : ''));
    },
    fetchLogBackfill: function (filePath, bytes) {
      var qs = 'path=' + encodeURIComponent(filePath);
      if (bytes) qs += '&bytes=' + bytes;
      return this._get('/api/log-tail/file?' + qs);
    },
    // ---- Phase 3: Dep Map registry ----
    lookupDeps: function (ecosystem, packages, opts) {
      return this._post('/api/dep-map/lookup', Object.assign({ ecosystem: ecosystem, packages: packages || [] }, opts || {}));
    },

    // ---- Phase 3: Docs Scraper proxy ----
    scraperConfig: function () { return this._get('/api/scraper/config'); },
    scrapeUrl: function (url, as) {
      return this._post('/api/scraper/fetch', { url: url, as: as || 'auto' });
    },

    /* Opens an SSE stream for `filePath` and returns the EventSource. Caller
       must invoke .close() when done to release the watcher. */
    openLogStream: function (filePath, handlers) {
      if (!this.online) throw new Error('agent offline');
      var url = this.base + '/api/log-tail/stream?path=' + encodeURIComponent(filePath);
      var es = new EventSource(url);
      var h = handlers || {};
      ['open', 'line', 'rotated', 'truncated', 'unlink', 'error'].forEach(function (evt) {
        es.addEventListener(evt, function (e) {
          var data; try { data = JSON.parse(e.data); } catch (_) { data = { raw: e.data }; }
          if (typeof h[evt] === 'function') h[evt](data);
        });
      });
      // Network-level error (different from server-emitted 'error' event).
      es.onerror = function (e) {
        if (typeof h.disconnect === 'function') h.disconnect(e);
      };
      return es;
    },

    // ---- Generic HTTP helpers ----
    _get: function (p) {
      if (!this.online) return Promise.reject(new Error('agent offline'));
      return fetch(this.base + p, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); }, function () { throw new Error('HTTP ' + r.status); });
          return r.json();
        });
    },
    _post: function (p, body, headers) {
      if (!this.online) return Promise.reject(new Error('agent offline'));
      var hdrs = Object.assign({ 'content-type': 'application/json' }, headers || {});
      return fetch(this.base + p, { method: 'POST', cache: 'no-store', headers: hdrs, body: JSON.stringify(body || {}) })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); }, function () { throw new Error('HTTP ' + r.status); });
          return r.json();
        });
    }
  };

  // Detect on load and reflect status in the brand pill.
  function updateBrandPill () {
    var pill = document.querySelector('.brand .status-pill');
    if (!pill) return;
    var dot = pill.querySelector('.pulse-dot');
    if (D.agent.online && D.agent.info) {
      pill.style.background = 'rgba(16, 185, 129, 0.14)';
      pill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      pill.style.color = '#6ee7b7';
      // Replace text, preserving the dot
      pill.innerHTML = '';
      if (dot) pill.appendChild(dot);
      else {
        var newDot = document.createElement('span');
        newDot.className = 'pulse-dot';
        pill.appendChild(newDot);
      }
      pill.appendChild(document.createTextNode('AGENT ONLINE · LOCAL'));
      pill.title = 'Local agent v' + D.agent.info.version + ' · workspace: ' + (D.agent.info.workspaceName || D.agent.info.workspaceRoot);
      pill.style.cursor = 'pointer';
    } else {
      // Leave the original "OFFLINE LOCAL MODE" alone.
      pill.style.cursor = 'pointer';
      pill.title = 'Agent not detected. Start it with: cd agent && npm start';
    }
  }

  function init () {
    D.agent.detect().then(updateBrandPill);
    // Click the brand pill to re-probe + show status dialog.
    var pill = document.querySelector('.brand .status-pill');
    if (pill) {
      pill.addEventListener('click', function () {
        D.toast('Probing agent…');
        D.agent.detect().then(function (info) {
          updateBrandPill();
          if (info) {
            D.confirmAction(
              'Local agent · v' + info.version,
              '<pre style="font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; margin: 0;">' +
              D.escapeHtml(JSON.stringify({
                version:        info.version,
                workspaceRoot:  info.workspaceRoot,
                platform:       info.platform,
                nodeVersion:    info.nodeVersion,
                uptimeSec:      info.uptimeSec,
                allowDestructive: info.allowDestructive
              }, null, 2)) +
              '</pre>',
              null
            );
            // Hide the Confirm button since this is informational.
            var ok = document.querySelector('#confirmModal [data-c-ok]');
            if (ok) ok.style.display = 'none';
          } else {
            D.toast('Agent offline: ' + (D.agent.error || 'unreachable'));
          }
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
