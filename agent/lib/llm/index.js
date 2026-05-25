const ollama = require('./ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');
const bedrock = require('./bedrock');
const templates = require('./templates');
const { makeRedactor } = require('./redact');

const ADAPTERS = { ollama, openai, anthropic, bedrock };

class LLMProvider {
  constructor({ providerName, model, endpoint, region, apiKeyFn, audit, extraRedactPatterns, dailyCap }) {
    this.providerName = providerName;
    this.model = model;
    this.endpoint = endpoint;
    this.region = region;
    this.apiKeyFn = apiKeyFn || (() => null);   // injected, never stored on this
    this.audit = audit;
    this.dailyCap = dailyCap;
    this._dailyCount = 0;
    this._dailyResetAt = this._nextMidnight();
    this._redactor = makeRedactor(extraRedactPatterns || []);
  }
  _nextMidnight() {
    const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime();
  }
  _resetIfDay() {
    if (Date.now() >= this._dailyResetAt) {
      this._dailyCount = 0;
      this._dailyResetAt = this._nextMidnight();
    }
  }
  isOff() { return !this.providerName || this.providerName === 'off'; }
  remainingCalls() {
    this._resetIfDay();
    if (this.dailyCap == null || this.dailyCap === 0) return Infinity;
    return Math.max(0, this.dailyCap - this._dailyCount);
  }

  async complete({ template, input, maxTokens = 400, temperature = 0.2, feature = 'unknown', timeoutMs = 15000 }) {
    if (this.isOff()) throw Object.assign(new Error('LLM provider is Off'), { code: 'provider-off' });
    if (this.remainingCalls() === 0) throw Object.assign(new Error('Daily LLM cap reached'), { code: 'cap-reached' });
    const adapter = ADAPTERS[this.providerName];
    if (!adapter) throw new Error('Unknown provider: ' + this.providerName);

    const tpl = templates.get(template);
    const userRaw = tpl.userTemplate(input);
    const { text: user, summary: redactionSummary } = this._redactor(userRaw);
    const promptStr = (tpl.system || '') + '\n' + user;
    const crypto = require('node:crypto');
    const promptHash = 'sha256:' + crypto.createHash('sha256').update(promptStr).digest('hex');
    const promptBytes = Buffer.byteLength(promptStr, 'utf8');

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let outcome = 'ok', result, err;
    try {
      result = await adapter.complete({
        endpoint: this.endpoint, region: this.region,
        apiKey: this.apiKeyFn(this.providerName),
        model: this.model,
        system: tpl.system, user,
        maxTokens, temperature,
        jsonMode: tpl.output === 'json',
        signal: ctrl.signal
      });
      // schema validation + one repair retry
      if (tpl.output === 'json' && tpl.expectedSchema) {
        let parsed;
        try { parsed = JSON.parse(result.text); }
        catch { parsed = null; }
        const v = parsed ? templates.validateAgainstSchema(parsed, tpl.expectedSchema) : { ok: false, reason: 'not json' };
        if (!v.ok) {
          outcome = 'bad-response';
          const repairedUser = user + '\n\n[your previous response was invalid: ' + v.reason + ']\nPlease return valid JSON matching the schema.';
          result = await adapter.complete({
            endpoint: this.endpoint, region: this.region,
            apiKey: this.apiKeyFn(this.providerName),
            model: this.model, system: tpl.system, user: repairedUser,
            maxTokens, temperature, jsonMode: true, signal: ctrl.signal
          });
          try {
            const re = JSON.parse(result.text);
            const v2 = templates.validateAgainstSchema(re, tpl.expectedSchema);
            if (v2.ok) outcome = 'ok';
          } catch { /* still bad */ }
        }
      }
      this._dailyCount++;
    } catch (e) {
      outcome = e.name === 'AbortError' ? 'timeout' : 'provider-error';
      err = e;
    } finally {
      clearTimeout(t);
    }
    if (this.audit) {
      this.audit.append({
        kind: 'llm-call', feature,
        provider: this.providerName, model: this.model, template,
        promptHash, promptBytes,
        redactionSummary,
        responseBytes: result ? Buffer.byteLength(result.text, 'utf8') : 0,
        tokens: result ? result.usage : { prompt: 0, completion: 0, totalTokens: 0 },
        costCents: result ? result.costCents : 0,
        outcome
      });
    }
    if (err) throw err;
    return Object.assign({}, result, { outcome });
  }

  async testKey() {
    if (this.isOff()) return { ok: false, error: 'provider off' };
    const adapter = ADAPTERS[this.providerName];
    if (!adapter) return { ok: false, error: 'unknown provider' };
    const t0 = Date.now();
    try {
      await adapter.complete({
        endpoint: this.endpoint, region: this.region,
        apiKey: this.apiKeyFn(this.providerName),
        model: this.model, system: 'reply with the single word ok',
        user: 'ping', maxTokens: 4, temperature: 0, jsonMode: false
      });
      return { ok: true, latencyMs: Date.now() - t0, model: this.model };
    } catch (e) {
      return { ok: false, error: e.message, latencyMs: Date.now() - t0 };
    }
  }

  async listModels() {
    const adapter = ADAPTERS[this.providerName];
    if (!adapter) return [];
    try { return await adapter.listModels({ endpoint: this.endpoint, apiKey: this.apiKeyFn(this.providerName) }); }
    catch { return []; }
  }
}

module.exports = { LLMProvider, ADAPTERS };
