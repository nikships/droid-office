import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactoryError } from '../src/server/factory/api.js';
import { FactoryOffice, accountOf, capabilityFromError } from '../src/server/factory/office.js';
import { capabilityOf, factoryCan, emptyFactoryState } from '../src/shared/factory.js';

const KEY = 'fk-test-office-key-9z8y';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const USERS = {
  users: [
    { id: 'user_owner', email: 'owner@example.com', firstName: 'Olive', lastName: 'Owner', createdAt: '2026-01-01T00:00:00Z', metadata: {} },
    { id: 'user_other', email: 'other@example.com', firstName: 'Otto', createdAt: '2026-01-01T00:00:00Z', metadata: {} },
  ],
  pagination: { hasMore: false, nextCursor: null },
};
const COMPUTERS = { computers: [{ id: 'c1', name: 'orb', providerType: 'e2b', status: 'active', createdAt: 1, ownerPrincipalKind: 'human', ownerId: 'user_owner' }] };

type Handler = (url: URL) => Response | Promise<Response>;

/** Factory as a test sees it: an answer per path, the real account's shapes by default. */
function factory(overrides: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    '/api/v0/computers/providers': () => json(200, { providers: ['e2b'] }),
    '/api/v0/computers': () => json(200, COMPUTERS),
    '/api/v0/sessions': () => json(200, { sessions: [], pagination: { hasMore: false } }),
    '/api/v0/automations/ci/repository-owners': () => json(200, { owners: [{ login: 'olive', type: 'user' }], integration: { connected: true } }),
    '/api/v0/wiki': () => json(200, { wikiRuns: [] }),
    '/api/v0/organization/users': () => json(200, USERS),
    '/api/v0/service-accounts': () => json(402, { detail: 'Remote delegations require a Teams plan or higher', status: 402, title: 'Payment Required' }),
    ...overrides,
  };
  const seen: string[] = [];
  const keys: string[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    keys.push((init.headers as Record<string, string>).authorization);
    const r = routes[url.pathname];
    return r ? r(url) : json(404, { detail: 'no route' });
  }) as typeof fetch;
  return { fn, seen, keys };
}

const reject401 = () => json(401, { detail: 'Api key not found or deleted', status: 401, title: 'Unauthorized' });
const ALL_401: Record<string, Handler> = Object.fromEntries(
  ['/api/v0/computers/providers', '/api/v0/computers', '/api/v0/sessions', '/api/v0/automations/ci/repository-owners', '/api/v0/wiki', '/api/v0/organization/users', '/api/v0/service-accounts'].map((p) => [p, reject401]),
);

function tmp(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-office-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('connecting checks the key, saves it 0600 and never hands it out', async (t) => {
  const dir = tmp(t);
  const sessions = deferred<Response>();
  const fake = factory({ '/api/v0/sessions': () => sessions.promise });
  let changes = 0;
  const office = new FactoryOffice(dir, { fetchImpl: fake.fn, onChange: () => changes++ });
  assert.deepEqual(office.connection(), { connected: false, capabilities: [] });
  assert.equal(office.client(), undefined);

  const error = await office.connect(`  ${KEY}\n`, 'Olive');
  assert.equal(error, undefined);
  assert.ok(changes >= 1);
  assert.ok(
    fake.keys.every((k) => k === `Bearer ${KEY}`),
    'the key is trimmed',
  );
  const file = path.join(dir, 'factory.json');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).key, KEY);

  const conn = office.connection();
  assert.ok(!JSON.stringify(conn).includes(KEY), 'browsers never get the key');
  assert.equal(conn.connected, true);
  assert.equal(conn.fingerprint, 'fk-…9z8y');
  assert.deepEqual(conn.account, { id: 'user_owner', name: 'Olive Owner', email: 'owner@example.com' });
  assert.equal(conn.members, 2);
  assert.equal(conn.by, 'Olive');
  assert.ok(conn.at && conn.checkedAt);
  assert.deepEqual(
    conn.capabilities.map((c) => c.group),
    ['computers', 'sessions', 'ci', 'wiki', 'organization', 'serviceAccounts'],
  );
  assert.equal(capabilityOf(conn, 'computers')?.status, 'ok');
  assert.equal(capabilityOf(conn, 'computers')?.reason, 'Can make e2b computers');
  assert.equal(capabilityOf(conn, 'ci')?.reason, 'GitHub connected');
  assert.equal(capabilityOf(conn, 'organization')?.reason, '2 members');
  const sa = capabilityOf(conn, 'serviceAccounts');
  assert.equal(sa?.status, 'denied');
  assert.equal(sa?.reason, 'Needs a Teams plan');
  assert.equal(sa?.httpStatus, 402);
  assert.match(sa?.detail ?? '', /Teams plan/);
  // The reply didn't wait on the slow sessions call.
  assert.equal(capabilityOf(conn, 'sessions')?.status, 'checking');
  assert.ok(factoryCan(conn, 'sessions'));
  assert.ok(!factoryCan(conn, 'serviceAccounts'));

  const before = changes;
  sessions.resolve(json(200, { sessions: [], pagination: { hasMore: false } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(capabilityOf(office.connection(), 'sessions')?.status, 'ok');
  assert.ok(changes > before);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).capabilities.find((c: { group: string }) => c.group === 'sessions').status, 'ok');
  assert.ok(office.client());
});

