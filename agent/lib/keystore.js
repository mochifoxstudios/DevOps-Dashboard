const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const FILE = '.ai-keys.json';
const SALT_FILE = '.salt';

class Keystore {
  constructor({ dir, workspaceRoot }) {
    if (!dir) throw new Error('Keystore requires { dir }');
    if (!workspaceRoot) throw new Error('Keystore requires { workspaceRoot }');
    this.dir = dir;
    this.workspaceRoot = workspaceRoot;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._key = this._deriveKey();
  }
  _saltPath() { return path.join(this.dir, SALT_FILE); }
  _filePath() { return path.join(this.dir, FILE); }
  _getSalt() {
    try { return fs.readFileSync(this._saltPath()); }
    catch {
      const salt = crypto.randomBytes(16);
      fs.writeFileSync(this._saltPath(), salt, { mode: 0o600 });
      return salt;
    }
  }
  _deriveKey() {
    const seed = this.workspaceRoot + '|' + os.hostname() + '|' + os.userInfo().username;
    return crypto.scryptSync(seed, this._getSalt(), 32);
  }
  _encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }
  _decrypt(blob) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this._key, Buffer.from(blob.iv, 'base64'));
      d.setAuthTag(Buffer.from(blob.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
  }
  _readAll() {
    try { return JSON.parse(fs.readFileSync(this._filePath(), 'utf8')); }
    catch { return {}; }
  }
  _writeAll(obj) {
    fs.writeFileSync(this._filePath(), JSON.stringify(obj), { mode: 0o600 });
  }
  set(name, value) {
    const all = this._readAll();
    all[name] = this._encrypt(value);
    this._writeAll(all);
  }
  get(name) {
    const all = this._readAll();
    if (!all[name]) return null;
    return this._decrypt(all[name]);
  }
  list() { return Object.keys(this._readAll()); }
  delete(name) {
    const all = this._readAll();
    delete all[name];
    this._writeAll(all);
  }
}

module.exports = { Keystore };
