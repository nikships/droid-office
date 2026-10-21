import assert from 'node:assert/strict';
import { createConnection, type Server } from 'node:net';
import { lanIPv4s } from '../src/server/lan.js';

/** Probe transport only: an HTTP/auth regression must fail the integration test, never skip it. */
export function tcpReachable(host: string, port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/** Some hosts advertise a LAN address but firewall or deny connections back to it (e.g. macOS). */
export async function reachableLan(t: { skip(reason: string): unknown }, server: Server): Promise<string | undefined> {
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'the office must be listening');
  assert.equal(address.address, '0.0.0.0', 'the LAN office must bind all IPv4 interfaces');
  const ips = lanIPv4s();
  for (const ip of ips) if (await tcpReachable(ip, address.port)) return ip;
  assert.equal(server.listening, true, 'the office must still be listening after the probe');
  t.skip(ips.length ? 'this environment cannot connect to its own LAN interfaces' : 'no LAN address to arrive from');
}
