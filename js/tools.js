/* DevOps Dashboard — per-tool wiring.
   Specific behaviors per view (Context-Snap, Docs Scraper, Dep Map, Log-Tail, Issue Filler),
   plus Settings/Help/Profile/Login button bindings and the catch-all toast fallback. */

(function () {
  var D = window.DevOps;
  if (!D || !D.bindByText) { console.error('[DevOps] tools.js needs core.js + ui.js loaded first'); return; }

  // --------- Context-Snap ---------
  function captureSnapshot(label) {
    D.state.capturedSnapshotCount++;
    var name = label || ('snapshot-' + String(D.state.capturedSnapshotCount).padStart(2, '0'));
    D.toast('Snapshot captured · saved as ' + name);
    var stat = document.querySelector('#view-context-snap .stats .stat-value');
    if (stat && /^\d+$/.test(stat.textContent.trim())) stat.textContent = D.state.capturedSnapshotCount;
  }
  D.bindByText('#view-context-snap', 'Capture context', function () { captureSnapshot(); });
  D.bindByText('#view-context-snap', 'Snapshot now', function () { captureSnapshot(); });
  D.bindByText('#view-context-snap', 'Restore snapshot', function () { D.toast('Browse snapshots to restore'); });
  D.bindByText('#view-context-snap', 'Copy', function () { D.toast('Copied to clipboard'); });
  D.bindByText('#view-context-snap', 'Export', function () { D.toast('Exported · ~/Downloads/snapshot-04.snap'); });

  // --------- Docs Scraper ---------
  D.bindByText('#view-docs-scraper', 'Fetch Document', function () {
    var input = document.querySelector('#view-docs-scraper input[type="text"]');
    if (input && !input.value.trim()) { D.toast('Enter a URL first'); input.focus(); return; }
    D.toast('Fetch blocked by air-gap · add host to allowlist');
  });
  D.bindByText('#view-docs-scraper', 'Browse cache', function () { D.toast('142 cached docs · 18.4 MB'); });
  D.bindByText('#view-docs-scraper', 'History', function () { D.toast('No recent fetches in this session'); });

  // Quick-target badges: empty "+ add" prompts to open allowlist, dot/slash hosts fill the URL field.
  document.querySelectorAll('#view-docs-scraper .badge').forEach(function (b) {
    var t = b.textContent.trim();
    if (t.indexOf('+ add') !== -1) {
      b.style.cursor = 'pointer';
      b.addEventListener('click', function () { D.toast('Open allowlist to add a target'); });
    } else if (t.indexOf('.') !== -1 || t.indexOf('/') !== -1) {
      b.style.cursor = 'pointer';
      b.addEventListener('click', function () {
        var input = document.querySelector('#view-docs-scraper input[type="text"]');
        if (input) { input.value = 'https://' + t; input.focus(); }
      });
    }
  });

  // Tree items select.
  document.querySelectorAll('#view-docs-scraper .tree-item').forEach(function (item) {
    item.addEventListener('click', function () {
      document.querySelectorAll('#view-docs-scraper .tree-item').forEach(function (x) { x.classList.remove('selected'); });
      item.classList.add('selected');
    });
  });

  // --------- Dependency Map ---------
  D.bindByText('#view-dep-map', 'Re-scan', function () {
    D.toast('Re-scanning manifest…');
    setTimeout(function () { D.toast('Scan complete · 147 deps · 12 outdated · 3 CVEs'); }, 900);
  });
  D.bindByText('#view-dep-map', 'Inspect tree', function () { D.toast('Dependency tree view coming up'); });

  var depFilter = document.querySelector('#view-dep-map .header-search input[placeholder*="Filter packages"]');
  if (depFilter) {
    depFilter.addEventListener('input', function () {
      var q = depFilter.value.toLowerCase().trim();
      document.querySelectorAll('#view-dep-map table.data tbody tr').forEach(function (row) {
        var match = !q || row.textContent.toLowerCase().indexOf(q) !== -1;
        row.style.display = match ? '' : 'none';
      });
    });
  }

  var dz = document.querySelector('#view-dep-map .dropzone');
  if (dz) dz.addEventListener('click', function () { D.toast('Pick a manifest from disk'); });

  // --------- Log-Tail ---------
  D.bindByText('#view-log-tail', 'Pause tail', function (btn) {
    D.state.tailPaused = !D.state.tailPaused;
    btn.querySelector('svg').innerHTML = D.state.tailPaused
      ? '<polygon points="6 4 20 12 6 20 6 4"/>'
      : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    btn.lastChild.textContent = ' ' + (D.state.tailPaused ? 'Resume tail' : 'Pause tail');
    var pill = document.querySelector('#view-log-tail .badge.ok');
    if (pill) {
      pill.style.opacity = D.state.tailPaused ? '0.6' : '1';
      pill.lastChild.textContent = ' ' + (D.state.tailPaused ? 'Tail paused' : 'Tailing live');
    }
    D.toast(D.state.tailPaused ? 'Tail paused' : 'Tail resumed');
  });
  D.bindByText('#view-log-tail', 'Export filtered', function () { D.toast('Exported 168 filtered lines'); });

  var logFilter = document.querySelector('#view-log-tail input[placeholder*="Filter"]');
  if (logFilter) {
    logFilter.addEventListener('input', function () {
      var q = logFilter.value.toLowerCase().trim();
      document.querySelectorAll('#view-log-tail .term-line').forEach(function (line) {
        var match = !q || line.textContent.toLowerCase().indexOf(q) !== -1;
        line.style.display = match ? '' : 'none';
      });
    });
  }

  // Card-header icons in Log-Tail: [0]=wrap, [1]=clear.
  var logIcons = document.querySelectorAll('#view-log-tail .card-header .icon-btn');
  if (logIcons[0]) {
    logIcons[0].addEventListener('click', function () {
      var term = document.querySelector('#view-log-tail .terminal');
      if (!term) return;
      var wrap = term.style.whiteSpace === 'pre-wrap';
      term.style.whiteSpace = wrap ? '' : 'pre-wrap';
      document.querySelectorAll('#view-log-tail .term-line').forEach(function (l) {
        l.style.whiteSpace = wrap ? '' : 'pre-wrap';
      });
      D.toast(wrap ? 'Lines no longer wrapped' : 'Lines wrapped to width');
    });
  }
  if (logIcons[1]) {
    logIcons[1].addEventListener('click', function () {
      D.confirmAction(
        'Clear log view?',
        'This hides all currently buffered lines. New incoming lines will continue to appear.',
        function () {
          document.querySelectorAll('#view-log-tail .term-line').forEach(function (l) { l.style.display = 'none'; });
          D.toast('Log view cleared');
        }
      );
    });
  }

  // --------- Issue Template Filler ---------
  function paintWizard() {
    var steps = document.querySelectorAll('#view-issue-filler .wizard-step');
    steps.forEach(function (s, i) {
      s.classList.remove('active', 'done');
      if (i < D.state.wizardStepIdx) s.classList.add('done');
      else if (i === D.state.wizardStepIdx) s.classList.add('active');
      var num = s.querySelector('.num');
      if (num) num.textContent = (i < D.state.wizardStepIdx) ? '✓' : String(i + 1);
    });
  }
  document.querySelectorAll('#view-issue-filler .wizard-step').forEach(function (s, i) {
    s.addEventListener('click', function () { D.state.wizardStepIdx = i; paintWizard(); });
  });
  D.bindByText('#view-issue-filler', 'Continue →', function () {
    var steps = document.querySelectorAll('#view-issue-filler .wizard-step');
    D.state.wizardStepIdx = Math.min(D.state.wizardStepIdx + 1, steps.length - 1);
    paintWizard();
  });
  D.bindByText('#view-issue-filler', '← Back', function () {
    D.state.wizardStepIdx = Math.max(D.state.wizardStepIdx - 1, 0);
    paintWizard();
  });
  D.bindByText('#view-issue-filler', 'File issue', function () { D.toast('Issue saved to drafts · ~/.devops-local/drafts/'); });
  D.bindByText('#view-issue-filler', 'Switch template', function () { D.toast('Templates: Bug · Feature · RFC · Performance'); });
  D.bindByText('#view-issue-filler', 'Copy', function () { D.toast('Markdown copied to clipboard'); });

  // --------- Settings ---------
  D.bindByText('#view-settings', 'Save changes', function () { D.toast('Settings saved'); });
  D.bindByText('#view-settings', 'Discard', function () { D.toast('Discarded unsaved changes'); });
  D.bindByText('#view-settings', 'Pause', function () { D.toast('Agent paused'); });
  D.bindByText('#view-settings', 'Restart', function () { D.toast('Agent restarted'); });
  D.bindByText('#view-settings', 'Edit list', function () { D.toast('Open Watched paths editor'); });
  D.bindByText('#view-settings', 'Reveal', function () { D.toast('Revealed ~/.devops-local in Finder'); });
  D.bindByText('#view-settings', 'Change…', function () { D.toast('Pick a new data directory'); });
  D.bindByText('#view-settings', 'Erase…', function () {
    D.confirmAction(
      'Erase all local data?',
      'This will permanently delete <strong>14 snapshots</strong>, <strong>142 cached docs</strong>, and all pinned errors from <code class="md-code-inline">~/.devops-local</code>. Settings will be preserved. <br><br><span style="color:#fca5a5;">This cannot be undone.</span>',
      function () { D.toast('All local data erased'); }
    );
  });
  D.bindByText('#view-settings', 'Edit allowlist', function () { D.toast('4 allowlisted hosts · open editor'); });
  D.bindByText('#view-settings', 'Edit patterns', function () { D.toast('12 secret-mask patterns active'); });
  D.bindByText('#view-settings', 'Rotate now', function () {
    D.confirmAction(
      'Rotate local encryption key?',
      'All <strong>14 snapshots</strong> will be re-encrypted in place. The operation runs in the background and takes ~30 seconds. You may continue using the app.',
      function () { D.toast('Key rotation started · 14 snapshots queued'); }
    );
  });
  D.bindByText('#view-settings', 'Override path', function () { D.toast('Pick a binary from disk'); });
  D.bindByText('#view-settings', 'Browse…', function () { D.toast('Locate cargo binary'); });
  D.bindByText('#view-settings', 'Check now', function () { D.toast('Already up to date · 0.4.2 is current'); });
  D.bindByText('#view-settings', 'Check for offline updates…', function () { D.toast('No update package found at ~/Downloads/devops-local-*.dmg'); });
  D.bindByText('#view-settings', 'Release notes', function () {
    D.activate('help');
    setTimeout(function () { D.scrollWorkspaceTo('[data-help-block="footer-grid"]'); }, 80);
  });
  D.bindByText('#view-settings', 'View licenses', function () { D.toast('184 third-party licenses · open viewer'); });
  D.bindByText('#view-settings', 'Copy diagnostics', function () { D.toast('Diagnostics copied to clipboard'); });
  D.bindByText('#view-settings', 'Open binding editor', function () { D.toast('Binding editor coming up…'); });

  // --------- Help ---------
  D.bindByText('#view-help', 'Open docs site', function () { D.toast('Air-gap mode blocks external links · disable to open'); });
  D.bindByText('#view-help', 'Contact support', function () { D.toast('support@devops-local copied to clipboard'); });
  D.bindByText('#view-help', 'Copy', function () { D.toast('Diagnostics copied to clipboard'); });

  // --------- Profile modal extras ---------
  D.bindByText('#profileModal', 'Upload photo', function () { D.toast('Pick a photo from disk'); });
  D.bindByText('#profileModal', 'Remove', function () {
    var av = document.querySelector('#profileModal .avatar-lg');
    if (av) { av.textContent = '?'; av.style.background = 'var(--bg-elevated)'; av.style.color = 'var(--text-meta)'; }
    D.toast('Avatar cleared');
  });

  // --------- Login extras ---------
  var recovery = document.querySelector('.login-card a[href="#"]');
  if (recovery) recovery.addEventListener('click', function (e) { e.preventDefault(); D.toast('Recovery requires your offline key file'); });
  document.querySelectorAll('.login-foot a[href="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      D.toast(a.textContent.trim() + ' opens in the bundled docs viewer');
    });
  });

  // --------- Fallback toast for any remaining unwired button ---------
  document.querySelectorAll('.btn, .icon-btn').forEach(function (b) {
    if (b.getAttribute('data-wired') === '1') return;
    var skipIds = ['profileTrigger', 'signOutBtn', 'workspaceSwitch', 'notifBtn', 'paletteBtn', 'markReadBtn'];
    if (skipIds.indexOf(b.id) !== -1) return;
    if (b.classList.contains('nav-item') || b.classList.contains('seg-btn') ||
        b.classList.contains('settings-rail-item') || b.classList.contains('wizard-step') ||
        b.classList.contains('pop-item') || b.classList.contains('palette-item') ||
        b.classList.contains('login-recent') || b.classList.contains('help-tile')) return;
    if (b.hasAttribute('data-close-modal') || b.classList.contains('close-btn')) return;
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', function () {
      var label = b.getAttribute('title') || b.textContent.replace(/\s+/g, ' ').trim() || 'Action';
      if (label.length > 40) label = label.slice(0, 40) + '…';
      D.toast(label);
    });
  });

  // Repaint wizard at initial state.
  paintWizard();
})();
