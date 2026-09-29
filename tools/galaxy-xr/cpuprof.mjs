// node cpuprof.mjs <ws-url> <seconds>
const [url, secs] = process.argv.slice(2);
const ws = new WebSocket(url);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
};
ws.onopen = async () => {
  await call('Profiler.enable');
  await call('Profiler.setSamplingInterval', { interval: 500 });
  await call('Profiler.start');
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  const { result } = await call('Profiler.stop');
  const p = result.profile;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map();
  const counts = new Map();
  for (const s of p.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  const total = p.samples.length;
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber}`;
  for (const [nid, c] of counts) {
    const k = key(byId.get(nid));
    self.set(k, (self.get(k) ?? 0) + c);
  }
  // inclusive
  const incl = new Map();
  for (const [nid, c] of counts) {
    const seen = new Set();
    let cur = nid;
    while (cur !== undefined) {
      const k = key(byId.get(cur));
      if (!seen.has(k)) {
        seen.add(k);
        incl.set(k, (incl.get(k) ?? 0) + c);
      }
      cur = parent.get(cur);
    }
  }
  const pct = (c) => `${((100 * c) / total).toFixed(1)}%`;
  console.log('samples', total, 'duration ms', (p.endTime - p.startTime) / 1000);
  console.log('--- self ---');
  for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(pct(c), k);
  console.log('--- inclusive ---');
  for (const [k, c] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(pct(c), k);
  ws.close();
};
