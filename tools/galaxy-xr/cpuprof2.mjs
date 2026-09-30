// node cpuprof2.mjs <ws-url> <seconds>: top self/inclusive functions with line:column, plus callers of the hottest.
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
  const counts = new Map();
  for (const s of p.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  const total = p.samples.length;
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`;
  const self = new Map();
  const callers = new Map();
  for (const [nid, c] of counts) {
    const k = key(byId.get(nid));
    self.set(k, (self.get(k) ?? 0) + c);
    const chain = [];
    let cur = parent.get(nid);
    while (cur !== undefined && chain.length < 4) {
      chain.push(key(byId.get(cur)));
      cur = parent.get(cur);
    }
    const ck = `${k} <- ${chain.join(' <- ')}`;
    callers.set(ck, (callers.get(ck) ?? 0) + c);
  }
  const pct = (c) => `${((100 * c) / total).toFixed(1)}%`;
  console.log('--- self ---');
  for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(pct(c), k);
  console.log('--- hottest stacks ---');
  for (const [k, c] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(pct(c), k);
  ws.close();
};
