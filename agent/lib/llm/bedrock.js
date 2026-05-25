let SDK;
function loadSDK() {
  if (SDK) return SDK;
  try { SDK = require('@aws-sdk/client-bedrock-runtime'); return SDK; }
  catch { throw new Error('Bedrock adapter requires @aws-sdk/client-bedrock-runtime; npm install it.'); }
}

const PRICING = {
  'anthropic.claude-sonnet-4-6-v1:0': { prompt: 0.3, completion: 1.5 }
};

async function complete({ region, model, system, user, maxTokens, temperature, jsonMode, signal }) {
  const { BedrockRuntimeClient, InvokeModelCommand } = loadSDK();
  const client = new BedrockRuntimeClient({ region: region || 'us-east-1' });
  const isAnthropic = model.startsWith('anthropic.');
  if (!isAnthropic) throw new Error('Bedrock: only Anthropic-on-Bedrock models supported initially');
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: jsonMode ? user + '\n\nReturn ONLY a JSON object.' : user }]
  };
  const res = await client.send(new InvokeModelCommand({
    modelId: model,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  }), { abortSignal: signal });
  const j = JSON.parse(new TextDecoder().decode(res.body));
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const usage = j.usage || {};
  const pricing = PRICING[model] || { prompt: 0, completion: 0 };
  const costCents =
    (usage.input_tokens || 0) / 1000 * pricing.prompt +
    (usage.output_tokens || 0) / 1000 * pricing.completion;
  return {
    text, model,
    usage: { prompt: usage.input_tokens || 0, completion: usage.output_tokens || 0, totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
    costCents: Math.round(costCents * 100) / 100
  };
}

async function listModels() { return Object.keys(PRICING); }

module.exports = { complete, listModels, name: 'bedrock', defaultEndpoint: null };
