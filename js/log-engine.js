/* Pure log parsing + filtering logic — shared between the browser (Log-Tail
   tool) and node tests. Dual-mode: attaches to window.DevOps.logEngine in the
   browser AND exports via module.exports under node, so the SAME file is both a
   <script> and a `require()`-able unit. No DOM, no I/O — pure functions only. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.DevOps = root.DevOps || {}; root.DevOps.logEngine = api; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Classify a raw log line into a level used for row coloring + the level filter.
  function classifyLevel(line) {
    if (/\b(error|err|fatal|critical|exception)\b/i.test(line)) return 'err';
    if (/\b(warn|warning)\b/i.test(line)) return 'warn';
    if (/\b(debug|trace)\b/i.test(line)) return 'info';
    if (/\b(ok|success|done|started|listening)\b/i.test(line)) return 'ok';
    return 'info';
  }

  // Pull a leading timestamp (ISO, HH:MM:SS, or [bracketed]) if present.
  function extractTimestamp(line) {
    var m = line.match(/^\s*(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+\-]\d{2}:?\d{2})?)/)
         || line.match(/^\s*(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/)
         || line.match(/^\s*\[(\d[^\]]+)\]/);
    return m ? m[1] : '';
  }

  function parseLine(line) {
    return { raw: line, ts: extractTimestamp(line), level: classifyLevel(line), msg: line };
  }

  // Does a parsed line pass the active filter?
  //   opts.text    — substring (case-insensitive) or regex source
  //   opts.useRegex — treat opts.text as a regex (invalid regex falls back to substring)
  //   opts.level   — one of 'err'|'warn'|'ok'|'info'; 'all'/'' means no level filter
  function lineMatches(parsed, opts) {
    opts = opts || {};
    if (opts.level && opts.level !== 'all' && parsed.level !== opts.level) return false;
    var q = (opts.text || '').trim();
    if (!q) return true;
    var hay = parsed.raw != null ? String(parsed.raw) : String(parsed.msg || '');
    if (opts.useRegex) {
      try { return new RegExp(q, 'i').test(hay); }
      catch (e) { /* invalid regex → fall through to substring */ }
    }
    return hay.toLowerCase().indexOf(q.toLowerCase()) !== -1;
  }

  return { classifyLevel: classifyLevel, extractTimestamp: extractTimestamp, parseLine: parseLine, lineMatches: lineMatches };
});
