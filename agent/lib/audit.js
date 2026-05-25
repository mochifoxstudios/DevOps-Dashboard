const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = '.audit.log';
const TIP_FILE = '.audit-tip';

function sha256(s) { return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex'); }
function newId() { return 'aud-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'); }

class Audit {
  constructor({ dir, maxBytes = 10 * 1024 * 1024, keep = 10 } = {}) {
    if (!dir) throw new Error('Audit requires { dir }');
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keep = keep;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._tip = this._readTip();
  }
  _path() { return path.join(this.dir, FILE); }
  _tipPath() { return path.join(this.dir, TIP_FILE); }
  _readTip() {
    try { return fs.readFileSync(this._tipPath(), 'utf8').trim() || 'sha256:GENESIS'; }
    catch { return 'sha256:GENESIS'; }
  }
  _rotateIfNeeded() {
    let size = 0;
    try { size = fs.statSync(this._path()).size; } catch { return; }
    if (size < this.maxBytes) return;
    for (let i = this.keep - 1; i >= 1; i--) {
      const src = path.join(this.dir, `.audit-${i}.log`);
      const dst = path.join(this.dir, `.audit-${i + 1}.log`);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(this._path(), path.join(this.dir, '.audit-1.log'));
    const oldest = path.join(this.dir, `.audit-${this.keep + 1}.log`);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  }
  append(record) {
    this._rotateIfNeeded();
    const full = Object.assign({}, record, {
      ts: new Date().toISOString(),
      id: newId(),
      prevHash: this._tip
    });
    const line = JSON.stringify(full);
    fs.appendFileSync(this._path(), line + '\n');
    this._tip = sha256(line);
    fs.writeFileSync(this._tipPath(), this._tip);
    return full.id;
  }
  read({ limit = 100 } = {}) {
    const all = [];
    for (let i = this.keep; i >= 1; i--) {
      const f = path.join(this.dir, `.audit-${i}.log`);
      if (fs.existsSync(f)) all.push(...this._readFile(f));
    }
    if (fs.existsSync(this._path())) all.push(...this._readFile(this._path()));
    return all.reverse().slice(0, limit);
  }
  _readFile(f) {
    // Skip lines that fail to parse — a truncated write or hand edit shouldn't
    // crash read()/verify(). verify() handles tamper detection via the hash
    // chain; this just keeps the API resilient to garbage lines.
    const out = [];
    for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
    }
    return out;
  }
  verify() {
    let n = 0;
    const files = [];
    for (let i = this.keep; i >= 1; i--) {
      const f = path.join(this.dir, `.audit-${i}.log`);
      if (fs.existsSync(f)) files.push(f);
    }
    if (fs.existsSync(this._path())) files.push(this._path());
    if (files.length === 0) return { ok: true, recordsVerified: 0, tipHash: 'sha256:GENESIS' };
    // Seed from the first record of the oldest retained file so eviction doesn't
    // break verification of the records we still have.
    const firstLines = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean);
    if (firstLines.length === 0) return { ok: true, recordsVerified: 0, tipHash: 'sha256:GENESIS' };
    let prev = JSON.parse(firstLines[0]).prevHash;
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); }
        catch { return { ok: false, recordsVerified: n, brokenAt: 'parse-error' }; }
        if (rec.prevHash !== prev) return { ok: false, recordsVerified: n, brokenAt: rec.id };
        prev = sha256(line);
        n++;
      }
    }
    return { ok: true, recordsVerified: n, tipHash: prev };
  }
}

module.exports = { Audit };
