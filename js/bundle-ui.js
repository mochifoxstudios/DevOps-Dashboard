/* Wires the Settings → Storage "Export backup" / "Import backup…" buttons to the
   universal .dvops.json bundle (js/bundle.js). Export gathers every live devops:*
   key; Import validates the shape and CONFIRMS before overwriting, then reloads. */
(function () {
  var D = window.DevOps;
  if (!D || !D.bundle) return;
  var section = document.getElementById('s-storage');
  if (!section) return;

  function exportAll() {
    var data = {};
    (D.store.keys() || []).forEach(function (k) {
      var raw = localStorage.getItem(k);
      if (raw != null) data[k] = raw;
    });
    if (!Object.keys(data).length) { D.toast('Nothing to export yet — use the app a little first'); return; }
    var stamp = new Date().toISOString();
    var bundle = D.bundle.buildBundle(data, stamp);
    var name = 'devops-backup-' + stamp.replace(/[:.]/g, '-').slice(0, 19) + '.dvops.json';
    var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    D.toast('Exported ' + Object.keys(data).length + ' keys → ' + name);
  }

  function applyBundle(r) {
    Object.keys(r.bundle.data).forEach(function (k) {
      if (k.indexOf('devops:') !== 0) return; // never write non-namespaced keys
      try { localStorage.setItem(k, r.bundle.data[k]); } catch (e) {}
    });
    D.toast('Restored ' + r.keyCount + ' keys · reloading…');
    setTimeout(function () { location.reload(); }, 700);
  }

  function importBundle(text) {
    var r = D.bundle.parse(text);
    if (!r.ok) { D.toast('Import failed: ' + r.error); return; }
    D.confirmAction(
      'Restore backup?',
      'This overwrites <strong>' + r.keyCount + '</strong> stored key' + (r.keyCount === 1 ? '' : 's') +
        ' (workspaces, profile, settings, snapshots, drafts, appearance) with the contents of this file. Your current data will be replaced.',
      function () { applyBundle(r); }
    );
  }

  function pickAndImport() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.remove();
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { importBundle(String(fr.result || '')); };
      fr.onerror = function () { D.toast('Could not read the file'); };
      fr.readAsText(f);
    });
    input.click();
  }

  var eb = section.querySelector('[data-bundle-export]');
  if (eb) { eb.setAttribute('data-wired', '1'); eb.addEventListener('click', exportAll); }
  var ib = section.querySelector('[data-bundle-import]');
  if (ib) { ib.setAttribute('data-wired', '1'); ib.addEventListener('click', pickAndImport); }
})();
