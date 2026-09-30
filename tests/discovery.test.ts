import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Service, ServiceConfig } from 'bonjour-service';
import { startDiscovery } from '../src/server/discovery.js';

class Advertisement extends EventEmitter {
  stops = 0;
  goodbye: (() => void) | undefined;
  finish = true;
  stopError = false;
  records(): ReturnType<Service['records']> {
    return [
      { name: '_droidoffice._tcp.local', type: 'PTR', ttl: 120, data: 'office._droidoffice._tcp.local' },
      { name: 'office._droidoffice._tcp.local', type: 'SRV', ttl: 120, data: { target: 'laptop.local', port: 4700 } },
      { name: 'office._droidoffice._tcp.local', type: 'TXT', ttl: 120, data: ['v=1', 'scheme=http'] },
      { name: 'laptop.local', type: 'A', ttl: 120, data: '192.168.1.10' },
      { name: 'laptop.local', type: 'A', ttl: 120, data: '10.0.0.9' },
      { name: 'laptop.local', type: 'AAAA', ttl: 120, data: '2001:db8::2' },
      { name: 'laptop.local', type: 'AAAA', ttl: 120, data: 'fe80::2' },
      { name: 'laptop.local', type: 'A', ttl: 120, data: '100.100.1.2' },
      { name: 'laptop.local', type: 'AAAA', ttl: 120, data: 'fd7a::2' },
      { name: 'laptop.local', type: 'A', ttl: 120, data: '172.17.0.1' },
    ];
  }
  stop(callback: () => void) {
    this.stops++;
    if (this.stopError) throw new Error('socket unavailable');
    this.goodbye = callback;
    if (this.finish) callback();
  }
}

function fixture(
  t: TestContext,
  options: { cfg?: Parameters<typeof startDiscovery>[0]; address?: AddressInfo | string | null; hostname?: string; createError?: boolean; publishError?: boolean; destroyError?: boolean; earlyError?: boolean; noLan?: boolean } = {},
) {
  const published: ServiceConfig[] = [];
  const warnings: string[] = [];
  const service = new Advertisement();
  let creates = 0;
  let destroys = 0;
  let onError = (_error: unknown) => {};
  const office = startDiscovery(options.cfg ?? { discovery: true }, options.address === undefined ? { address: '0.0.0.0', family: 'IPv4', port: 4700 } : options.address, {
    hostname: () => options.hostname ?? 'Ada-Laptop.local',
    interfaces: () =>
      options.noLan
        ? { lo0: [{ address: '127.0.0.1', internal: true }] }
        : {
            en0: [
              { address: '192.168.1.10', internal: false },
              { address: '2001:db8::2', internal: false },
            ],
            'Wi-Fi': [
              { address: '10.0.0.9', internal: false },
              { address: 'fe80::2', internal: false },
            ],
            tailscale0: [{ address: '100.100.1.2', internal: false }],
            utun9: [{ address: 'fd7a::2', internal: false }],
            docker0: [{ address: '172.17.0.1', internal: false }],
          },
    warn: (message) => warnings.push(message),
    create(error) {
      creates++;
      if (options.createError) throw new Error('multicast forbidden');
      onError = error;
      if (options.earlyError) error(new Error('multicast forbidden'));
      return {
        publish(config) {
          published.push(config);
          if (options.publishError) throw new Error('publish failed');
          return service;
        },
        destroy() {
          destroys++;
          if (options.destroyError) throw new Error('socket already closed');
        },
      };
    },
  });
  t.after(() => office.stop());
  return { office, service, published, warnings, creates: () => creates, destroys: () => destroys, error: (error: unknown) => onError(error) };
}

test('advertises the laptop and actual port with only version and scheme TXT fields', (t) => {
  const cfg = { discovery: true, port: 4600, password: 'private', secret: 'private', project: '/private/project', agentArgs: ['private'] };
  const { published } = fixture(t, { cfg });
  assert.deepEqual(published, [
    {
      name: 'Droid Office on Ada-Laptop (4700)',
      type: 'droidoffice',
      protocol: 'tcp',
      port: 4700,
      host: 'ada-laptop-office-4700.local',
      txt: { v: '1', scheme: 'http' },
      disableIPv6: true,
    },
  ]);
});

test('HTTPS advertises its own scheme and the actual listening port', (t) => {
  const { published } = fixture(t, { cfg: { discovery: true, tls: { cert: 'private', key: 'private' } }, address: { address: '::', family: 'IPv6', port: 54321 } });
  assert.equal(published[0].port, 54321);
  assert.deepEqual(published[0].txt, { v: '1', scheme: 'https' });
  assert.equal(published[0].disableIPv6, false);
});

test('disabled discovery creates no transport, and stop remains safe', (t) => {
  const f = fixture(t, { cfg: { discovery: false } });
  f.office.stop();
  f.office.stop();
  assert.equal(f.creates(), 0);
  assert.deepEqual(f.published, []);
  assert.equal(f.destroys(), 0);
});

