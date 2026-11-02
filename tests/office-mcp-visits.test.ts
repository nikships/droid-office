import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { ASK_REPLY_MS, TALK_MAX_MS, TALK_MIN_MS, Visits, type VisitWorkers } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { SUBAGENT_DEFAULTS, type ServerMsg, type WorkerInfo } from '../src/shared/protocol.js';
import { visitRoute, visitWalkMs } from '../src/shared/visits.js';

const VISIT_TOOLS = ['visit_look', 'visit_message', 'visit_reply', 'visit_roster'];

function worker(id: string, deskId: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, deskId, kind: 'agent', color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false, ...extra };
}

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-visits-'));
  const settings = { ...SUBAGENT_DEFAULTS };
  const people = new Map([
    ['Pixel', worker('Pixel', 'desk-3', { status: 'working', task: { name: 'Login', summary: 'Fix login' }, activity: 'Editing session.ts' })],
    ['Nibble', worker('Nibble', 'desk-9')],
    ['Dot', worker('Dot', 'desk-10')],
    ['Byte', worker('Byte', 'desk-4', { lead: 'Pixel' })],
    ['Shell', worker('Shell', 'desk-5', { kind: 'shell' })],
  ]);
  let clock = 1_000_000;
  const typed: { id: string; text: string; resume?: true }[] = [];
  const escapes: string[] = [];
  const emitted: ServerMsg[] = [];
  const tails = new Map([['Nibble', 'line 1\nline 2\n$ npm test\nok']]);
  const screens = new Map<string, 'asking' | 'idle' | 'busy'>();
  const failures = new Map<string, string>();
  const workers: VisitWorkers & TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === `token-${id}` ? people.get(id) : undefined),
    prompt: (id, text) => {
      const error = failures.get(id);
      if (error) return error;
      typed.push({ id, text });
      return undefined;
    },
    resume: (id, text) => {
      typed.push({ id, text, resume: true });
      return undefined;
    },
    tail: (id, lines) => tails.get(id)?.split('\n').slice(-lines).join('\n'),
    cancelTurn: (id) => {
      escapes.push(id);
      return true;
    },
    turnScreen: (id) => screens.get(id) ?? (people.get(id)?.status === 'working' ? 'busy' : 'idle'),
    officeDefault: undefined,
    deskOccupied: () => false,
    hire: () => 'Unused',
    kill: async () => ({}),
    setTask() {},
  };
  const visits = new Visits(workers, { on: () => settings.visits, emit: (message) => emitted.push(message), now: () => clock });
  const team = new Team(workers, { dataDir: dir, dir, git: true, settings: () => settings, toast() {} });
  const whiteboard = new WhiteboardStore(dir);
  const floor: OfficeMcpFloor = { id: 'floor', name: 'Floor', dir, workers, team, visits, whiteboard };
  const office = createOfficeMcp({ settings: () => settings, floor: (id) => (people.has(id) ? floor : undefined) });
  const http = createServer((req, res) => {
    if (req.url === OFFICE_MCP_PATH) void office.handle(req, res);
    else res.writeHead(404).end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}${OFFICE_MCP_PATH}`);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    visits.stop();
    team.stop();
    whiteboard.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const connect = async (id: string, token = `token-${id}`) => {
    const client = new Client({ name: 'visit-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}`, [OFFICE_MCP_WORKER_HEADER]: id } } }));
    return client;
  };
  const advance = (ms: number) => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + 250);
      visits.tick(clock);
    }
  };
  const setStatus = (id: string, status: WorkerInfo['status']) => {
    const w = people.get(id)!;
    w.status = status;
    visits.onWorker(w);
  };
  return { connect, people, settings, typed, escapes, emitted, tails, screens, failures, visits, advance, setStatus };
}

const walk = (from = 'desk-3', to = 'desk-9') => visitWalkMs(visitRoute(from, to, 0));
const messages = (r: Awaited<ReturnType<typeof rig>>, id: string) => r.typed.filter((message) => message.id === id);

