import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GUEST_FAIL_WINDOW_MS, GUEST_FAILS_PER_SOURCE, GUEST_LINKS_FILE, GuestLinks, cleanGuestLabel, guestTokenOf, type GuestNames } from '../src/server/guest-links.js';
import { GUEST_AUDIT_FILE, GUEST_AUDIT_OLD_FILE, GUEST_TTY_BURST_MS, GuestAudit, auditDetail, ttyPreview } from '../src/server/guest-audit.js';
import {
  GUEST_AUDIT_DETAIL_MAX,
  GUEST_CLOSE_DISABLED,
  GUEST_CLOSE_ENDED,
  GUEST_ENDED_KEEP_MS,
  GUEST_LINKS_MAX,
  GUEST_PRESETS,
  GUEST_WS_PROTOCOL,
  guestCanWrite,
  guestIncludesMissionControl,
  guestSessionOf,
  guestShareUrl,
  guestTokenFromHash,
  guestWsProtocols,
} from '../src/shared/guest-links.js';

const HOUR = 60 * 60 * 1000;
const names: GuestNames = ({ floorId, workerId }) => ({
  ...(floorId === 'floor-a' ? { floorName: 'Droid Office' } : {}),
  ...(floorId === 'floor-a' && workerId === 'w1' ? { workerName: 'Pixel' } : {}),
});

function rig(t: TestContext) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guest-links-'));
  const clock = { now: Date.parse('2026-11-25T12:00:00Z') };
  const make = () => new GuestLinks({ dataDir, names, now: () => clock.now, timers: false });
  const links = make();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, clock, links, make, file: path.join(dataDir, GUEST_LINKS_FILE) };
}

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;

function created(links: GuestLinks, input: Partial<Parameters<GuestLinks['create']>[0]> = {}) {
  const made = links.create({ label: 'Alex - PR review', preset: 'view-office', expiry: 'never', ...input });
  assert.ok(made.ok, made.ok ? '' : made.error);
  return made;
}

test('presets, share URLs and sessions follow the contract', () => {
  assert.deepEqual(GUEST_PRESETS, ['view-office', 'view-worker', 'view-floor', 'edit-floor', 'edit-office']);
  assert.deepEqual(GUEST_PRESETS.filter(guestCanWrite), ['edit-floor', 'edit-office']);
  assert.deepEqual(GUEST_PRESETS.filter(guestIncludesMissionControl), ['view-office', 'edit-office']);
  const token = 'A'.repeat(43);
  const url = guestShareUrl('https://office.example.ts.net:10000/', token);
  assert.equal(url, `https://office.example.ts.net:10000/dashboard#g=${token}`);
  assert.equal(guestTokenFromHash(new URL(url).hash), token);
  assert.equal(guestTokenFromHash('#g=short'), undefined);
  assert.deepEqual(guestWsProtocols(token), [GUEST_WS_PROTOCOL, token]);
  assert.deepEqual(guestSessionOf({ preset: 'view-worker', floorId: 'f', workerId: 'w' }), { preset: 'view-worker', write: false, scope: 'worker', floorId: 'f', workerId: 'w', missionControl: false });
  assert.deepEqual(guestSessionOf({ preset: 'edit-office', floorId: 'ignored' }), { preset: 'edit-office', write: true, scope: 'office', missionControl: true });
});

