import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, 'log-triage');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const provider = (process.argv.find(a => a.startsWith('--provider=')) || '').slice(11) || 'ollama';
const model    = (process.argv.find(a => a.startsWith('--model='))    || '').slice(8);

if (!model) {
  console.error('Usage: node run.mjs --provider=<name> --model=<name>');
  console.error('  Manual eval: prints the input + expectations for each golden sample.');
  console.error('  Send each through your running agent (POST /api/agent/enrich-draft after');
  console.error('  configuring the provider) and compare the enriched draft against');
  console.error('  expectations.must_mention / must_not_mention / confidence_at_least.');
  process.exit(1);
}

console.log('Running eval against ' + provider + '/' + model + ' on ' + files.length + ' samples');
console.log('(manual review — no PASS/FAIL; the script prints scored inputs for you to read.)');

for (const f of files) {
  const sample = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log('\n--- ' + sample.name + ' ---');
  console.log('expectations:', sample.expectations);
  console.log('matchedLine:', sample.input.matchedLine);
}
console.log('\n(Full LLM round-trip requires running the agent; extend run.mjs as needed.)');
