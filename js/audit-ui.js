/* Audit Log UI — surfaces the agent's tamper-evident, hash-chained audit ledger
   (the compliance differentiator) as a discoverable Settings → Audit Log section.
   Loads after brain-client.js. Gates cleanly to an empty state when the agent is
   offline (Modes 1-2). Endpoints: /api/agent/audit, /audit/verify, /audit/export. */
(function () {
  var D = window.DevOps;
  if (!D) return;
  var section = document.getElementById('s-audit');
  if (!section) return;

  var statusEl = section.querySelector('[data-audit-status]');
  var tableEl = section.querySelector('[data-audit-table]');
  function base() { return (D.agent && D.agent.base) || ''; }
  function online() { return !!(D.agent && D.agent.online); }
  function esc(s) { return D.escapeHtml(String(s == null ? '' : s)); }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.className = 'badge' + (kind ? ' ' + kind : '');
    statusEl.textContent = text;
  }

  function offlineState() {
    setStatus('agent offline', '');
    if (tableEl) tableEl.innerHTML = '<div class="empty-state es-sub" style="padding:10px;">Start the local agent (Mode 3) to view and verify the audit log.</div>';
  }

  function renderRecords(records) {
    if (!tableEl) return;
    if (!records || !records.length) {
      tableEl.innerHTML = '<div class="empty-state es-sub" style="padding:10px;">No audit records yet — they appear as the Brain enriches drafts, narrates diffs, or files issues.</div>';
      return;
    }
    var rows = records.slice(-200).reverse().map(function (r) {
      var ok = r.outcome === 'ok' || r.outcome === 'success';
      var cost = (r.costCents != null && !isNaN(r.costCents)) ? '$' + (r.costCents / 100).toFixed(2) : '—';
      return '<tr>' +
        '<td><span class="ver dim">' + esc(r.ts ? new Date(r.ts).toLocaleString() : '—') + '</span></td>' +
        '<td>' + esc(r.kind || '') + '</td>' +
        '<td>' + esc(r.feature || '') + '</td>' +
        '<td><span class="badge ' + (ok ? 'ok' : (r.outcome ? 'warn' : '')) + '">' + esc(r.outcome || '—') + '</span></td>' +
        '<td><span class="ver dim">' + esc(cost) + '</span></td>' +
        '</tr>';
    }).join('');
    tableEl.innerHTML =
      '<input class="input" data-audit-filter type="text" placeholder="Filter records…" style="margin-bottom:8px;" />' +
      '<div style="max-height:280px; overflow:auto; border:1px solid var(--border); border-radius:var(--radius);">' +
      '<table class="data" style="width:100%;"><thead><tr><th>Time</th><th>Kind</th><th>Feature</th><th>Outcome</th><th>Cost</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
    var f = tableEl.querySelector('[data-audit-filter]');
    if (f) f.addEventListener('input', function () {
      var q = f.value.toLowerCase().trim();
      tableEl.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.style.display = (!q || tr.textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      });
    });
  }

  function loadRecords() {
    if (!online()) { offlineState(); return; }
    fetch(base() + '/api/agent/audit?limit=200').then(function (r) { return r.json(); })
      .then(function (j) { renderRecords(j.records || []); })
      .catch(function () { offlineState(); });
  }

  function verify() {
    if (!online()) { offlineState(); return; }
    setStatus('verifying…', '');
    fetch(base() + '/api/agent/audit/verify').then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) setStatus('chain intact · ' + (j.recordsVerified != null ? j.recordsVerified : '?') + ' records', 'ok');
        else setStatus('chain BROKEN' + (j && j.brokenAt ? ' @ ' + j.brokenAt : ''), 'err');
      })
      .catch(function () { setStatus('verify failed', 'err'); });
  }

  function refresh() { loadRecords(); verify(); }

  function exportAs(fmt) {
    if (!online()) { D.toast('Agent offline — cannot export the audit log'); return; }
    window.open(base() + '/api/agent/audit/export?format=' + fmt, '_blank');
  }

  var vbtn = section.querySelector('[data-audit-verify-btn]'); if (vbtn) vbtn.addEventListener('click', verify);
  var rbtn = section.querySelector('[data-audit-refresh]'); if (rbtn) rbtn.addEventListener('click', refresh);
  var ej = section.querySelector('[data-audit-export-jsonl]'); if (ej) ej.addEventListener('click', function () { exportAs('jsonl'); });
  var ec = section.querySelector('[data-audit-export-csv]'); if (ec) ec.addEventListener('click', function () { exportAs('csv'); });

  // Opt our buttons out of the tools.js catch-all toast.
  section.querySelectorAll('.btn').forEach(function (b) { b.setAttribute('data-wired', '1'); });

  document.addEventListener('devops:agent-online', refresh);
  document.addEventListener('devops:agent-offline', offlineState);
  if (online()) refresh(); else offlineState();

  D.auditUI = { refresh: refresh, verify: verify };
})();