test('links store only token hashes in a private file and verify across restarts', (t) => {
  const { links, make, file } = rig(t);
  assert.equal(links.on, false, 'sharing is off by default');
  links.setOn(true);
  const made = created(links, { preset: 'view-worker', floorId: 'floor-a', workerId: 'w1', label: '  Alex\n\t- PR review\u0007 ' });
  assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.link.label, 'Alex - PR review');
  assert.equal(made.link.floorName, 'Droid Office');
  assert.equal(made.link.workerName, 'Pixel');
  assert.equal(made.link.status, 'active');
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(made.token), 'the token is never written');
  assert.match(raw, /"hash": "[0-9a-f]{64}"/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const ok = links.verify(made.token);
  assert.ok(ok.ok);
  assert.deepEqual(ok.grant.session, { preset: 'view-worker', write: false, scope: 'worker', floorId: 'floor-a', workerId: 'w1', missionControl: false });
  assert.equal(ok.grant.label, 'Alex - PR review');
  assert.deepEqual(links.verify(`${made.token.slice(0, -1)}x`), { ok: false, reason: 'unavailable' });
  assert.deepEqual(links.verify(undefined), { ok: false, reason: 'unavailable' });
  assert.deepEqual(links.verify('not a token!'), { ok: false, reason: 'unavailable' });
  const again = make();
  assert.equal(again.on, true, 'the toggle persists');
  assert.ok(again.verify(made.token).ok, 'active links survive a restart');
  assert.deepEqual(
    again.list().map((l) => l.id),
    [made.link.id],
  );
});

test('the toggle blocks every link and disconnects every guest at once', (t) => {
  const { links, make } = rig(t);
  links.setOn(true);
  const a = created(links);
  const b = created(links, { preset: 'edit-floor', floorId: 'floor-a' });
  const closed: [string, number, string][] = [];
  const grantA = links.verify(a.token);
  const grantB = links.verify(b.token);
  assert.ok(grantA.ok && grantB.ok);
  links.register(grantA.grant, (code, reason) => closed.push(['a', code, reason]));
  links.register(grantB.grant, (code, reason) => closed.push(['b', code, reason]));
  assert.equal(links.liveCount(), 2);
  let changes = 0;
  links.onChange(() => changes++);
  links.setOn(false);
  assert.deepEqual(closed, [
    ['a', GUEST_CLOSE_DISABLED, 'disabled'],
    ['b', GUEST_CLOSE_DISABLED, 'disabled'],
  ]);
  assert.equal(links.liveCount(), 0);
  assert.equal(changes, 1);
  assert.deepEqual(links.verify(a.token), { ok: false, reason: 'disabled' });
  assert.equal(make().on, false);
  links.setOn(true);
  assert.ok(links.verify(a.token).ok, 'turning sharing back on reopens unrevoked links');
});

test('revoking is permanent and disconnects only that link', (t) => {
  const { links, make } = rig(t);
  links.setOn(true);
  const a = created(links);
  const b = created(links, { label: 'Sam' });
  const grantA = links.verify(a.token);
  const grantB = links.verify(b.token);
  assert.ok(grantA.ok && grantB.ok);
  const closed: string[] = [];
  links.register(grantA.grant, (code, reason) => closed.push(`a:${code}:${reason}`));
  const offB = links.register(grantB.grant, () => closed.push('b'));
  links.register(grantA.grant, (code, reason) => closed.push(`a2:${code}:${reason}`));
  assert.equal(links.liveCount(a.link.id), 2);
  assert.equal(links.revoke(a.link.id), true);
  assert.deepEqual(closed, [`a:${GUEST_CLOSE_ENDED}:revoked`, `a2:${GUEST_CLOSE_ENDED}:revoked`]);
  assert.equal(links.revoke(a.link.id), false);
  assert.equal(links.revoke('nope'), false);
  assert.deepEqual(links.verify(a.token), { ok: false, reason: 'revoked' });
  assert.equal(links.check(a.link.id), 'revoked');
  assert.equal(links.get(a.link.id)?.status, 'revoked');
  assert.equal(links.liveCount(b.link.id), 1);
  offB();
  offB();
  assert.equal(links.liveCount(), 0);
  const again = make();
  assert.deepEqual(again.verify(a.token), { ok: false, reason: 'revoked' }, 'revocation survives a restart');
  const late: [number, string][] = [];
  again.register({ linkId: a.link.id }, (code, reason) => late.push([code, reason]));
  assert.deepEqual(late, [[GUEST_CLOSE_ENDED, 'revoked']], 'a socket that raced a revoke closes at once');
});

