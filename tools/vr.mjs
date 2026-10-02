#!/usr/bin/env node
// `npm run vr`: puts HTTPS in front of the office already running on this machine, so a headset on
// the same Wi-Fi can enter WebXR (it refuses plain http off localhost), and prints the URL and a QR.
// Usage: npm run vr [-- <office port> [<https port>]]   (defaults 4600 and 4601)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { renderUnicodeCompact } from 'uqr';

const officePort = Number(process.argv[2]) || 4600;
const httpsPort = Number(process.argv[3]) || officePort + 1;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
  }
  // en0 is the Mac's Wi-Fi; put it first so the QR points at the network the headset is likely on.
  return out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
}

// Kept between runs so the headset only has to accept the certificate warning once.
async function certificate() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.cache', 'droid-office-vr');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'droid-office-vr' }], { days: 825, keySize: 2048 });
  mkdirSync(dir, { recursive: true });
  writeFileSync(certPath, pems.cert, { mode: 0o600 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

function officeIsUp() {
  return new Promise((resolve) => {
    const sock = net.connect(officePort, '127.0.0.1');
    sock.once('connect', () => {
      sock.end();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

if (!(await officeIsUp())) {
  console.error(`\n  Nothing is running on localhost:${officePort}. Start the office first, e.g. npm start\n`);
  process.exit(1);
}

const server = https.createServer(await certificate(), (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: officePort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.statusMessage, ur.headers);
    ur.pipe(res);
  });
  up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end(`The office on port ${officePort} isn't answering.`)));
  req.pipe(up);
});

// WebSockets: replay the handshake to the office, then join the two sockets.
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(officePort, '127.0.0.1');
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  up.on('connect', () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on('error', close);
  socket.on('error', close);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `\n  Port ${httpsPort} is taken. Pick another: npm run vr -- ${officePort} <port>\n` : err);
  process.exit(1);
});

server.listen(httpsPort, '0.0.0.0', () => {
  const addrs = lanAddresses();
  if (!addrs.length) {
    console.error('\n  This machine has no network address. Connect it to the same Wi-Fi as the headset.\n');
    process.exit(1);
  }
  const url = `https://${addrs[0].address}:${httpsPort}`;
  console.log(`\n  🕶️  Open this in the headset browser (same Wi-Fi as this machine):\n\n     ${url}\n`);
  console.log(renderUnicodeCompact(url, { border: 2 }).replace(/^/gm, '    '));
  console.log('\n  1. The browser warns about the certificate once: tap Advanced, then Proceed.');
  console.log('  2. Press 🕶️ Enter VR on the top bar.');
  const others = addrs.slice(1).map((a) => `https://${a.address}:${httpsPort}`);
  if (others.length) console.log(`\n  Other addresses of this machine: ${others.join('  ')}`);
  console.log(`\n  Forwarding to the office on localhost:${officePort}. Ctrl+C to stop.\n`);
});