test('real MCP discovery, auth and live permissions gate every visit tool', async (t) => {
  const r = await rig(t);
  await assert.rejects(r.connect('Pixel', 'token-Nibble'), /Office MCP requires/);
  const [lead, sub] = await Promise.all([r.connect('Pixel'), r.connect('Byte')]);
  const tools = async (c: Client) =>
    (await c.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('visit_'))
      .sort();
  assert.deepEqual(await tools(lead), VISIT_TOOLS);
  assert.deepEqual(await tools(sub), []);
  for (const [name, args] of [
    ['visit_roster', {}],
    ['visit_look', { name: 'Nibble' }],
    ['visit_message', { name: 'Nibble', kind: 'tell', text: 'hi' }],
    ['visit_reply', { visit: 'v-12345678', text: 'hi' }],
  ] as const) {
    assert.equal((await sub.callTool({ name, arguments: args })).isError, true);
  }
  r.settings.visits = false;
  assert.deepEqual(await tools(lead), []);
  const result = await lead.callTool({ name: 'visit_roster', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /turned off/);
  assert.deepEqual(r.typed, []);
  assert.match(lead.getInstructions() ?? '', /Do not routinely check the roster/);
  assert.match(lead.getInstructions() ?? '', /30 minutes/);
});

test('the roster and bounded terminal snapshot are readable, structured and floor-local', async (t) => {
  const r = await rig(t);
  const c = await r.connect('Pixel');
  const roster = await c.callTool({ name: 'visit_roster', arguments: {} });
  assert.ok(roster.structuredContent);
  assert.deepEqual(
    (roster.structuredContent.roster as { name: string }[]).map((w) => w.name),
    ['Pixel', 'Nibble', 'Dot'],
  );
  assert.match(JSON.stringify(roster.content), /Pixel \(you\).*busy.*Login/);
  assert.match(JSON.stringify(roster.content), /Editing session.ts/);
  const look = await c.callTool({ name: 'visit_look', arguments: { name: 'nibble', lines: 2 } });
  assert.equal(look.structuredContent?.text, '$ npm test\nok');
  assert.match(JSON.stringify(look.content), /Nibble's screen/);
  r.tails.set('Nibble', '');
  assert.match(JSON.stringify((await c.callTool({ name: 'visit_look', arguments: { name: 'Nibble' } })).content), /terminal is empty/);
  for (const name of ['Byte', 'Shell', 'Upstairs', 'Pixel']) {
    assert.equal((await c.callTool({ name: 'visit_look', arguments: { name } })).isError, true);
  }
  assert.equal((await c.callTool({ name: 'visit_look', arguments: { name: 'Dot' } })).isError, true);
  for (const lines of [0, 401, 1.5]) assert.equal((await c.callTool({ name: 'visit_look', arguments: { name: 'Nibble', lines } })).isError, true);
  assert.deepEqual(r.typed, []);
  assert.deepEqual(r.emitted, [], 'a snapshot does not fake a walking visit or type into the host');
});

test('tell and handoff queue immediately, walk honestly and deliver normal or urgent priority', async (t) => {
  const r = await rig(t);
  const c = await r.connect('Pixel');
  r.setStatus('Nibble', 'working');
  const tell = await c.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'tell', text: "Don't expand $HOME or {{from}}." } });
  assert.equal(tell.structuredContent?.queued, true);
  assert.match(String(tell.structuredContent?.visit), /^v-[a-f0-9]{8}$/);
  assert.equal(r.visits.list()[0].phase, 'walking');
  assert.deepEqual(r.typed, []);
  r.advance(walk() + 250);
  assert.match(messages(r, 'Nibble')[0].text, /Don't expand \$HOME or \{\{from\}\}/);
  assert.deepEqual(r.escapes, [], 'normal delivery never cancels a turn');
  assert.equal(r.visits.list()[0].phase, 'talking');
  r.advance(TALK_MIN_MS + walk());
  r.setStatus('Nibble', 'working');
  const handoff = await c.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'handoff', text: 'Write the tests', title: 'Session tests', urgent: true } });
  assert.equal(handoff.isError, undefined);
  r.advance(walk() + 250);
  assert.deepEqual(r.escapes, ['Nibble']);
  assert.equal(messages(r, 'Nibble').length, 1, 'urgent delivery waits for cancellation to settle');
  r.screens.set('Nibble', 'idle');
  r.advance(250);
  assert.match(messages(r, 'Nibble')[1].text, /Task: Session tests\nWrite the tests/);
  assert.match(messages(r, 'Nibble')[1].text, /Delivery: urgent/);
});

