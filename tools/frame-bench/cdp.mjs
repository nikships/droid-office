// A small Chrome DevTools Protocol client over the `ws` package: enough to evaluate script in the office page of a
// running Electron app (its --remote-debugging-port) without Playwright's emulation or its overhead.
import http from 'node:http';
import WebSocket from 'ws';

export function getJson(port, route) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: route, timeout: 3000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}`));
        else p.resolve(msg.result);
      } else for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('the DevTools connection closed'));
      this.pending.clear();
    });
  }

  /** Connects to the office page (the first `page` target whose URL starts with `urlPrefix`). */
  static async connect(port, urlPrefix) {
    const targets = await getJson(port, '/json');
    const t = targets.find((x) => x.type === 'page' && x.url.startsWith(urlPrefix));
    if (!t) throw new Error(`no page at ${urlPrefix} on DevTools port ${port}: ${targets.map((x) => `${x.type} ${x.url}`).join(', ')}`);
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }

  /** Runs an expression in the page (awaiting a promise) and returns its JSON-able value. */
  async eval(expression, { timeout = 120_000 } = {}) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluate timed out after ${timeout} ms: ${expression.slice(0, 80)}`)), timeout)),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  close() {
    this.ws.close();
  }
}
