import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_OFFERED, TOOLS, TOOL_IDS, cleanToolArgs, isAllowedToolRequest, isExternalUrl, parseNativeToTools, toolAvailability, workerActions, type ToolContext, type WorkerActionFacts } from '../src/shared/companion-tools.js';

const READY: ToolContext = { ready: true, floor: 'f1', plainFloor: false, factoryConnected: true, jiraEpic: true, upgradeAvailable: true };

test('every tool id is in the catalogue once', () => {
  assert.deepEqual(TOOLS.map((t) => t.id).sort(), [...TOOL_IDS].sort());
});

test('a tool waits for the office, and a floor tool for a floor', () => {
  assert.deepEqual(toolAvailability('issues', { ...READY, ready: false }), { available: false, reason: 'Waiting for the office to connect.' });
  assert.equal(toolAvailability('issues', { ...READY, floor: null }).available, false);
  assert.equal(toolAvailability('settings', { ...READY, floor: null }).available, true);
});

test('availability says why a tool cannot open', () => {
  const plain = { ...READY, plainFloor: true };
  for (const id of ['issues', 'pulls', 'pipelines', 'ci'] as const) {
    const a = toolAvailability(id, plain);
    assert.equal(a.available, false, id);
    assert.ok(!a.available && /plain folder/.test(a.reason), id);
  }
  assert.equal(toolAvailability('search', plain).available, true);
  assert.equal(toolAvailability('jira', { ...READY, jiraEpic: false }).available, false);
  assert.equal(toolAvailability('wiki', { ...READY, factoryConnected: false }).available, false);
  assert.equal(toolAvailability('upgrade', { ...READY, upgradeAvailable: false }).available, false);
  const agent = { kind: 'agent' as const, cloud: false, guest: false, lost: false };
  assert.equal(toolAvailability('changes', { ...READY, worker: agent }, { workerId: 'w1' }).available, true);
  assert.equal(toolAvailability('changes', READY, {}).available, false);
  assert.equal(toolAvailability('changes', { ...READY, worker: { ...agent, cloud: true, kind: 'cloud' } }, { workerId: 'w1' }).available, false);
  assert.equal(toolAvailability('cloud', { ...READY, worker: agent }, { workerId: 'w1' }).available, false);
  assert.equal(toolAvailability('cloud', { ...READY, worker: { ...agent, cloud: true, kind: 'cloud' } }, { workerId: 'w1' }).available, true);
});

test('host-only features are named with a reason, never offered as tools', () => {
  for (const n of NOT_OFFERED) {
    assert.ok(n.reason.length > 10, n.id);
    assert.ok(!(TOOL_IDS as readonly string[]).includes(n.id), n.id);
  }
});

test('tool args keep only known fields of the right type', () => {
  assert.deepEqual(cleanToolArgs({ workerId: 'w1', number: 12, runId: -1, kind: 'robot', extra: 'x', card: '' }), { workerId: 'w1', number: 12 });
  assert.deepEqual(cleanToolArgs(null), {});
  assert.deepEqual(cleanToolArgs({ number: 1.5, deskId: 'a'.repeat(33) }), {});
});

const FACTS: WorkerActionFacts = {
  kind: 'agent',
  asleep: false,
  busy: false,
  cloud: false,
  guest: false,
  lost: false,
  worktree: true,
  prOpen: false,
  prOpening: false,
  repos: false,
  station: false,
  plainFloor: false,
};
const byId = (f: WorkerActionFacts) => new Map(workerActions(f).map((a) => [a.id, a]));

test('worker actions follow what the 3D office allows', () => {
  const a = byId(FACTS);
  assert.deepEqual([...a.keys()], ['resume', 'fork', 'rebuild', 'pr', 'changes', 'send-home']);
  assert.equal(a.get('resume')!.available, false);
  assert.equal(a.get('rebuild')!.available, false);
  assert.equal(a.get('pr')!.available, true);
  assert.equal(a.get('send-home')!.danger, true);
  assert.equal(byId({ ...FACTS, asleep: true }).get('resume')!.available, true);
  assert.equal(byId({ ...FACTS, busy: true }).get('pr')!.available, false);
  assert.equal(byId({ ...FACTS, worktree: false }).get('pr')!.available, false);
  assert.equal(byId({ ...FACTS, lost: true }).get('rebuild')!.available, true);
  assert.equal(byId({ ...FACTS, forkRefusal: 'Asleep' }).get('fork')!.reason, 'Asleep');
  assert.deepEqual([...byId({ ...FACTS, guest: true, cantBringIn: 'It is busy' }).values()], [{ id: 'bring-in', icon: '🚪', label: 'Bring into the office', available: false, reason: 'It is busy' }]);
  assert.deepEqual([...byId({ ...FACTS, kind: 'cloud', cloud: true }).keys()], ['cloud', 'send-home']);
  assert.deepEqual([...byId({ ...FACTS, station: true, worktree: false }).keys()], ['station-ask', 'resume', 'fork', 'send-home']);
  assert.deepEqual([...byId({ ...FACTS, kind: 'shell', worktree: false }).keys()], ['resume', 'changes', 'send-home']);
});