test('a key Factory turns down (401) is refused and nothing is saved', async (t) => {
  const dir = tmp(t);
  const office = new FactoryOffice(dir, { fetchImpl: factory(ALL_401).fn });
  const error = await office.connect(KEY, 'Olive');
  assert.match(error ?? '', /didn’t accept that key \(401\): Api key not found or deleted/);
  assert.ok(!error?.includes(KEY));
  assert.equal(office.connection().connected, false);
  assert.ok(!existsSync(path.join(dir, 'factory.json')));
});

test('a key that doesn’t look like one is refused before asking Factory', async (t) => {
  const fake = factory();
  const office = new FactoryOffice(tmp(t), { fetchImpl: fake.fn });
  assert.match((await office.connect('short', 'x')) ?? '', /doesn’t look like a Factory API key/);
  assert.match((await office.connect('has a space in it', 'x')) ?? '', /doesn’t look like/);
  assert.equal(fake.seen.length, 0);
});

test('no answer at all says Factory couldn’t be reached', async (t) => {
  const fn = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  }) as typeof fetch;
  const office = new FactoryOffice(tmp(t), { fetchImpl: fn });
  assert.match((await office.connect(KEY, 'x')) ?? '', /Couldn’t reach Factory.*ENOTFOUND/);
  assert.equal(office.connection().connected, false);
});

test('the saved key comes back at the next start, and a later 401 reads as rejected until checked again', async (t) => {
  const dir = tmp(t);
  const first = new FactoryOffice(dir, { fetchImpl: factory().fn });
  assert.equal(await first.connect(KEY, 'Olive'), undefined);
  await new Promise((r) => setTimeout(r, 5));

  let mode: 'ok' | '401' = 'ok';
  const fake = factory(Object.fromEntries(Object.keys(ALL_401).map((p) => [p, (u: URL) => (mode === '401' ? reject401() : factory().fn(u.href))])) as Record<string, Handler>);
  let changes = 0;
  const office = new FactoryOffice(dir, { fetchImpl: fake.fn, onChange: () => changes++ });
  const conn = office.connection();
  assert.equal(conn.connected, true);
  assert.equal(conn.by, 'Olive');
  assert.equal(conn.account?.name, 'Olive Owner');
  assert.ok(office.client());

  office.rejected(new FactoryError('nope', 401, 'Unauthorized', 'Api key not found or deleted'));
  assert.equal(office.client(), undefined);
  assert.equal(office.connection().rejected, 'Api key not found or deleted');
  assert.equal(changes, 1);
  office.rejected(new FactoryError('again', 401));
  assert.equal(changes, 1, 'rejected once is enough');
  assert.equal(new FactoryOffice(dir, { fetchImpl: fake.fn }).connection().rejected, 'Api key not found or deleted', 'it stays rejected across a restart');

  // Checking again with a key that works again clears it.
  const checking = office.check();
  assert.equal(office.connection().checking, true);
  assert.equal(office.check(), checking, 'one check at a time');
  await checking;
  assert.equal(office.connection().rejected, undefined);
  assert.equal(office.connection().checking, undefined);
  assert.ok(office.client());

  // And with one Factory turns down, it reads as rejected.
  mode = '401';
  await office.check();
  assert.equal(office.connection().rejected, 'Api key not found or deleted');
  assert.equal(office.client(), undefined);
});