test('expiry is checked on every verify, closes open sockets on sweep, and ended links are forgotten later', (t) => {
  const { links, clock } = rig(t);
  links.setOn(true);
  const hour = created(links, { expiry: '1h' });
  const forever = created(links, { label: 'Forever' });
  assert.equal(hour.link.expiresAt, new Date(clock.now + HOUR).toISOString());
  assert.equal(forever.link.expiresAt, undefined);
  const grant = links.verify(hour.token);
  assert.ok(grant.ok);
  assert.equal(grant.grant.session.expiresAt, hour.link.expiresAt);
  const closed: [number, string][] = [];
  links.register(grant.grant, (code, reason) => closed.push([code, reason]));
  let changes = 0;
  links.onChange(() => changes++);
  clock.now += HOUR - 1;
  assert.ok(links.verify(hour.token).ok);
  clock.now += 1;
  assert.deepEqual(links.verify(hour.token), { ok: false, reason: 'expired' });
  links.sweep();
  assert.deepEqual(closed, [[GUEST_CLOSE_ENDED, 'expired']]);
  assert.equal(changes, 1);
  links.sweep();
  assert.equal(changes, 1, 'an expiry is announced once');
  assert.equal(links.get(hour.link.id)?.status, 'expired');
  clock.now += GUEST_ENDED_KEEP_MS + 1;
  assert.deepEqual(
    links.list().map((l) => l.id),
    [forever.link.id],
  );
  assert.deepEqual(links.verify(hour.token), { ok: false, reason: 'unavailable' });
});

test('create validates labels, presets, targets, expiry and the active-link limit', (t) => {
  const { links } = rig(t);
  assert.deepEqual(links.create({ label: 'x', preset: 'view-office', expiry: 'never' }), { ok: false, status: 409, error: 'Turn on external sharing first.' });
  links.setOn(true);
  const bad = (input: Parameters<GuestLinks['create']>[0]) => {
    const r = links.create(input);
    assert.ok(!r.ok);
    return r.status;
  };
  assert.equal(bad({ label: ' \n ', preset: 'view-office', expiry: 'never' }), 400);
  assert.equal(bad({ label: 'a', preset: 'admin', expiry: 'never' }), 400);
  assert.equal(bad({ label: 'a', preset: 'view-office', expiry: '2y' }), 400);
  assert.equal(bad({ label: 'a', preset: 'view-floor', expiry: 'never' }), 400);
  assert.equal(bad({ label: 'a', preset: 'edit-floor', floorId: 'gone', expiry: 'never' }), 400);
  assert.equal(bad({ label: 'a', preset: 'view-worker', floorId: 'floor-a', workerId: 'gone', expiry: 'never' }), 400);
  assert.equal(cleanGuestLabel('x'.repeat(200)).length, 64);
  const office = created(links, { floorId: 'floor-a', workerId: 'w1' });
  assert.equal(office.link.floorId, undefined, 'office-wide links keep no target');
  for (let i = 1; i < GUEST_LINKS_MAX; i++) created(links, { label: `Link ${i}` });
  assert.equal(bad({ label: 'one more', preset: 'view-office', expiry: 'never' }), 409);
  links.revoke(office.link.id);
  created(links, { label: 'after a revoke' });
});

test('a floor or worker that is gone keeps the link valid but loses its name', (t) => {
  const { dataDir, links } = rig(t);
  links.setOn(true);
  const made = created(links, { preset: 'view-worker', floorId: 'floor-a', workerId: 'w1' });
  const emptied = new GuestLinks({ dataDir, names: () => ({}), timers: false });
  const item = emptied.get(made.link.id);
  assert.equal(item?.floorName, undefined);
  assert.equal(item?.workerName, undefined);
  assert.equal(item?.workerId, 'w1');
  assert.ok(emptied.verify(made.token).ok);
});