test('ask never waits for the host or an answer, walks home, and accepts one later session reply', async (t) => {
  const r = await rig(t);
  const [asker, host, other] = await Promise.all([r.connect('Pixel'), r.connect('Nibble'), r.connect('Dot')]);
  r.setStatus('Nibble', 'needs_input');
  const ask = await asker.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Which port?' } });
  const id = String(ask.structuredContent?.visit);
  assert.equal(ask.structuredContent?.queued, true, 'call returns before a permission prompt can be answered');
  r.advance(walk() + TALK_MAX_MS + walk() + 500);
  assert.deepEqual(r.visits.list(), [], 'asker walks home even when its question is still queued');
  assert.deepEqual(r.typed, []);
  assert.equal((await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'too early' } })).isError, true);
  r.setStatus('Nibble', 'done');
  r.advance(250);
  assert.match(messages(r, 'Nibble')[0].text, new RegExp(`visit_reply with visit "${id}"`));
  assert.match(messages(r, 'Nibble')[0].text, /about 30 minutes/);
  assert.equal((await other.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'not mine' } })).isError, true);
  r.advance(20 * 60_000);
  const answer = '5173\n```text\n{{from}} is literal\n```';
  const reply = await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: answer } });
  assert.equal(reply.structuredContent?.delivered, true);
  assert.equal(reply.structuredContent?.to, 'Pixel');
  assert.match(messages(r, 'Pixel')[0].text, /answer from Nibble.*a worker, not the owner/);
  assert.ok(messages(r, 'Pixel')[0].text.includes(`\n\`\`\`\`text\n${answer}\n\`\`\`\`\n\n## Office guidance`));
  assert.match(messages(r, 'Pixel')[0].text, /visit_message/);
  assert.equal((await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'again' } })).isError, true);
  assert.deepEqual(r.visits.list(), [], 'reply does not animate the absent visitor');
});

test('reply delivery queues safely behind dialogs and resumes a sleeping asker without Escape', async (t) => {
  const r = await rig(t);
  const [asker, host] = await Promise.all([r.connect('Pixel'), r.connect('Nibble')]);
  const ask = await asker.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Ready?' } });
  const id = String(ask.structuredContent?.visit);
  r.advance(walk() + TALK_MIN_MS + walk() + 500);
  r.screens.set('Pixel', 'asking');
  const reply = await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'Ready.' } });
  assert.equal(reply.structuredContent?.queued, true);
  assert.deepEqual(messages(r, 'Pixel'), []);
  r.screens.set('Pixel', 'idle');
  r.setStatus('Pixel', 'offline');
  r.advance(250);
  assert.equal(messages(r, 'Pixel')[0].resume, true);
  assert.deepEqual(r.escapes, []);
});

