const PRICING = {
  'claude-sonnet-4-6':         { prompt: 0.3, completion: 1.5 },
  'claude-opus-4-7':           { prompt: 1.5, completion: 7.5 },
  'claude-haiku-4-5-20251001': { prompt: 0.025, completion: 0.125 }
};

async function complete({ endpoint, apiKey, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  if (!apiKey) throw new Error('Anthropic: missing API key');
  const url = (endpoint || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: jsonMode ? user + '\n\nReturn ONLY a JSON object, no prose.' : user }]
  };
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Anthropic HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const usage = j.usage || {};
  const pricing = PRICING[model] || { prompt: 0, completion: 0 };
  const costCents =
    (usage.input_tokens || 0) / 1000 * pricing.prompt +
    (usage.output_tokens || 0) / 1000 * pricing.completion;
  return {
    text,
    model: j.model || model,
    usage: { prompt: usage.input_tokens || 0, completion: usage.output_tokens || 0, totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
    costCents: Math.round(costCents * 100) / 100
  };
}

async function listModels() { return Object.keys(PRICING); }

module.exports = { complete, listModels, name: 'anthropic', defaultEndpoint: 'https://api.anthropic.com' };