test('a mangled file keeps sharing off and drops malformed records', (t) => {
  const { file, make } = rig(t);
  writeFileSync(file, '{not json');
  assert.equal(make().on, false);
  writeFileSync(
    file,
    JSON.stringify({
      on: true,
      links: [
        { id: 'abcdefabcdef', hash: 'f'.repeat(64), preset: 'view-floor', createdAt: 1 },
        { id: 'zz', hash: 'f'.repeat(64), preset: 'view-office', createdAt: 1 },
        { id: '0123456789ab', hash: 'e'.repeat(64), preset: 'view-office', label: 'ok', createdAt: 1 },
      ],
    }),
  );
  const loaded = make();
  assert.equal(loaded.on, true);
  assert.deepEqual(
    loaded.list().map((l) => l.id),
    ['0123456789ab'],
  );
});

test('wrong tokens are rate limited per source, a valid token always passes, and missing tokens are not counted', (t) => {
  const { links, clock } = rig(t);
  links.setOn(true);
  const made = created(links);
  const wrong = req({ authorization: `Bearer ${'B'.repeat(43)}`, 'x-forwarded-for': '203.0.113.7' });
  for (let i = 0; i < 50; i++) assert.deepEqual(links.authenticate(req({ 'x-forwarded-for': '203.0.113.7' })), { ok: false, reason: 'unavailable' });
  for (let i = 0; i < GUEST_FAILS_PER_SOURCE; i++) assert.deepEqual(links.authenticate(wrong), { ok: false, reason: 'unavailable' });
  const limited = links.authenticate(wrong);
  assert.ok(!limited.ok);
  assert.equal(limited.reason, 'unavailable');
  assert.ok(limited.retryAfterMs! > 0 && limited.retryAfterMs! <= GUEST_FAIL_WINDOW_MS);
  assert.ok(links.authenticate(req({ authorization: `Bearer ${made.token}`, 'x-forwarded-for': '203.0.113.7' })).ok, 'a real guest behind a full bucket still gets in');
  // The shared bucket for requests without a forwarded address (only local processes) locks nobody out either.
  for (let i = 0; i <= GUEST_FAILS_PER_SOURCE; i++) links.authenticate(req({ authorization: `Bearer ${'B'.repeat(43)}` }));
  assert.ok(links.authenticate(req({ authorization: `Bearer ${'B'.repeat(43)}` })).retryAfterMs! > 0);
  assert.ok(links.authenticate(req({ authorization: `Bearer ${made.token}` })).ok);
  assert.equal(links.authenticate(req({ authorization: `Bearer ${'B'.repeat(43)}`, 'x-forwarded-for': '198.51.100.2' })).retryAfterMs, undefined, 'other sources are unaffected');
  clock.now += GUEST_FAIL_WINDOW_MS;
  assert.equal(links.authenticate(wrong).retryAfterMs, undefined, 'the window resets');
  links.setOn(false);
  assert.deepEqual(links.authenticate(req({ authorization: `Bearer ${made.token}` })), { ok: false, reason: 'disabled' });
});

test('guest tokens are read from the bearer header, the WebSocket subprotocol pair, or ?g= only when allowed', () => {
  const token = 'C'.repeat(43);
  const url = new URL(`http://x/api/thread/image?g=${token}`);
  assert.equal(guestTokenOf(req({ authorization: `Bearer ${token}` })), token);
  assert.equal(guestTokenOf(req({ 'sec-websocket-protocol': `${GUEST_WS_PROTOCOL}, ${token}` })), token);
  assert.equal(guestTokenOf(req({ 'sec-websocket-protocol': `other, ${token}` })), undefined);
  assert.equal(guestTokenOf(req(), url), undefined);
  assert.equal(guestTokenOf(req(), url, true), token);
});

function auditRig(t: TestContext, maxBytes?: number) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guest-audit-'));
  const clock = { now: Date.parse('2026-11-25T12:00:00Z') };
  let appended = 0;
  const audit = new GuestAudit({ dataDir, now: () => clock.now, timers: false, onAppend: () => appended++, ...(maxBytes ? { maxBytes } : {}) });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, clock, audit, appended: () => appended };
}
const grant = { linkId: 'abcdefabcdef', label: 'Alex - PR review', preset: 'edit-floor' as const };
const worker = { kind: 'worker' as const, floorId: 'floor-a', floorName: 'Droid Office', workerId: 'w1', workerName: 'Pixel' };

