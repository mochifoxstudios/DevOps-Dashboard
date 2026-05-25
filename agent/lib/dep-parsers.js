/* Server-side manifest parsers — minimal mirrors of the frontend ones in
   js/features.js, used by the Scheduler so we don't have to round-trip parsing
   through the browser. Same name/current shape as features.js produces. */

const fs = require('node:fs');
const path = require('node:path');

const FORMAT_TO_ECOSYSTEM = {
  'package.json':     'npm',
  'requirements.txt': 'pip',
  'Pipfile':          'pip',
  'Cargo.toml':       'cargo',
  'go.mod':           'go',
  'Gemfile.lock':     'gem'
};

const MANIFEST_NAMES = Object.keys(FORMAT_TO_ECOSYSTEM);

/* Look for a recognised manifest at the workspace root. Returns the first one
   found in MANIFEST_NAMES order (package.json wins over requirements.txt etc.),
   or null. */
async function findTopLevelManifest(workspaceRoot) {
  for (const name of MANIFEST_NAMES) {
    const filePath = path.join(workspaceRoot, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) continue;
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { name, format: name, content, absolute: filePath, relative: name };
    } catch (_) { /* not found */ }
  }
  return null;
}

function parsePackageJson(text) {
  const j = JSON.parse(text);
  const combined = Object.assign({}, j.dependencies || {}, j.devDependencies || {}, j.peerDependencies || {});
  const dev = j.devDependencies || {};
  return Object.keys(combined).map((name) => ({
    name,
    current: String(combined[name]).replace(/^[\^~>=<]+/, '').trim(),
    kind: dev[name] ? 'dev' : 'runtime'
  }));
}

function parseRequirementsTxt(text) {
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const m = line.match(/^([a-zA-Z0-9_\-\.\[\]]+)\s*([=<>!~]+)?\s*([^;\s]+)?/);
      if (!m) return null;
      return { name: m[1], current: m[3] || '*', kind: 'pinned' };
    })
    .filter(Boolean);
}

function parseCargoToml(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let inDeps = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (/^\[dependencies(\.[\w\-]+)?\]/.test(t)) { inDeps = true; continue; }
    if (/^\[/.test(t)) { inDeps = false; continue; }
    if (!inDeps || !t || t.startsWith('#')) continue;
    let m = t.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"([^"]+)"/);
    if (m) { out.push({ name: m[1], current: m[2], kind: 'crate' }); continue; }
    m = t.match(/^([a-zA-Z0-9_\-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
    if (m) out.push({ name: m[1], current: m[2], kind: 'crate' });
  }
  return out;
}

function parseGoMod(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.indexOf('require (') === 0) { inBlock = true; continue; }
    if (inBlock && t === ')') { inBlock = false; continue; }
    let m;
    if (inBlock) {
      m = t.match(/^(\S+)\s+(\S+)/);
      if (m) out.push({ name: m[1], current: m[2], kind: 'module' });
    } else if (/^require\s+/.test(t)) {
      m = t.match(/^require\s+(\S+)\s+(\S+)/);
      if (m) out.push({ name: m[1], current: m[2], kind: 'module' });
    }
  }
  return out;
}

function parseGemfileLock(text) {
  const out = [];
  let inSpecs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*specs:/.test(line)) { inSpecs = true; continue; }
    if (!inSpecs) continue;
    const m = line.match(/^\s{4}([\w\-]+)\s+\(([^)]+)\)/);
    if (m) out.push({ name: m[1], current: m[2], kind: 'gem' });
  }
  return out;
}

function parse(format, content) {
  switch (format) {
    case 'package.json':     return parsePackageJson(content);
    case 'requirements.txt': return parseRequirementsTxt(content);
    case 'Pipfile':          return parseRequirementsTxt(content);
    case 'Cargo.toml':       return parseCargoToml(content);
    case 'go.mod':           return parseGoMod(content);
    case 'Gemfile.lock':     return parseGemfileLock(content);
    default: return [];
  }
}

/* Simple semver-like comparator. Returns -1 if a<b, 0 if a==b, 1 if a>b.
   Treats non-numeric segments lexicographically. */
function compareVersions(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).replace(/^[v=]+/, '').split(/[.+\-]/);
  const pb = String(b).replace(/^[v=]+/, '').split(/[.+\-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = parseInt(x, 10), ny = parseInt(y, 10);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      if (x !== y) return x < y ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { FORMAT_TO_ECOSYSTEM, MANIFEST_NAMES, findTopLevelManifest, parse, compareVersions };
