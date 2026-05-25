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
   throwing if the result escapes the root via `..` or symlinks. */
function withinWorkspace(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.length) {
    throw new Error('Path is required');
  }
  const resolved = path.resolve(workspaceRoot, candidate);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
    const err = new Error(`Path escapes workspace: ${candidate}`);
    err.statusCode = 403;
    throw err;
  }
  return resolved;
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
