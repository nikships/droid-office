// node cpuprof3.mjs <ws-url> <seconds> [focus...]: inclusive time per function (ms per XR frame), and
// for each focus function name, its heaviest children.
const [url, secs, ...focus] = process.argv.slice(2);
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
  await call('Runtime.evaluate', {
    expression: '(() => { const s = window.__office.renderer.xr.getSession(); window.__fc = 0; const R = s.requestAnimationFrame.bind(s); window.__fcR = R; s.requestAnimationFrame = (cb) => R((t, f) => { window.__fc++; cb(t, f); }); })()',
  });
  await call('Profiler.enable');
  await call('Profiler.setSamplingInterval', { interval: 200 });
  await call('Profiler.start');
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  const { result } = await call('Profiler.stop');
  const fr = await call('Runtime.evaluate', { returnByValue: true, expression: '(() => { const s = window.__office.renderer.xr.getSession(); s.requestAnimationFrame = window.__fcR; return window.__fc; })()' });
  const frames = fr.result.result.value || 1;
  const p = result.profile;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i + 1] ?? p.timeDeltas[i]) / 1000);
  const incl = new Map();
  const walk = (n) => {
    let t = dt.get(n.id) ?? 0;
    for (const c of n.children ?? []) t += walk(byId.get(c));
    incl.set(n.id, t);
    return t;
  };
  walk(p.nodes[0]);
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`;
  const agg = new Map();
  const seen = (n, stack) => {
    const k = key(n);
    if (!stack.has(k)) agg.set(k, (agg.get(k) ?? 0) + incl.get(n.id));
    const next = new Set(stack);
    next.add(k);
    for (const c of n.children ?? []) seen(byId.get(c), next);
  };
  seen(p.nodes[0], new Set());
  const per = (ms) => (ms / frames).toFixed(2);
  console.log(`frames ${frames} in ${secs}s`);
  for (const [k, t] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(per(t), k);
  for (const f of focus) {
    const kids = new Map();
    for (const n of p.nodes)
      if ((n.callFrame.functionName || '(anon)') === f)
        for (const c of n.children ?? []) {
          const cn = byId.get(c);
          kids.set(key(cn), (kids.get(key(cn)) ?? 0) + incl.get(c));
        }
    console.log(`--- children of ${f} ---`);
    for (const [k, t] of [...kids].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(per(t), k);
  }
  ws.close();
};
