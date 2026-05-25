const os = require('node:os');

const DEFAULT_SECRET_RES = [
  /\b([A-Z][A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD|PASSPHRASE|AUTH|CREDENTIAL|COOKIE|SESSION|BEARER|API[_-]?KEY|PRIVATE))\b\s*[=:]\s*\S+/gi,
  /\b(sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9_]{16,}|xoxb-[A-Za-z0-9_\-]{16,}|AKIA[A-Z0-9]{16})\b/g
];
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{1,4}\b/g;
const HOME_RE = new RegExp(escapeRe(os.homedir()), 'g');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function makeRedactor(extraPatternStrings = []) {
  const extras = extraPatternStrings
    .map((s) => s.trim()).filter(Boolean)
    .map((s) => { try { return new RegExp(s, 'gi'); } catch { return null; } })
    .filter(Boolean);
  return function redactWithExtras(text) {
    let envVarsScrubbed = 0, secretsFound = 0, ipsScrubbed = 0, extrasScrubbed = 0;
    let out = String(text || '');
    for (const re of DEFAULT_SECRET_RES) {
      out = out.replace(re, (m) => { secretsFound++; return '<redacted-secret>'; });
    }
    for (const re of extras) {
      out = out.replace(re, () => { extrasScrubbed++; return '<redacted>'; });
    }
    out = out.replace(IPV4_RE, () => { ipsScrubbed++; return '<ip>'; });
    out = out.replace(IPV6_RE, () => { ipsScrubbed++; return '<ip>'; });
    out = out.replace(HOME_RE, '~');
    return { text: out, summary: { envVarsScrubbed, secretsFound, ipsScrubbed, extrasScrubbed } };
  };
}

const redact = makeRedactor();
module.exports = { redact, makeRedactor };
