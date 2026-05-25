const fs = require('node:fs');
const path = require('node:path');

class GitHub {
  constructor({ keystore, audit, queuePath, endpoint = 'https://api.github.com' }) {
    this.keystore = keystore;
    this.audit = audit;
    this.queuePath = queuePath || path.join(process.cwd(), '.github-queue.json');
    this.endpoint = endpoint.replace(/\/$/, '');
    this._timer = null;
  }
  _readQueue() {
    try { return JSON.parse(fs.readFileSync(this.queuePath, 'utf8')); } catch { return []; }
  }
  _writeQueue(arr) {
    try { fs.writeFileSync(this.queuePath, JSON.stringify(arr, null, 2)); } catch {}
  }
  _token() {
    return this.keystore.get('github_app_token') || this.keystore.get('github_pat');
  }
  setPAT(token) { this.keystore.set('github_pat', token); }
  setAppToken(token) { this.keystore.set('github_app_token', token); }

  async createIssue({ owner, repo, title, body, labels = [], assignees = [], draftId }) {
    const token = this._token();
    if (!token) throw new Error('no GitHub token configured');
    const url = this.endpoint + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/issues';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': 'token ' + token, 'accept': 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, labels, assignees })
    });
    const text = await res.text();
    let outcome = 'ok', payload = null;
    if (res.status === 401 || res.status === 403) outcome = 'unauthorized';
    else if (res.status === 429) outcome = 'rate-limited';
    else if (!res.ok) outcome = 'provider-error';
    try { payload = JSON.parse(text); } catch {}
    if (this.audit) {
      this.audit.append({
        kind: 'github-file', feature: 'manual-file',
        repo: owner + '/' + repo, issueNumber: payload && payload.number, labels, draftId,
        outcome
      });
    }
    if (outcome !== 'ok') throw Object.assign(new Error('GitHub ' + res.status + ': ' + text.slice(0, 200)), { code: outcome });
    return { url: payload.html_url, issueNumber: payload.number };
  }

  enqueue(item) {
    const q = this._readQueue();
    q.push(Object.assign({}, item, { enqueuedAt: new Date().toISOString(), attempts: 0 }));
    this._writeQueue(q);
    this._scheduleSweep();
  }
  _scheduleSweep() {
    if (this._timer) return;
    this._timer = setTimeout(() => this._sweep().finally(() => { this._timer = null; }), 60000);
  }
  async _sweep() {
    const q = this._readQueue();
    if (!q.length) return;
    const remaining = [];
    for (const item of q) {
      const age = Date.now() - new Date(item.enqueuedAt).getTime();
      if (age > 24 * 3600 * 1000) {
        if (this.audit) this.audit.append({ kind: 'github-file', feature: 'manual-file', outcome: 'rate-limited', draftId: item.draftId, repo: item.owner + '/' + item.repo, dropped: true });
        continue;
      }
      try { await this.createIssue(item); }
      catch { item.attempts = (item.attempts || 0) + 1; remaining.push(item); }
    }
    this._writeQueue(remaining);
    if (remaining.length) this._scheduleSweep();
  }
}

module.exports = { GitHub };
