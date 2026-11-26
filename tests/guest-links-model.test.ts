import test from 'node:test';
import assert from 'node:assert/strict';
import { auditActionText, auditTargetText, checkDraft, countdown, createBlocked, expiryView, guestCountText, linkEnded, appendAudit, refreshAudit, scopeText, tickDelay, transportView } from '../src/client/ui/guest-links-model.js';
import { GUEST_LABEL_MAX, type GuestAuditEntry, type GuestLinkItem, type GuestTargetFloor } from '../src/shared/guest-links.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const link = (over: Partial<GuestLinkItem> = {}): GuestLinkItem => ({ id: 'l1', label: 'Alex', preset: 'view-office', createdAt: at(-HOUR), status: 'active', guests: 0, ...over });
const serving = { status: 'serving' as const, origin: 'https://box.tail.ts.net:8443' };
const targets: GuestTargetFloor[] = [
  { id: 'f1', name: 'Main', workers: [{ id: 'w1', name: 'Ada' }] },
  { id: 'f2', name: 'Empty', workers: [] },
];

test('transport states read as plain words, with the origin and fix link only where they apply', () => {
  assert.equal(transportView(false, { status: 'off' }).pill, 'Off');
  assert.equal(transportView(true, { status: 'starting' }).pill, 'Starting');
  const live = transportView(true, serving);
  assert.deepEqual([live.pill, live.tone, live.origin], ['Live', 'good', serving.origin]);
  const down = transportView(true, { status: 'unavailable', reason: 'Funnel is not enabled for this machine.', fixUrl: 'https://login.tailscale.com/f/funnel' });
  assert.deepEqual([down.pill, down.text, down.fixUrl], ['Unavailable', 'Funnel is not enabled for this machine.', 'https://login.tailscale.com/f/funnel']);
  assert.equal(transportView(true, { status: 'unavailable' }).fixUrl, undefined);
  const locked = transportView(true, { status: 'off', locked: 'Disabled by DROID_OFFICE_GUEST_SHARING=off.' });
  assert.deepEqual([locked.pill, locked.text], ['Locked', 'Disabled by DROID_OFFICE_GUEST_SHARING=off.']);
  // Off wins over a stale serving transport, and never shows the origin.
  assert.equal(transportView(false, serving).origin, undefined);
});

test('creation is blocked with a reason unless sharing is on, serving and under the cap', () => {
  const base = { on: true, transport: serving, links: [] as GuestLinkItem[], max: 2 };
  assert.equal(createBlocked(base, NOW), undefined);
  assert.match(createBlocked({ ...base, on: false }, NOW) ?? '', /Turn on external sharing/);
  assert.match(createBlocked({ ...base, transport: { status: 'starting' } }, NOW) ?? '', /finish publishing/);
  assert.match(createBlocked({ ...base, transport: { status: 'unavailable', reason: 'x' } }, NOW) ?? '', /Funnel/);
  assert.match(createBlocked({ ...base, transport: { status: 'off', locked: 'locked' } }, NOW) ?? '', /locked/);
  assert.match(createBlocked({ ...base, links: [link(), link({ id: 'l2' })] }, NOW) ?? '', /2 active share links/);
  // Ended links don't count toward the cap, including ones past expiry the server hasn't marked yet.
  assert.equal(createBlocked({ ...base, links: [link(), link({ id: 'l2', status: 'revoked' })] }, NOW), undefined);
  assert.equal(createBlocked({ ...base, links: [link(), link({ id: 'l3', expiresAt: at(-1) })] }, NOW), undefined);
});

test('countdown shows the two largest units', () => {
  assert.equal(countdown(0), '0s');
  assert.equal(countdown(40_500), '40s');
  assert.equal(countdown(12 * MIN), '12m');
  assert.equal(countdown(2 * HOUR), '2h');
  assert.equal(countdown(2 * HOUR + 5 * MIN), '2h 5m');
  assert.equal(countdown(3 * 24 * HOUR + 4 * HOUR), '3d 4h');
  assert.equal(countdown(7 * 24 * HOUR), '7d');
});

