function envMap(sample) {
  const m = new Map();
  for (const kv of (sample || [])) {
    const eq = kv.indexOf('=');
    if (eq > 0) m.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return m;
}

function diffEnv(a, b) {
  const ma = envMap(a && a.sample);
  const mb = envMap(b && b.sample);
  const added = [], removed = [], changed = [];
  for (const k of mb.keys()) if (!ma.has(k)) added.push(k);
  for (const k of ma.keys()) if (!mb.has(k)) removed.push(k);
  for (const k of mb.keys()) if (ma.has(k) && ma.get(k) !== mb.get(k)) changed.push({ key: k, before: ma.get(k), after: mb.get(k) });
  return { added, removed, changed };
}

function diffSnapshots(a, b) {
  const ca = (a && a.capture) || {};
  const cb = (b && b.capture) || {};
  return {
    env: diffEnv(ca.env, cb.env),
    pids: {
      gained: Math.max(0, ((cb.pids && cb.pids.count) || 0) - ((ca.pids && ca.pids.count) || 0)),
      lost:   Math.max(0, ((ca.pids && ca.pids.count) || 0) - ((cb.pids && cb.pids.count) || 0))
    },
    git: (() => {
      const ga = ca.git || {}, gb = cb.git || {};
      const out = { shaChanged: ga.sha !== gb.sha, dirtyDelta: (gb.dirtyFiles || 0) - (ga.dirtyFiles || 0) };
      if (ga.branch !== gb.branch) out.branchChanged = { from: ga.branch || null, to: gb.branch || null };
      return out;
    })(),
    ports: (() => {
      const pa = new Set(ca.ports || []), pb = new Set(cb.ports || []);
      const opened = [...pb].filter((p) => !pa.has(p));
      const closed = [...pa].filter((p) => !pb.has(p));
      return { opened, closed };
    })()
  };
}

module.exports = { diffSnapshots };
