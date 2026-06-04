/* Workspace-boundary + command-allowlist safety helpers.
   Every endpoint that touches the file system or executes a system command
   must route through this module. Anything else is a bug. */

const path = require('path');
const fs = require('fs');

function resolveWorkspaceRoot(envValue) {
  const root = path.resolve(envValue && envValue.trim() ? envValue.trim() : process.cwd());
  if (!fs.existsSync(root)) {
    throw new Error(`Workspace root does not exist: ${root}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`);
  }
  return root;
}

/* Resolve `candidate` against `workspaceRoot` and return an absolute path,
   throwing if the result escapes the root via `..` or symlinks.

   Two checks: (1) a lexical prefix check on the resolved path, then (2) a
   realpath check that resolves symlinks. Because the target may not exist yet
   (an SSE stream opened before the file is created, a watched path), we
   realpath the deepest *existing* ancestor and re-append the missing tail —
   that still catches a symlinked directory anywhere along the existing path. */
function withinWorkspace(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.length) {
    throw new Error('Path is required');
  }
  const sep = path.sep;
  const resolved = path.resolve(workspaceRoot, candidate);
  const lexRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
  if (resolved !== workspaceRoot && !resolved.startsWith(lexRoot)) {
    throw Object.assign(new Error(`Path escapes workspace: ${candidate}`), { statusCode: 403 });
  }

  const realRoot = fs.realpathSync(workspaceRoot);
  let existing = resolved;
  const tail = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const finalResolved = tail.length ? path.join(realExisting, ...tail) : realExisting;
  const realRootSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (finalResolved !== realRoot && !finalResolved.startsWith(realRootSep)) {
    throw Object.assign(new Error(`Path escapes workspace: ${candidate}`), { statusCode: 403 });
  }
  return finalResolved;
}

/* Express middleware: reject the request if `allowDestructive` is false.
   Use this on every mutating endpoint as a belt-and-braces gate even after
   per-route confirm checks. */
function requireDestructiveAllowed(allowDestructive) {
  return function (req, res, next) {
    if (!allowDestructive) {
      return res.status(403).json({
        error: 'Destructive operations are disabled. Set ALLOW_DESTRUCTIVE=true and restart.'
      });
    }
    if (req.headers['x-confirm-destructive'] !== 'yes') {
      return res.status(412).json({
        error: 'Confirmation required. Send the X-Confirm-Destructive: yes header.'
      });
    }
    next();
  };
}

module.exports = { resolveWorkspaceRoot, withinWorkspace, requireDestructiveAllowed };
