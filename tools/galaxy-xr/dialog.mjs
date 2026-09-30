// Usage: node dialog.mjs <ws-url>  — enable Page, accept any open JS dialog (beforeunload etc).
const [url] = process.argv.slice(2);
setTimeout(() => {
  console.log('timeout');
  process.exit(2);
}, 10000).unref();
const ws = new WebSocket(url);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  console.log(JSON.stringify(d).slice(0, 300));
  if (d.method === 'Page.javascriptDialogOpening' || d.id === 1) send('Page.handleJavaScriptDialog', { accept: true });
  if (d.id === 2) setTimeout(() => process.exit(0), 300);
};
ws.onopen = () => send('Page.enable');
