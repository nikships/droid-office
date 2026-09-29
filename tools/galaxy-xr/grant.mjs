// Grants an origin Chrome's WebXR permissions over the browser DevTools target.
// Usage: node grant.mjs <origin>
const origin = process.argv[2] ?? 'http://localhost:4600';
setTimeout(() => {
  console.log('timeout');
  process.exit(2);
}, 15000).unref();
const v = await (await fetch('http://localhost:9333/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
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
  for (const name of ['vr', 'ar', 'hand-tracking']) {
    const r = await call('Browser.setPermission', { origin, permission: { name }, setting: 'granted' });
    console.log(name, r.error ? `error: ${r.error.message}` : 'granted');
  }
  const r = await call('Browser.grantPermissions', { origin, permissions: ['vr', 'handTracking'] });
  console.log('grantPermissions', r.error ? `error: ${r.error.message}` : 'ok');
  ws.close();
};