test('disconnecting forgets the key and its file', async (t) => {
  const dir = tmp(t);
  const office = new FactoryOffice(dir, { fetchImpl: factory().fn });
  await office.connect(KEY, 'Olive');
  office.disconnect();
  assert.equal(office.connection().connected, false);
  assert.equal(office.client(), undefined);
  assert.ok(!existsSync(path.join(dir, 'factory.json')));
  await office.check();
  assert.equal(new FactoryOffice(dir).connection().connected, false);
});

test('a broken or keyless factory.json is no connection', (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'factory.json'), '{nope');
  assert.equal(new FactoryOffice(dir).connection().connected, false);
  writeFileSync(path.join(dir, 'factory.json'), JSON.stringify({ by: 'x' }));
  assert.equal(new FactoryOffice(dir).connection().connected, false);
  writeFileSync(
    path.join(dir, 'factory.json'),
    JSON.stringify({
      key: KEY,
      capabilities: [
        { group: 'bogus', status: 'ok' },
        { group: 'wiki', status: 'ok' },
      ],
    }),
  );
  const conn = new FactoryOffice(dir).connection();
  assert.equal(conn.by, '?');
  assert.equal(capabilityOf(conn, 'wiki')?.status, 'ok');
  assert.equal(capabilityOf(conn, 'computers')?.status, 'checking', 'groups not checked yet read as checking');
});

test('whose key it is: the human owner of its computers, else the only user', () => {
  const users = USERS.users;
  assert.equal(accountOf(users, COMPUTERS.computers)?.id, 'user_owner');
  assert.equal(accountOf(users, [{ ownerPrincipalKind: 'service-account', ownerId: 'user_other' }]), undefined);
  assert.equal(accountOf(users, []), undefined);
  assert.deepEqual(accountOf([users[1]], []), { id: 'user_other', name: 'Otto', email: 'other@example.com' });
  assert.deepEqual(accountOf([{ id: 'u', email: 'only@example.com' }], [null, 'x']), { id: 'u', name: 'only@example.com', email: 'only@example.com' });
  assert.equal(accountOf([{ id: 'u' }], [])?.name, 'Unknown');
});

test('a probe’s error becomes no access with why, or an error', () => {
  const at = 5;
  assert.deepEqual(capabilityFromError('ci', new FactoryError('x', 402, 'Payment Required', 'Needs a Pro plan'), at), {
    group: 'ci',
    httpStatus: 402,
    checkedAt: at,
    detail: 'Needs a Pro plan',
    status: 'denied',
    reason: 'Needs another Factory plan',
  });
  assert.equal(capabilityFromError('ci', new FactoryError('x', 403), at).reason, 'The key’s account isn’t allowed to');
  assert.equal(capabilityFromError('ci', new FactoryError('x', 401), at).reason, 'Key rejected');
  assert.equal(capabilityFromError('ci', new FactoryError('x', 404), at).status, 'denied');
  const e = capabilityFromError('ci', new FactoryError('Factory answered 500.', 500), at);
  assert.equal(e.status, 'error');
  assert.equal(e.reason, 'Factory answered 500.');
  assert.equal(capabilityFromError('wiki', new Error('weird'), at).httpStatus, 0);
});

test('a GitHub that isn’t connected, and an organization with more pages, say so', async (t) => {
  const fake = factory({
    '/api/v0/automations/ci/repository-owners': () => json(200, { owners: [], integration: { connected: false } }),
    '/api/v0/organization/users': () => json(200, { users: [USERS.users[0]], pagination: { hasMore: true, nextCursor: 'n' } }),
    '/api/v0/computers/providers': () => json(200, { providers: [] }),
  });
  const office = new FactoryOffice(tmp(t), { fetchImpl: fake.fn });
  await office.connect(KEY, 'Olive');
  const conn = office.connection();
  assert.equal(capabilityOf(conn, 'ci')?.reason, 'GitHub isn’t connected to Factory yet');
  assert.equal(capabilityOf(conn, 'organization')?.reason, '1+ member');
  assert.equal(capabilityOf(conn, 'computers')?.reason, undefined);
  assert.equal(conn.members, 1);
  assert.equal(conn.membersMore, true);
});

test('the empty state is disconnected with empty slices', () => {
  const s = emptyFactoryState();
  assert.equal(s.connection.connected, false);
  assert.deepEqual(s.computers.items, []);
  assert.equal(s.sessions.fetchedAt, 0);
  assert.equal(s.ci.github, null);
  assert.deepEqual(s.wiki.runs, []);
  assert.ok(!factoryCan(s.connection, 'computers'));
  assert.ok(!factoryCan({ connected: true, rejected: 'x', capabilities: [] }, 'computers'));
});
