/* Log-Tail engine — file watcher + SSE-friendly streamer.
   No internet involved; everything is local fs + chokidar.

   Each subscriber (HTTP request) gets its own LogStream so concurrent tails on
   the same file don't share offsets. The OS handles concurrent file reads fine. */

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

/* Read up to `maxBytes` from the END of the file. Drops the first partial
   line if we didn't read from the start, so callers always get clean lines. */
async function readLastBytes(filePath, maxBytes) {
  const cap = Math.max(1024, Math.min(maxBytes || 64 * 1024, 4 * 1024 * 1024));
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw Object.assign(new Error('Not a regular file'), { statusCode: 400 });
  const startByte = Math.max(0, stat.size - cap);
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const len = stat.size - startByte;
    const buf = Buffer.alloc(len);
    if (len > 0) await fd.read(buf, 0, len, startByte);
    let text = buf.toString('utf8');
    if (startByte > 0) {
      const firstNL = text.indexOf('\n');
      if (firstNL >= 0) text = text.slice(firstNL + 1);
    }
    return { text, totalSize: stat.size, returnedBytes: len, truncatedFromStart: startByte > 0 };
  } finally {
    await fd.close();
  }
}

/* Recursive workspace walk for log-shaped files. Caps depth and result count
   so a huge tree doesn't lock up the request. Skips dot-dirs and node_modules. */
async function findLogFiles(root, opts = {}) {
  const exts = (opts.exts || ['.log', '.txt', '.out', '.err']).map(s => s.toLowerCase());
  const maxResults = opts.maxResults || 100;
  const maxDepth = opts.maxDepth || 4;
  const skipDirs = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.next', 'target', '__pycache__']);
  const results = [];

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > maxDepth) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.name.startsWith('.') || skipDirs.has(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(fp, depth + 1);
      } else if (e.isFile() && exts.some(ext => e.name.toLowerCase().endsWith(ext))) {
        try {
          const st = await fs.promises.stat(fp);
          results.push({
            path: path.relative(root, fp).split(path.sep).join('/'),
            absolute: fp,
            size: st.size,
            mtimeMs: st.mtimeMs
          });
        } catch { /* unreadable, skip */ }
      }
    }
  }

  await walk(root, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

class LogStream {
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
    this.subscribers = new Set();
    this.closed = false;
    this._reading = false;
    this._readPending = false;
    this.maxChunkBytes = opts.maxChunkBytes || 1024 * 1024;
  }

  async start() {
    let stat = null;
    try { stat = await fs.promises.stat(this.filePath); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // File doesn't exist yet — we'll start once chokidar fires 'add'.
    }
    if (stat && !stat.isFile()) {
      throw Object.assign(new Error('Path is not a regular file'), { statusCode: 400 });
    }
    if (stat) this.offset = stat.size;

    this.watcher = chokidar.watch(this.filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: false,
      atomic: false,
      usePolling: false
    });
    this.watcher.on('change', () => this._scheduleRead());
    this.watcher.on('add', () => {
      this.offset = 0;
      this.buffer = '';
      this._emit({ type: 'rotated', reason: 'add' });
      this._scheduleRead();
    });
    this.watcher.on('unlink', () => {
      this._emit({ type: 'unlink' });
    });
    this.watcher.on('error', (err) => {
      this._emit({ type: 'error', message: err.message });
    });

    return new Promise((resolve) => {
      this.watcher.on('ready', () => {
        this._emit({ type: 'open', path: this.filePath, startOffset: this.offset });
        resolve();
      });
    });
  }

  _scheduleRead() {
    if (this._reading) { this._readPending = true; return; }
    this._reading = true;
    this._readNew().finally(() => {
      this._reading = false;
      if (this._readPending) { this._readPending = false; this._scheduleRead(); }
    });
  }

  async _readNew() {
    if (this.closed) return;
    let stat;
    try { stat = await fs.promises.stat(this.filePath); }
    catch (e) {
      if (e.code === 'ENOENT') return; // file gone — wait for unlink/add
      this._emit({ type: 'error', message: e.message });
      return;
    }
    if (stat.size < this.offset) {
      this.offset = 0;
      this.buffer = '';
      this._emit({ type: 'truncated' });
    }
    if (stat.size === this.offset) return;

    const fd = await fs.promises.open(this.filePath, 'r');
    try {
      while (this.offset < stat.size && !this.closed) {
        const remaining = stat.size - this.offset;
        const chunkLen = Math.min(remaining, this.maxChunkBytes);
        const buf = Buffer.alloc(chunkLen);
        await fd.read(buf, 0, chunkLen, this.offset);
        this.offset += chunkLen;
        const text = this.buffer + buf.toString('utf8');
        const lines = text.split(/\r?\n/);
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.length) this._emit({ type: 'line', line, at: Date.now() });
        }
      }
    } finally {
      await fd.close();
    }
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(evt) {
    for (const fn of this.subscribers) {
      try { fn(evt); } catch (_) { /* swallow subscriber errors */ }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.watcher) {
      try { await this.watcher.close(); } catch (_) {}
    }
    this.subscribers.clear();
  }
}

module.exports = { LogStream, readLastBytes, findLogFiles };
