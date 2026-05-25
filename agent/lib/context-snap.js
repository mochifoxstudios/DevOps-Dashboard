/* Context-Snap engine — collects real environment, processes, git, and ports
   from the host running the agent. Cross-platform (Windows / macOS / Linux). */

const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const path = require('path');

const execAsync = promisify(exec);

const DEFAULT_REDACT_PATTERNS = [
  /SECRET/i, /TOKEN/i, /KEY/i, /PASSWORD/i, /PASSPHRASE/i,
  /AUTH/i, /CREDENTIAL/i, /COOKIE/i, /SESSION/i, /BEARER/i,
  /API[_-]?KEY/i, /PRIVATE/i
];

function buildRedactPatterns(extraCsv) {
  const extras = (extraCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => new RegExp(s, 'i'));
  return DEFAULT_REDACT_PATTERNS.concat(extras);
}

function isSecret(name, patterns) {
  return patterns.some(p => p.test(name));
}

/* GET /api/context-snap/env
   Lists process.env. Anything matching a redact pattern returns "***[redacted]***".
   `full` is excluded from default response unless ?full=1. */
async function getEnv({ extraRedact = '', includeFull = false } = {}) {
  const patterns = buildRedactPatterns(extraRedact);
  const entries = {};
  let redactedCount = 0;
  for (const k of Object.keys(process.env)) {
    if (isSecret(k, patterns)) {
      entries[k] = '***[redacted]***';
      redactedCount++;
    } else {
      entries[k] = process.env[k];
    }
  }
  const sample = Object.entries(entries)
    .slice(0, 20)
    .map(([k, v]) => `${k}=${(v || '').length > 80 ? v.slice(0, 80) + '…' : v}`);
  const out = {
    count: Object.keys(entries).length,
    redactedCount,
    sample
  };
  if (includeFull) out.full = entries;
  return out;
}

/* GET /api/context-snap/processes
   Lists running processes (pid + command). Capped at 100 entries to keep payload small. */
async function getProcesses() {
  const isWin = os.platform() === 'win32';
  const cmd = isWin
    ? 'tasklist /fo csv /nh'
    : 'ps -eo pid,comm,args --no-headers';

  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 4 * 1024 * 1024, timeout: 8000 });
    const raw = stdout.split(/\r?\n/).filter(l => l.trim());
    const parsed = isWin ? parseTasklistCsv(raw) : parsePsLines(raw);
    parsed.sort((a, b) => a.pid - b.pid);
    return {
      count: parsed.length,
      sample: parsed.slice(0, 100),
      truncated: parsed.length > 100
    };
  } catch (e) {
    return { count: 0, sample: [], error: e.message };
  }
}

function parseTasklistCsv(lines) {
  const out = [];
  for (const line of lines) {
    const fields = line.split('","').map(f => f.replace(/^"|"$/g, ''));
    const name = fields[0] || '';
    const pid = parseInt(fields[1], 10);
    if (!name || !Number.isFinite(pid)) continue;
    out.push({ pid, cmd: name });
  }
  return out;
}

function parsePsLines(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: parseInt(m[1], 10), cmd: m[3] || m[2] });
  }
  return out;
}

/* GET /api/context-snap/git
   Returns branch + commit sha for the workspace root. */
async function getGitInfo(cwd) {
  const opts = { cwd, timeout: 4000 };
  const safeRun = async (cmd) => {
    try { return (await execAsync(cmd, opts)).stdout.trim(); }
    catch (_) { return ''; }
  };
  const [branch, sha, dirty, remote] = await Promise.all([
    safeRun('git branch --show-current'),
    safeRun('git rev-parse HEAD'),
    safeRun('git status --porcelain'),
    safeRun('git config --get remote.origin.url')
  ]);
  return {
    branch: branch || null,
    sha: sha || null,
    shortSha: sha ? sha.slice(0, 7) : null,
    dirty: !!dirty,
    dirtyFiles: dirty ? dirty.split(/\r?\n/).filter(Boolean).length : 0,
    remote: remote || null,
    cwd: path.basename(cwd)
  };
}

/* GET /api/context-snap/ports
   Returns the set of listening / open ports observed by netstat. */
async function getPorts() {
  const isWin = os.platform() === 'win32';
  const cmd = isWin ? 'netstat -an' : 'netstat -tuln 2>/dev/null || ss -tuln';
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 4 * 1024 * 1024, timeout: 6000, shell: !isWin });
    // Match `:PORT` where PORT is 1-5 digits and followed by whitespace,
    // end-of-line, or another address separator. This avoids matching the
    // ".10" inside "192.168.1.10" (IP octets) which inflates the port list.
    const ports = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const matches = line.match(/:(\d{1,5})(?=[\s$]|\b)/g) || [];
      for (const tok of matches) {
        const n = parseInt(tok.slice(1), 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) ports.add(n);
      }
    }
    const sorted = Array.from(ports).sort((a, b) => a - b);
    return {
      count: sorted.length,
      sample: sorted.slice(0, 100),
      truncated: sorted.length > 100
    };
  } catch (e) {
    return { count: 0, sample: [], error: e.message };
  }
}

/* POST /api/context-snap/capture
   Runs all four collectors in parallel and returns the combined snapshot.
   `body.includes` is a flag map (env / processes / git / ports → bool) so the
   client can request only the parts the user checked. Defaults to all true. */
async function captureAll(workspaceRoot, includes = {}, extraRedact = '') {
  const flags = {
    env:       includes.env !== false,
    processes: includes.processes !== false,
    git:       includes.git !== false,
    ports:     includes.ports !== false
  };

  const tasks = [
    flags.env       ? getEnv({ extraRedact }) : Promise.resolve(null),
    flags.processes ? getProcesses()           : Promise.resolve(null),
    flags.git       ? getGitInfo(workspaceRoot): Promise.resolve(null),
    flags.ports     ? getPorts()               : Promise.resolve(null)
  ];

  const [env, processes, git, ports] = await Promise.all(tasks);

  return {
    capturedAt: new Date().toISOString(),
    workspaceRoot,
    workspaceName: path.basename(workspaceRoot),
    host: os.hostname(),
    platform: process.platform,
    nodeVersion: process.version,
    includes: flags,
    env, processes, git, ports
  };
}

module.exports = { getEnv, getProcesses, getGitInfo, getPorts, captureAll };
