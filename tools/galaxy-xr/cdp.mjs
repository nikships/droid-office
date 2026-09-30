// Usage: node cdp.mjs <ws-url> <js-file-or-expression> [--console seconds]
import { readFileSync, existsSync } from 'node:fs';
const [url, src, flag, secs] = process.argv.slice(2);
// A reload or a hung page drops the socket without answering: never wait forever.
setTimeout(
  () => {
    console.log('"cdp timeout"');
    process.exit(2);
  },
  Number(process.env.CDP_TIMEOUT ?? 60) * 1000,
).unref();
const expr = existsSync(src) ? readFileSync(src, 'utf8') : src;
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
  } else if (d.method === 'Runtime.consoleAPICalled') {
    console.log(
      `[console.${d.params.type}]`,
      d.params.args
        .map((a) => a.value ?? a.description)
        .join(' ')
        .slice(0, 400),
    );
  } else if (d.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', d.params.exceptionDetails.exception?.description?.slice(0, 600));
  }
};
ws.onopen = async () => {
  if (flag === '--console') {
    await call('Runtime.enable');
    await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  }
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  const ex = r.result?.exceptionDetails;
  if (ex) console.log('[page exception]', (ex.exception?.description ?? ex.text ?? '').slice(0, 800));
  else console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
  ws.close();
};
