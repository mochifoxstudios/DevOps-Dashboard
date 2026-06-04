/* Universal dashboard backup bundle (.dvops.json). Pure, dual-mode (browser
   window.DevOps.bundle + node require) so the shape logic is unit-tested.
   A bundle wraps every devops:* localStorage key so a whole dashboard (workspaces,
   profile, settings, snapshots, doc-cache, drafts, appearance) moves in one file —
   the local-first / air-gapped backup-and-migrate story. Import MUST validate the
   shape and confirm before overwriting. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.DevOps = root.DevOps || {}; root.DevOps.bundle = api; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var FORMAT = 'dvops-bundle';
  var VERSION = 1;

  function buildBundle(data, exportedAt) {
    return { format: FORMAT, version: VERSION, exportedAt: exportedAt || null, data: data || {} };
  }

  function validate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'Not a bundle object' };
    if (obj.format !== FORMAT) return { ok: false, error: 'Not a DevOps Local backup (wrong format tag)' };
    if (typeof obj.version !== 'number') return { ok: false, error: 'Bundle is missing a version' };
    if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) return { ok: false, error: 'Bundle has no data object' };
    var keys = Object.keys(obj.data).filter(function (k) { return k.indexOf('devops:') === 0; });
    if (!keys.length) return { ok: false, error: 'Bundle contains no devops:* keys' };
    return { ok: true, keyCount: keys.length, keys: keys };
  }

  function parse(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: 'Invalid JSON' }; }
    var v = validate(obj);
    if (!v.ok) return v;
    return { ok: true, bundle: obj, keyCount: v.keyCount, keys: v.keys };
  }

  return { FORMAT: FORMAT, VERSION: VERSION, buildBundle: buildBundle, validate: validate, parse: parse };
});
