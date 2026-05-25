async function complete({ endpoint, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  const url = (endpoint || 'http://localhost:11434').replace(/\/$/, '') + '/api/chat';
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    options: { num_predict: maxTokens, temperature }
  };
  if (jsonMode) body.format = 'json';
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
  const j = await res.json();
  const text = (j.message && j.message.content) || '';
  return {
    text,
    model: j.model || model,
    usage: {
      prompt: j.prompt_eval_count || 0,
      completion: j.eval_count || 0,
      totalTokens: (j.prompt_eval_count || 0) + (j.eval_count || 0)
    },
    costCents: 0  // local model
  };
}

async function listModels({ endpoint }) {
  const url = (endpoint || 'http://localhost:11434').replace(/\/$/, '') + '/api/tags';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
  const j = await res.json();
  return (j.models || []).map((m) => m.name);
}

module.exports = { complete, listModels, name: 'ollama', defaultEndpoint: 'http://localhost:11434' };
