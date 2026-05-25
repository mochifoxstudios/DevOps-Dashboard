// Pricing (cents per 1K tokens) — update as needed; used for audit cost estimate only.
const PRICING = {
  'gpt-4o-mini':       { prompt: 0.015, completion: 0.06 },
  'gpt-4o':            { prompt: 0.25,  completion: 1.0 },
  'gpt-4.1-mini':      { prompt: 0.015, completion: 0.06 }
};

async function complete({ endpoint, apiKey, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  if (!apiKey) throw new Error('OpenAI: missing API key');
  const url = (endpoint || 'https://api.openai.com').replace(/\/$/, '') + '/v1/chat/completions';
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'authorization': 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('OpenAI HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  const usage = j.usage || {};
  const pricing = PRICING[model] || { prompt: 0, completion: 0 };
  const costCents =
    (usage.prompt_tokens || 0) / 1000 * pricing.prompt +
    (usage.completion_tokens || 0) / 1000 * pricing.completion;
  return {
    text,
    model: j.model || model,
    usage: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, totalTokens: usage.total_tokens || 0 },
    costCents: Math.round(costCents * 100) / 100
  };
}

async function listModels() {
  return Object.keys(PRICING);
}

module.exports = { complete, listModels, name: 'openai', defaultEndpoint: 'https://api.openai.com' };
