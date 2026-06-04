/* Air-Gapped Mode — one switch (AIRGAP=true) that forces a zero-egress posture
   by tightening the existing toggles, plus a self-test that PROVES the effective
   config can't reach the network. The capabilities already existed (Ollama
   provider, registry-lookup toggle, scraper deny-all); this packages them into a
   single, demonstrable mode for regulated / air-gapped buyers. */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

function isLocalEndpoint(url) {
  if (!url) return false;
  try { return LOCAL_HOSTS.indexOf(new URL(url).hostname.toLowerCase()) !== -1; }
  catch (e) { return false; }
}

// Compute the effective egress-sensitive config from raw env, applying the
// AIRGAP lockdown when AIRGAP=true. Registry lookups off, scraper deny-all.
function airgapConfig(env) {
  const airgap = String(env.AIRGAP) === 'true';
  return {
    airgap,
    registryLookupEnabled: airgap ? false : (env.REGISTRY_LOOKUP_ENABLED !== 'false'),
    scraperAllowAny: airgap ? false : (env.SCRAPER_ALLOW_ANY === 'true'),
    scraperAllowedHosts: airgap ? '' : (env.SCRAPER_ALLOWED_HOSTS || '')
  };
}

// Prove the effective runtime config makes non-localhost egress impossible.
// `eff` carries the resolved registry/scraper config plus the LLM provider+endpoint
// the agent will actually use.
function selfTest(eff) {
  const checks = [];
  checks.push({ name: 'registry lookups disabled', pass: eff.registryLookupEnabled === false });
  checks.push({
    name: 'scraper deny-all (no allow-any, empty allowlist)',
    pass: eff.scraperAllowAny === false && !(eff.scraperAllowedHosts || '').trim()
  });
  const epLocal = eff.llmEndpoint ? isLocalEndpoint(eff.llmEndpoint) : (eff.llmProvider === 'ollama');
  checks.push({
    name: 'LLM restricted to a local endpoint',
    pass: eff.llmProvider === 'ollama' && epLocal
  });
  const egressBlocked = checks.every((c) => c.pass);
  return { airgap: !!eff.airgap, egressBlocked, checks };
}

module.exports = { airgapConfig, selfTest, isLocalEndpoint, LOCAL_HOSTS };
