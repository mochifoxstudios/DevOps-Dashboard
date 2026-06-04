/* Single source of truth for where the agent writes its runtime state
   (.brain-state.json, .ai-keys.json, .salt, .audit*.log, .github-queue.json).

   By default state lives in the agent root (next to server.js), preserving the
   v1.0 layout. Setting AGENT_STATE_DIR relocates ALL of it to a writable
   directory — required for a packaged/read-only install (e.g. the deferred
   Electron build) where writing next to the bundled source would throw. */

const fs = require('node:fs');
const path = require('node:path');

// lib/ lives directly under the agent root.
const AGENT_ROOT = path.resolve(__dirname, '..');

function resolveStateDir(envVal) {
  const raw = envVal !== undefined ? envVal : process.env.AGENT_STATE_DIR;
  if (raw && String(raw).trim()) {
    const dir = path.resolve(String(raw).trim());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return AGENT_ROOT;
}

function stateDir(filename, envVal) {
  return path.join(resolveStateDir(envVal), filename);
}

module.exports = { resolveStateDir, stateDir, AGENT_ROOT };
