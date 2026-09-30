// Clicks the office's Enter VR button with real input events through CDP (Input.dispatchMouseEvent),
// as a pinch on it would, instead of calling vr.enter() from Runtime.evaluate.
import { readFileSync } from 'node:fs';
const [url] = process.argv.slice(2);
setTimeout(() => {
  console.log('timeout');
  process.exit(2);
}, 30000).unref();
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
  const r = await call('Runtime.evaluate', {
    returnByValue: true,
    expression: '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Enter VR")); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()',
  });
  const [x, y] = r.result.result.value;
  const kind = process.env.TAP ?? 'mouse';
  if (kind === 'touch') {
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  await new Promise((d) => setTimeout(d, 5000));
  const s = await call('Runtime.evaluate', { returnByValue: true, expression: '({ vr: window.__office.vr.active, vis: window.__office.renderer.xr.getSession()?.visibilityState, active: document.activeElement?.tagName })' });
  console.log(JSON.stringify(s.result.result.value));
  ws.close();
};
void readFileSync;