test('reply failures are actionable and retryable; expired questions never deliver late', async (t) => {
  const r = await rig(t);
  const [asker, host] = await Promise.all([r.connect('Pixel'), r.connect('Nibble')]);
  const ask = await asker.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Ready?' } });
  const id = String(ask.structuredContent?.visit);
  r.advance(walk() + TALK_MIN_MS + walk() + 500);
  r.failures.set('Pixel', 'Worker is not running');
  const failed = await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'Yes' } });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /Retry visit_reply/);
  r.failures.delete('Pixel');
  assert.equal((await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'Yes' } })).structuredContent?.delivered, true);
  const next = await asker.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Another?' } });
  r.advance(30_000);
  r.advance(ASK_REPLY_MS);
  const expired = await host.callTool({ name: 'visit_reply', arguments: { visit: next.structuredContent?.visit, text: 'Late' } });
  assert.equal(expired.isError, true);
  assert.match(JSON.stringify(expired.content), /This ask expired/);
  const q = await rig(t);
  const c = await q.connect('Pixel');
  q.setStatus('Nibble', 'needs_input');
  await c.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Never delivered' } });
  q.advance(ASK_REPLY_MS + 250);
  q.setStatus('Nibble', 'done');
  q.advance(250);
  assert.deepEqual(q.typed, []);
});

test('a reply queued behind an unrelated failed message is accepted once, not reported as a failed answer', async (t) => {
  const r = await rig(t);
  const [asker, host, other] = await Promise.all([r.connect('Pixel'), r.connect('Nibble'), r.connect('Dot')]);
  const ask = await asker.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Port?' } });
  const id = String(ask.structuredContent?.visit);
  r.advance(walk() + TALK_MIN_MS + walk() + 500);
  r.setStatus('Pixel', 'needs_input');
  await other.callTool({ name: 'visit_message', arguments: { name: 'Pixel', kind: 'tell', text: 'An unrelated note' } });
  r.advance(30_000);
  r.failures.set('Pixel', 'Worker is not running');
  r.setStatus('Pixel', 'done');
  const answer = await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: '5173' } });
  assert.equal(answer.isError, undefined);
  assert.equal(answer.structuredContent?.queued, true);
  assert.equal((await host.callTool({ name: 'visit_reply', arguments: { visit: id, text: 'duplicate' } })).isError, true);
  r.failures.delete('Pixel');
  r.advance(250);
  assert.equal(messages(r, 'Pixel').length, 1);
  assert.match(messages(r, 'Pixel')[0].text, /5173/);
});

test('delivery starts a fresh reply window even after a long permission-dialog delay', async (t) => {
  const r = await rig(t);
  const [asker, host] = await Promise.all([r.connect('Pixel'), r.connect('Nibble')]);
  r.setStatus('Nibble', 'needs_input');
  const ask = await asker.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'ask', text: 'Port?' } });
  r.advance(20 * 60_000);
  assert.deepEqual(r.typed, []);
  r.setStatus('Nibble', 'done');
  r.advance(250);
  r.advance(20 * 60_000);
  const answer = await host.callTool({ name: 'visit_reply', arguments: { visit: ask.structuredContent?.visit, text: '5173' } });
  assert.equal(answer.structuredContent?.delivered, true, '40 minutes after sending is still inside the fresh delivery window');
});

test('invalid messages and conflicting visits fail without silently losing or rerouting work', async (t) => {
  const r = await rig(t);
  const c = await r.connect('Pixel');
  for (const arguments_ of [
    { name: 'Nibble', kind: 'ask', text: ' ' },
    { name: 'Nibble', kind: 'dance', text: 'hi' },
    { name: 'Nibble', kind: 'tell', text: 'hi', title: 'Not a handoff' },
    { name: 'Nibble', kind: 'tell', text: 'x'.repeat(20_001) },
    { name: 'Byte', kind: 'tell', text: 'hi' },
  ])
    assert.equal((await c.callTool({ name: 'visit_message', arguments: arguments_ })).isError, true);
  await c.callTool({ name: 'visit_message', arguments: { name: 'Nibble', kind: 'tell', text: 'One' } });
  const busy = await c.callTool({ name: 'visit_message', arguments: { name: 'Dot', kind: 'tell', text: 'Two' } });
  assert.equal(busy.isError, true);
  assert.match(JSON.stringify(busy.content), /already on a visit/);
  r.settings.visits = false;
  r.advance(250);
  r.settings.visits = true;
  r.advance(60_000);
  assert.deepEqual(r.typed, [], 'turning Visits off cancels even a walking delivery');
});
