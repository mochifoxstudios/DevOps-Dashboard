const TEMPLATES = {
  'log-triage-v1': {
    output: 'json',
    system:
      'You analyze application logs. Given a matched error line plus up to ' +
      '20 lines of preceding context, produce structured JSON: ' +
      '`summary` (≤80 chars), `likely_cause` (1-2 sentences), ' +
      '`confidence` (low|medium|high), `next_steps` (3 bullets, strings), ' +
      '`related_signals` (services/env-keys/PIDs referenced in context, strings). ' +
      'Be specific; no platitudes. Output ONLY the JSON object, no prose.',
    userTemplate: (input) =>
      'Workspace: ' + (input.workspace || 'unknown') +
      '\nBranch: ' + (input.branch || 'unknown') +
      '\n\nContext (older to newer):\n' + (input.context || []).join('\n') +
      '\n\nMATCHED LINE:\n' + (input.matchedLine || ''),
    expectedSchema: {
      summary: 'string',
      likely_cause: 'string',
      confidence: 'enum:low,medium,high',
      next_steps: 'array<string>',
      related_signals: 'array<string>'
    }
  },
  'diff-narrator-v1': {
    output: 'text',
    system:
      'You write a 2-3 sentence engineering changelog. Given a structured diff ' +
      'between two workspace snapshots, narrate what changed and a likely ' +
      'reason. No bullet points; flowing prose. No emojis.',
    userTemplate: (diffReport) => 'DiffReport JSON:\n' + JSON.stringify(diffReport, null, 2)
  }
};

function get(name) {
  const t = TEMPLATES[name];
  if (!t) throw new Error('Unknown template: ' + name);
  return t;
}

function validateAgainstSchema(obj, schema) {
  if (!schema) return { ok: true };
  for (const key of Object.keys(schema)) {
    if (!(key in obj)) return { ok: false, reason: 'missing field: ' + key };
    const t = schema[key];
    const v = obj[key];
    if (t === 'string' && typeof v !== 'string') return { ok: false, reason: key + ' not string' };
    if (t.startsWith('enum:') && !t.slice(5).split(',').includes(v)) {
      return { ok: false, reason: key + ' not in enum' };
    }
    if (t.startsWith('array<') && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      return { ok: false, reason: key + ' not array<string>' };
    }
  }
  return { ok: true };
}

module.exports = { get, validateAgainstSchema, TEMPLATES };