test('the sealed host forwards only the management routes', () => {
  const allowed: [string, string][] = [
    ['GET', '/api/gh/pull'],
    ['GET', '/api/gh/pull/diff'],
    ['GET', '/api/gh/issue'],
    ['GET', '/api/gh/labels'],
    ['GET', '/api/docs'],
    ['GET', '/api/docs/file'],
    ['GET', '/api/docs/search'],
    ['GET', '/api/docs/picture'],
    ['PUT', '/api/docs/file'],
    ['GET', '/api/search'],
    ['GET', '/api/jira/ticket'],
    ['GET', '/api/factory/computers'],
    ['POST', '/api/factory/cloud/hire'],
    ['DELETE', '/api/factory/computers/abc'],
    ['GET', '/api/agents/droid/models'],
    ['GET', '/api/agents/droid/commands'],
    ['GET', '/api/host/update'],
    ['POST', '/api/host/update'],
    ['GET', '/api/changes/file'],
    ['GET', '/api/whiteboard/render'],
    ['GET', '/api/whiteboard/file'],
    ['POST', '/api/whiteboard/blob'],
    ['POST', '/api/prompt/image'],
    ['DELETE', '/api/prompt/image'],
  ];
  for (const [m, p] of allowed) assert.equal(isAllowedToolRequest(m, p), true, `${m} ${p}`);
  const refused: [string, string][] = [
    ['GET', '/api/mobile/pairing'],
    ['PUT', '/api/mobile/companion'],
    ['DELETE', '/api/mobile/devices/abc'],
    ['POST', '/api/hot-reload'],
    ['GET', '/api/gpu'],
    ['POST', '/api/haptics'],
    ['POST', '/api/automation'],
    ['GET', '/api/status'],
    ['POST', '/api/term/drop'],
    ['POST', '/api/decor/picture'],
    ['GET', '/api/jukebox/soundcloud'],
    ['POST', '/api/gh/pull'],
    ['DELETE', '/api/docs/file'],
    ['GET', '/api/factory/../mobile/pairing'],
    ['GET', '/api/factory/a%2F..%2Fb'],
    ['GET', '/api//factory/x'],
    ['GET', '/api/search?q=x'],
    ['GET', 'https://evil.example/api/search'],
    ['GET', '/whiteboard/c/abc/index.html'],
    ['TRACE', '/api/search'],
  ];
  for (const [m, p] of refused) assert.equal(isAllowedToolRequest(m, p), false, `${m} ${p}`);
});

test('native messages are checked before the page acts on them', () => {
  assert.deepEqual(parseNativeToTools('{"t":"status","up":true}'), { t: 'status', up: true });
  assert.deepEqual(parseNativeToTools({ t: 'bootstrap', up: true, messages: [{ t: 'floors', floors: [] }, 5, null], open: { tool: 'issues', floor: 'f1', args: { number: 3, bad: 1 } } }), {
    t: 'bootstrap',
    up: true,
    messages: [{ t: 'floors', floors: [] }],
    open: { tool: 'issues', floor: 'f1', args: { number: 3 } },
  });
  assert.deepEqual(parseNativeToTools({ t: 'http.result', id: 4, status: 200, body: 'e30=', base64: true, extra: 1 }), { t: 'http.result', id: 4, status: 200, body: 'e30=', base64: true });
  assert.equal(parseNativeToTools({ t: 'server', msg: { nope: 1 } }), undefined);
  assert.equal(parseNativeToTools({ t: 'open', tool: 'issues' }), undefined);
  assert.equal(parseNativeToTools('not json'), undefined);
  assert.equal(parseNativeToTools({ t: 'eval', code: '1' }), undefined);
});

test('only https links leave the app', () => {
  assert.equal(isExternalUrl('https://github.com/o/r/pull/1'), true);
  assert.equal(isExternalUrl('http://github.com/'), false);
  assert.equal(isExternalUrl('javascript:alert(1)'), false);
  assert.equal(isExternalUrl('https://user:pw@example.com/'), false);
  assert.equal(isExternalUrl('/api/search'), false);
});