for (const address of ['127.0.0.1', '127.8.9.10', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1']) {
  test(`loopback bind ${address} never advertises`, (t) => {
    const f = fixture(t, { address: { address, family: 'IPv6', port: 4700 } });
    assert.equal(f.creates(), 0);
    assert.deepEqual(f.published, []);
  });
}

for (const address of [null, '/tmp/private.sock']) {
  test(`a non-TCP or not-yet-listening server (${address}) never advertises`, (t) => {
    const f = fixture(t, { address });
    assert.equal(f.creates(), 0);
  });
}

test('IPv4 wildcard advertising retains only IPv4 addresses and the service records', (t) => {
  const { service } = fixture(t);
  assert.deepEqual(
    service.records().map((record) => record.type),
    ['PTR', 'SRV', 'TXT', 'A', 'A'],
  );
});

test('dual-stack wildcard advertising retains IPv4 and IPv6 addresses', (t) => {
  const { service } = fixture(t, { address: { address: '::', family: 'IPv6', port: 4700 } });
  assert.deepEqual(
    service.records().map((record) => record.type),
    ['PTR', 'SRV', 'TXT', 'A', 'A', 'AAAA', 'AAAA'],
  );
});

test('wildcard advertisements exclude VPN and container addresses while retaining LAN adapters', (t) => {
  const { service } = fixture(t, { address: { address: '::', family: 'IPv6', port: 4700 } });
  assert.deepEqual(
    service
      .records()
      .filter((record) => record.type === 'A' || record.type === 'AAAA')
      .map((record) => record.data),
    ['192.168.1.10', '10.0.0.9', '2001:db8::2', 'fe80::2'],
  );
});

test('a wildcard bind with no LAN adapters opens no multicast socket', (t) => {
  const f = fixture(t, { noLan: true });
  assert.equal(f.creates(), 0);
  assert.deepEqual(f.published, []);
});

test('an explicit VPN bind remains exact when the operator requests it', (t) => {
  const { service } = fixture(t, { address: { address: '100.100.1.2', family: 'IPv4', port: 4700 } });
  assert.deepEqual(
    service
      .records()
      .filter((record) => record.type === 'A' || record.type === 'AAAA')
      .map((record) => record.data),
    ['100.100.1.2'],
  );
});

for (const address of ['192.168.1.10', '::ffff:192.168.1.10']) {
  test(`bind ${address} advertises just its reachable address`, (t) => {
    const { service } = fixture(t, { address: { address, family: 'IPv4', port: 4700 } });
    assert.deepEqual(
      service
        .records()
        .filter((record) => record.type === 'A' || record.type === 'AAAA')
        .map((record) => record.data),
      ['192.168.1.10'],
    );
  });
}

test('a specific IPv6 bind uses its canonical address and omits other interfaces', (t) => {
  const { service } = fixture(t, { address: { address: '2001:0db8:0:0:0:0:0:2', family: 'IPv6', port: 4700 } });
  assert.deepEqual(
    service
      .records()
      .filter((record) => record.type === 'A' || record.type === 'AAAA')
      .map((record) => record.data),
    ['2001:db8::2'],
  );
});

test('long hostnames fit DNS labels even with a five-digit port', (t) => {
  const { published } = fixture(t, { hostname: `${'Laptop'.repeat(25)}.example`, address: { address: '0.0.0.0', family: 'IPv4', port: 65535 } });
  assert.ok(Buffer.byteLength(published[0].name) <= 63);
  assert.ok(Buffer.byteLength(published[0].host!.split('.')[0]) <= 63);
  assert.match(published[0].name, /\(65535\)$/);
});

test('a transport startup failure is best-effort and leaves the office running', (t) => {
  const f = fixture(t, { createError: true });
  f.office.stop();
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /nearby discovery unavailable.*multicast forbidden/);
  assert.deepEqual(f.published, []);
});

test('an error during transport creation still closes the returned transport once', (t) => {
  const f = fixture(t, { earlyError: true });
  f.office.stop();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.destroys(), 1);
  assert.deepEqual(f.published, []);
});

test('a publication failure destroys the transport without throwing', (t) => {
  const f = fixture(t, { publishError: true });
  assert.equal(f.warnings.length, 1);
  assert.equal(f.destroys(), 1);
  f.office.stop();
  assert.equal(f.destroys(), 1);
});

test('asynchronous multicast errors stop and destroy discovery once', (t) => {
  const f = fixture(t);
  f.error(new Error('network unavailable'));
  f.error(new Error('late error'));
  f.service.emit('error', new Error('late publication error'));
  f.office.stop();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.service.stops, 1);
  assert.equal(f.destroys(), 1);
});

test('service publication errors also stop discovery without crashing the office', (t) => {
  const f = fixture(t);
  f.service.emit('error', new Error('publish unavailable'));
  assert.equal(f.warnings.length, 1);
  assert.equal(f.service.stops, 1);
  assert.equal(f.destroys(), 1);
});

test('shutdown waits for the library goodbye and is idempotent', (t) => {
  const f = fixture(t);
  f.service.finish = false;
  f.office.stop();
  f.office.stop();
  assert.equal(f.service.stops, 1);
  assert.equal(f.destroys(), 0);
  f.service.goodbye!();
  f.service.goodbye!();
  f.office.stop();
  assert.equal(f.destroys(), 1);
});

test('shutdown closes the socket even when goodbye never completes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.service.finish = false;
  f.office.stop();
  t.mock.timers.tick(149);
  assert.equal(f.destroys(), 0);
  t.mock.timers.tick(1);
  assert.equal(f.destroys(), 1);
  f.service.goodbye!();
  f.office.stop();
  assert.equal(f.destroys(), 1);
});

test('shutdown tolerates a failing goodbye or an already-closed socket', (t) => {
  const f = fixture(t, { destroyError: true });
  f.service.stopError = true;
  assert.doesNotThrow(() => f.office.stop());
  f.office.stop();
  assert.equal(f.service.stops, 1);
  assert.equal(f.destroys(), 1);
});
