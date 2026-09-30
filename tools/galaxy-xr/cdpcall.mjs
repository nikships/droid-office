// Usage: node cdpcall.mjs <ws-url> <Method> [json-params]  (one raw CDP call, 10 s cap)
const [url, method, params] = process.argv.slice(2);
setTimeout(() => {
  console.log('"cdp timeout"');
  process.exit(2);
}, 10000).unref();
const ws = new WebSocket(url);
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id === 1) {
    console.log(JSON.stringify(d.result ?? d.error).slice(0, 2000));
    ws.close();
  }
};
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: params ? JSON.parse(params) : {} }));