test('expiry status ticks from this clock without a refetch', () => {
  assert.deepEqual(expiryView(link(), NOW), { text: 'Until revoked', tone: 'info', ended: false });
  assert.deepEqual(expiryView(link({ expiresAt: at(24 * HOUR) }), NOW), { text: 'Expires in 1d', tone: 'info', ended: false });
  assert.deepEqual(expiryView(link({ expiresAt: at(24 * HOUR) }), NOW + 1), { text: 'Expires in 23h 59m', tone: 'info', ended: false });
  assert.deepEqual(expiryView(link({ expiresAt: at(30 * MIN) }), NOW), { text: 'Expires in 30m', tone: 'warn', ended: false });
  assert.deepEqual(expiryView(link({ expiresAt: at(30 * MIN) }), NOW + 30 * MIN), { text: 'Expired', tone: 'warn', ended: true });
  assert.deepEqual(expiryView(link({ status: 'expired', expiresAt: at(-1) }), NOW), { text: 'Expired', tone: 'warn', ended: true });
  assert.deepEqual(expiryView(link({ status: 'revoked', expiresAt: at(HOUR) }), NOW), { text: 'Revoked', tone: 'bad', ended: true });
  assert.equal(linkEnded(link({ expiresAt: at(1) }), NOW), false);
  assert.equal(linkEnded(link({ expiresAt: at(0) }), NOW), true);
});

test('tick delay lands on the next visible change', () => {
  assert.equal(tickDelay([link(), link({ status: 'revoked', expiresAt: at(HOUR) })], NOW), undefined);
  // 2h 30m 20s left: the minute digit changes in 20s.
  assert.equal(tickDelay([link({ expiresAt: at(150 * MIN + 20_000) })], NOW), 20_050);
  // Last minute: every second.
  assert.equal(tickDelay([link({ expiresAt: at(30_400) })], NOW), 450);
  assert.equal(tickDelay([link({ expiresAt: at(30_000) })], NOW), 1050);
  // The soonest of several, never faster than 250ms.
  assert.equal(tickDelay([link({ expiresAt: at(5 * MIN) }), link({ expiresAt: at(10_010) })], NOW), 250);
});

test('scope names the preset and its floor or worker, or that they are gone', () => {
  assert.equal(scopeText(link()), 'View only (entire office)');
  assert.equal(scopeText(link({ preset: 'edit-office' })), 'Complete access overall');
  assert.equal(scopeText(link({ preset: 'view-floor', floorId: 'f1', floorName: 'Main' })), 'View only (single floor) · Main');
  assert.equal(scopeText(link({ preset: 'edit-floor', floorId: 'f1' })), 'Single floor (full read & write) · floor closed');
  assert.equal(scopeText(link({ preset: 'view-worker', floorId: 'f1', floorName: 'Main', workerId: 'w1', workerName: 'Ada' })), 'View only (single worker) · Ada on Main');
  assert.equal(scopeText(link({ preset: 'view-worker', floorId: 'f1', floorName: 'Main', workerId: 'w1' })), 'View only (single worker) · worker left on Main');
  assert.equal(scopeText(link({ preset: 'view-worker', floorId: 'f1', workerId: 'w1' })), 'View only (single worker) · worker left (floor closed)');
});

test('guest counts read naturally', () => {
  assert.equal(guestCountText(0), 'No guests connected');
  assert.equal(guestCountText(1), '1 guest connected');
  assert.equal(guestCountText(3), '3 guests connected');
});

