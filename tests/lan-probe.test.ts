import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { tcpReachable, reachableLan } from './lan-probe.js';

test('the LAN probe checks TCP reachability, not whether HTTP authorizes the caller', async (t) => {
  const server = createServer((_req, res) => res.writeHead(401).end());
  server.listen(0, '127.0.0.1');
  t.after(() => {
    if (server.listening) server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(await tcpReachable('127.0.0.1', address.port), true);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}`)).status, 401);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await tcpReachable('127.0.0.1', address.port), false);
});

test('a broken LAN listener fails instead of skipping its integration checks', async () => {
  const server = createServer();
  const skip = () => assert.fail('a broken listener must not be treated as unavailable LAN networking');
  await assert.rejects(reachableLan({ skip }, server), /office must be listening/);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(reachableLan({ skip }, server), /bind all IPv4 interfaces/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
