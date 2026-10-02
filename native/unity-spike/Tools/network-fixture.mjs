import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(
  {
    cert: readFileSync(resolve(project, 'Evidence/fixture-cert.pem')),
    key: readFileSync(resolve(project, 'Evidence/fixture-key.pem')),
  },
  (request, response) => {
    response.writeHead(request.url === '/probe' && request.headers.authorization === 'Bearer u0-synthetic-fixture' ? 200 : 401);
    response.end('U0 synthetic fixture');
  },
);
const ws = new WebSocketServer({ noServer: true });
const payload = Buffer.alloc(256 * 1024, 0x55);
server.on('upgrade', (request, socket, head) => {
  if (request.headers.authorization !== 'Bearer u0-synthetic-fixture' || !request.headers.origin) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  ws.handleUpgrade(request, socket, head, (client) => ws.emit('connection', client));
});
ws.on('connection', (client) => {
  let pongs = 0;
  client.on('pong', () => pongs++);
  const ping = setInterval(() => client.ping(), 200);
  const pump = () => {
    if (client.readyState !== client.OPEN) return;
    client.send(payload, { binary: true }, (error) => {
      if (!error) setImmediate(pump);
    });
  };
  pump();
  client.on('close', () => {
    clearInterval(ping);
    console.log(JSON.stringify({ event: 'fixture-disconnect', controlPongs: pongs }));
  });
});
server.listen(9443, '127.0.0.1', () => console.log('Synthetic U0 WSS fixture, loopback only, port 9443'));
process.on('SIGTERM', () => {
  for (const client of ws.clients) client.terminate();
  server.close();
});