test('the create form needs a label, a preset and the targets that preset needs', () => {
  const draft = { label: '  Alex   - PR review ', preset: 'view-office' as const, floorId: '', workerId: '', expiry: '24h' as const };
  assert.deepEqual(checkDraft(draft, targets), { ok: true, body: { label: 'Alex - PR review', preset: 'view-office', expiry: '24h' } });
  assert.deepEqual(checkDraft({ ...draft, label: '   ' }, targets), { ok: false, field: 'label', error: 'Give the link a label, like who it’s for.' });
  assert.equal(checkDraft({ ...draft, label: 'x'.repeat(GUEST_LABEL_MAX) }, targets).ok, true);
  assert.deepEqual(checkDraft({ ...draft, label: 'x'.repeat(GUEST_LABEL_MAX + 1) }, targets), { ok: false, field: 'label', error: `Keep the label to ${GUEST_LABEL_MAX} characters.` });
  assert.equal(checkDraft({ ...draft, preset: '' }, targets).ok, false);
  // Floor presets need an open floor, and drop any worker.
  assert.deepEqual(checkDraft({ ...draft, preset: 'view-floor' }, targets), { ok: false, field: 'floor', error: 'Choose a floor.' });
  assert.deepEqual(checkDraft({ ...draft, preset: 'edit-floor', floorId: 'f1', workerId: 'w1' }, targets), { ok: true, body: { label: 'Alex - PR review', preset: 'edit-floor', floorId: 'f1', expiry: '24h' } });
  assert.deepEqual(checkDraft({ ...draft, preset: 'view-floor', floorId: 'gone' }, []), { ok: false, field: 'floor', error: 'No floor is open to share.' });
  // The single-worker preset needs a worker that is on the chosen floor right now.
  assert.deepEqual(checkDraft({ ...draft, preset: 'view-worker', floorId: 'f1' }, targets), { ok: false, field: 'worker', error: 'Choose a worker.' });
  assert.deepEqual(checkDraft({ ...draft, preset: 'view-worker', floorId: 'f2', workerId: 'w1' }, targets), { ok: false, field: 'worker', error: 'No workers are on Empty.' });
  assert.deepEqual(checkDraft({ ...draft, preset: 'view-worker', floorId: 'f1', workerId: 'w1', expiry: 'never' }, targets), {
    ok: true,
    body: { label: 'Alex - PR review', preset: 'view-worker', floorId: 'f1', workerId: 'w1', expiry: 'never' },
  });
  // Office presets drop floor and worker even if the form still holds them.
  assert.deepEqual(checkDraft({ ...draft, preset: 'edit-office', floorId: 'f1', workerId: 'w1', expiry: '7d' }, targets), { ok: true, body: { label: 'Alex - PR review', preset: 'edit-office', expiry: '7d' } });
});

const entry = (id: string, over: Partial<GuestAuditEntry> = {}): GuestAuditEntry => ({
  id,
  at: at(0),
  linkId: 'l1',
  linkLabel: 'Alex',
  preset: 'edit-floor',
  target: { kind: 'floor', floorId: 'f1', floorName: 'Main' },
  action: 'prompt',
  ...over,
});

test('audit entries name their target and action, with burst counts', () => {
  assert.equal(auditTargetText({ kind: 'missionControl' }), 'Mission Control');
  assert.equal(auditTargetText({ kind: 'floor', floorId: 'f1', floorName: 'Main' }), 'Main');
  assert.equal(auditTargetText({ kind: 'worker', floorId: 'f1', floorName: 'Main', workerId: 'w1', workerName: 'Ada' }), 'Ada on Main');
  assert.equal(auditTargetText({ kind: 'worker', floorId: 'f1', workerId: 'w1' }), 'w1 on f1');
  assert.equal(auditActionText({ action: 'prompt' }), 'Prompt sent');
  assert.equal(auditActionText({ action: 'tty', count: 1 }), 'Terminal input');
  assert.equal(auditActionText({ action: 'tty', count: 42 }), 'Terminal input ×42');
  assert.equal(auditActionText({ action: 'permission.deny' }), 'Permission denied');
});

test('audit pages append older entries without repeating ones already shown', () => {
  const merged = appendAudit([entry('c'), entry('b')], [entry('b'), entry('a')]);
  assert.deepEqual(
    merged.map((e) => e.id),
    ['c', 'b', 'a'],
  );
});

test('an audit refresh puts new entries on top and updates a growing burst in place', () => {
  const shown = [entry('c', { action: 'tty', count: 3 }), entry('b'), entry('a')];
  const { entries, reset } = refreshAudit(shown, [entry('d'), entry('c', { action: 'tty', count: 9 })]);
  assert.equal(reset, false);
  assert.deepEqual(
    entries.map((e) => [e.id, e.count]),
    [
      ['d', undefined],
      ['c', 9],
      ['b', undefined],
      ['a', undefined],
    ],
  );
  // A page that doesn't reach what's shown starts over, so no gap hides entries in between.
  assert.deepEqual(refreshAudit(shown, [entry('z'), entry('y')]), { entries: [entry('z'), entry('y')], reset: true });
  assert.deepEqual(refreshAudit([], [entry('a')]), { entries: [entry('a')], reset: true });
  // An empty page changes nothing shown.
  assert.deepEqual(refreshAudit(shown, []), { entries: shown, reset: false });
});