test('audit entries are private, bounded and paged newest first', (t) => {
  const { dataDir, clock, audit, appended } = auditRig(t);
  for (let i = 0; i < 7; i++) {
    audit.record({ grant, target: worker, action: 'prompt', detail: `prompt ${i}` });
    clock.now += 1000;
  }
  const long = audit.record({ grant, target: { kind: 'missionControl' }, action: 'mission', detail: `line one\nline two ${'x'.repeat(400)}` });
  assert.equal(long.detail!.length, GUEST_AUDIT_DETAIL_MAX);
  assert.ok(!long.detail!.includes('\n'));
  assert.equal(appended(), 8);
  const file = path.join(dataDir, GUEST_AUDIT_FILE);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const first = audit.read({ limit: 3 });
  assert.deepEqual(
    first.entries.map((e) => e.detail?.slice(0, 8)),
    ['line one', 'prompt 6', 'prompt 5'],
  );
  assert.equal(first.entries[1].linkLabel, 'Alex - PR review');
  assert.deepEqual(first.entries[1].target, worker);
  const second = audit.read({ before: first.next, limit: 3 });
  assert.deepEqual(
    second.entries.map((e) => e.detail),
    ['prompt 4', 'prompt 3', 'prompt 2'],
  );
  const last = audit.read({ before: second.next, limit: 3 });
  assert.deepEqual(
    last.entries.map((e) => e.detail),
    ['prompt 1', 'prompt 0'],
  );
  assert.equal(last.next, undefined);
  assert.deepEqual(audit.read({ before: 'unknown' }).entries, []);
  assert.equal(audit.read({ limit: 10_000 }).entries.length, 8);
  assert.equal(auditDetail(' \u0000 '), undefined);
});

test('the audit rotates past its size bound and keeps reading both files', (t) => {
  const { dataDir, audit } = auditRig(t, 600);
  for (let i = 0; i < 10; i++) audit.record({ grant, target: worker, action: 'git', detail: `merge ${i}` });
  const old = path.join(dataDir, GUEST_AUDIT_OLD_FILE);
  assert.ok(statSync(old).size > 0);
  assert.ok(statSync(path.join(dataDir, GUEST_AUDIT_FILE)).size < 600 + 400);
  const all = audit.read({ limit: 100 }).entries.map((e) => e.detail);
  assert.equal(all[0], 'merge 9');
  assert.ok(all.length >= 2 && all.length <= 10, 'at most two files are kept');
  writeFileSync(path.join(dataDir, GUEST_AUDIT_FILE), '{"torn":', { flag: 'a' });
  assert.equal(audit.read({ limit: 100 }).entries[0].detail, 'merge 9', 'a torn line is skipped');
});

test('terminal input is coalesced into one entry per burst per link and worker', (t) => {
  const { clock, audit, appended } = auditRig(t);
  assert.equal(ttyPreview('ls -la\r\x1b[A\x03'), 'ls -la⏎·');
  audit.tty({ grant, target: worker }, 'git sta');
  clock.now += 200;
  audit.tty({ grant, target: worker }, 'tus\r');
  audit.tty({ grant, target: { ...worker, workerId: 'w2', workerName: 'Echo' } }, 'y');
  assert.equal(appended(), 0, 'bursts are written when they end');
  const open = audit.read().entries;
  assert.equal(open.length, 2, 'open bursts are visible to the owner');
  const pixel = open.find((e) => e.target.workerId === 'w1')!;
  assert.equal(pixel.action, 'tty');
  assert.equal(pixel.count, 2);
  assert.equal(pixel.detail, 'git status⏎');
  clock.now += GUEST_TTY_BURST_MS;
  audit.tty({ grant, target: worker }, 'q');
  assert.equal(appended(), 1, 'a burst ends after its maximum length');
  audit.flush();
  assert.equal(appended(), 3);
  const entries = audit.read().entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.count),
    [1, 1, 2],
  );
  assert.equal(entries.find((e) => e.id === pixel.id)?.until, new Date(Date.parse('2026-11-25T12:00:00.200Z')).toISOString());
});
