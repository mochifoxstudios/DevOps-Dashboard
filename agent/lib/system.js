/* System + toolchain detection. Powers the Settings → About "System" row and
   the Settings → Local Toolchain rows with REAL data instead of design-time
   mock values. Cross-platform (uses `where` on Windows, `which` elsewhere). */

const os = require('node:os');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);

function systemInfo() {
  const totalGB = os.totalmem() / 1024 / 1024 / 1024;
  const freeGB = os.freemem() / 1024 / 1024 / 1024;
  return {
    platform: os.platform(),          // 'win32' | 'darwin' | 'linux'
    release: os.release(),
    arch: os.arch(),                  // 'x64' | 'arm64' | ...
    cpus: os.cpus().length,
    totalMemGB: Math.round(totalGB * 10) / 10,
    freeMemGB: Math.round(freeGB * 10) / 10,
    hostname: os.hostname(),
    nodeVersion: process.version
  };
}

/* Locate a binary and read its version. Returns { name, path, version, found }. */
async function detectTool(name, versionArg) {
  const isWin = os.platform() === 'win32';
  const locator = isWin ? 'where' : 'which';
  let toolPath = null;
  try {
    const { stdout } = await execAsync(locator + ' ' + name, { timeout: 4000 });
    toolPath = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch (_) { /* not on PATH */ }
  if (!toolPath) return { name: name, path: null, version: null, found: false };

  let version = null;
  try {
    const { stdout } = await execAsync(name + ' ' + (versionArg || '--version'), { timeout: 4000 });
    const m = stdout.match(/\d+\.\d+(\.\d+)?/);
    version = m ? m[0] : stdout.split(/\r?\n/)[0].trim().slice(0, 40);
  } catch (_) { /* version probe failed but binary exists */ }
  return { name: name, path: toolPath, version: version, found: true };
}

async function toolchain() {
  const [git, node, python, cargo] = await Promise.all([
    detectTool('git'),
    detectTool('node'),
    detectTool(os.platform() === 'win32' ? 'python' : 'python3'),
    detectTool('cargo')
  ]);
  return { git: git, node: node, python: python, cargo: cargo };
}

module.exports = { systemInfo, detectTool, toolchain };
