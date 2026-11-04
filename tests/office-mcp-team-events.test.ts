import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { parseCursor } from '../src/server/office-mcp/team-events.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { readMenu } from '../src/shared/asks.js';
import { SUBAGENT_DEFAULTS, type SubagentSettings, type WorkerInfo } from '../src/shared/protocol.js';

// The same Droid AskUser screen as tests/asks.test.ts (Android's fixtures).
const DIGITS = ['│ Which file should I create? │', '│ 1. hello.txt │', '│    A greeting │', '│ 2. bye.txt │', '│ 3. Other (type your answer) │', '│ Press a number to answer, Esc to skip │'];
const LONG_REPORT = ['Done: fixed the redirect.', ...Array.from({ length: 60 }, (_, i) => `| bench ${i} | ${i * 3} ms | ok |`)].join('\n');

function worker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: 'desk-1', color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false, ...extra };
}

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-events-'));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, wakeLead: false };
  const people = new Map([['lead', worker('lead', { name: 'Nibble' })]]);
  const screens = new Map<string, string[]>();
  const writes: [string, string][] = [];
  const prompts: [string, string][] = [];
  let hired = 0;
  let now = Date.parse('2026-11-03T12:00:00Z');
  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === `token-${id}` ? people.get(id) : undefined),
    officeDefault: undefined,
    deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
    hire: (deskId, _by, _prompt, worktree, _choice, lead) => {
      const id = `sub${++hired}`;
      const sub = worker(id, {
        name: ['Pixel', 'Byte'][hired - 1] ?? id,
        deskId,
        lead,
        status: 'working',
        createdAt: hired + 1,
        ...(worktree ? { worktree: { path: `.droid-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc' } } : {}),
      });
      people.set(id, sub);
      return sub;
    },
    prompt: (id, message) => {
      prompts.push([id, message]);
      return undefined;
    },
    resume: () => undefined,
    kill: async (id) => {
      people.delete(id);
      team.onWorkerGone(id);
      return {};
    },
    tail: () => '',
    setTask: (id, task) => {
      const w = people.get(id);
      if (w) w.task = task;
    },
    screenLines: (id) => screens.get(id),
    screenMenu: (id) => (screens.has(id) ? readMenu(screens.get(id)!) : undefined),
    write: (id, data) => {
      writes.push([id, data]);
    },
  };
  const team = new Team(workers, { dataDir: dir, dir, git: true, settings: () => settings, toast() {}, now: () => now });
  const visits = new Visits({ ...workers, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  const whiteboard = new WhiteboardStore(dir);
  const floor: OfficeMcpFloor = { id: 'floor', name: 'Floor', dir, workers, team, visits, whiteboard };
  const office = createOfficeMcp({ answers: new Answers(), settings: () => settings, floor: (id) => (people.has(id) ? floor : undefined) });
  const http = createServer((req, res) => {
    if (req.url === OFFICE_MCP_PATH) void office.handle(req, res);
    else res.writeHead(404).end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}${OFFICE_MCP_PATH}`);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    team.stop();
    visits.stop();
    whiteboard.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function connect(id: string) {
    const client = new Client({ name: 'events-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer token-${id}` } } }));
    return client;
  }
  const lead = await connect('lead');
  async function call(client: Client, name: string, args: Record<string, unknown> = {}, options?: Parameters<Client['callTool']>[1]) {
    const result = await client.callTool({ name, arguments: args }, options);
    const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    return { ...result, text, body: result.structuredContent as Record<string, any> };
  }
  const hire = (title = 'Fix login') => call(lead, 'team_hire', { title, brief: 'Fix the redirect, test, commit and report.' });
  const status = (args: Record<string, unknown> = {}) => call(lead, 'team', { action: 'status', ...args });
  function set(id: string, status: WorkerInfo['status'], extra: Partial<WorkerInfo> = {}) {
    const w = people.get(id)!;
    Object.assign(w, extra, { status });
    team.onWorker({ ...w });
  }
  return { dir, url, settings, people, screens, writes, prompts, team, connect, call, lead, hire, status, set, tick: (ms: number) => (now += ms) };
}

test('status keeps its prose and adds compact workers, typed news with ids and times, and a cursor', async (t) => {
  const r = await rig(t);
  await r.hire();
  const sub = await r.connect('sub1');
  r.set('sub1', 'working', { activity: 'Running tests' });
  await r.call(sub, 'team_report', { text: LONG_REPORT });
  const legacy = await r.status();
  assert.match(legacy.text, /Last report:\nDone: fixed the redirect\.\n\| bench 0/, 'the full prose stays for existing callers');
  assert.match(legacy.text, /News since your last status call:\n(\[[^\]]+\] )?Worker report from Pixel/);
  assert.equal(legacy.body.team[0].report.text, LONG_REPORT, 'the old structured fields are still there');
  const [pixel] = legacy.body.workers;
  assert.equal(pixel.id, 'sub1');
  assert.equal(pixel.state, 'working');
  assert.equal(pixel.doing, 'Running tests');
  assert.equal(pixel.task, 'Fix login');
  assert.equal(pixel.branch, 'office/sub1');
  assert.equal(pixel.worktree, path.join(r.dir, '.droid-office/worktrees/sub1'));
  assert.equal(pixel.lastReportId, 'team:floor:1');
  assert.equal(pixel.lastReportAt, '2026-11-03T12:00:00.000Z');
  assert.ok(pixel.lastReportSummary.length <= 240 && pixel.lastReportSummary.startsWith('Done: fixed the redirect.'));
  assert.deepEqual(legacy.body.news[0], { id: 'team:floor:1', kind: 'report', worker: 'sub1', name: 'Pixel', floor: 'floor', at: '2026-11-03T12:00:00.000Z', summary: pixel.lastReportSummary });
  assert.equal(legacy.body.cursor, 'team:floor:1');

  r.tick(1000);
  await r.call(sub, 'team_report', { text: LONG_REPORT });
  const compact = await r.status({ verbose: false });
  assert.ok(compact.text.length < 900, `compact status stays short (${compact.text.length} chars)`);
  assert.doesNotMatch(compact.text, /bench 59/);
  assert.match(compact.text, /^Pixel \(sub1\) working, Desk \d+: Fix login\./);
  assert.match(compact.text, /\[team:floor:2 2026-11-03T12:00:01\.000Z\] report Pixel: Done/);
  assert.match(compact.text, /Cursor: team:floor:2$/);
  assert.equal(compact.body.team, undefined, 'compact structured content drops the whole reports');
  assert.equal(compact.body.news[0].text, undefined);
  assert.equal((await r.status({ name: 'pixel', verbose: false })).body.workers.length, 1, 'name filters the structured workers too');

  const full = await r.call(r.lead, 'team_report_get', { worker: 'Pixel' });
  assert.equal(full.isError, undefined);
  assert.equal(full.body.report.text, LONG_REPORT);
  assert.equal(full.body.report.id, 'team:floor:2');
  assert.deepEqual(
    full.body.history.map((e: { id: string }) => e.id),
    ['team:floor:1', 'team:floor:2'],
  );
  assert.equal((await r.call(r.lead, 'team_report_get', { id: 'team:floor:1' })).body.report.id, 'team:floor:1');
  assert.equal((await r.call(r.lead, 'team_report_get', { id: 'team:floor:99' })).isError, true);
  assert.equal((await r.call(r.lead, 'team_report_get', {})).isError, true);
  await r.call(r.lead, 'team', { action: 'dismiss', name: 'Pixel' });
  assert.equal((await r.call(r.lead, 'team_report_get', { worker: 'Pixel' })).body.report.text, LONG_REPORT, 'reports outlive the subagent');

  for (const args of [
    { action: 'message', name: 'Pixel', text: 'hi', verbose: false },
    { action: 'dismiss', name: 'Pixel', since: '1' },
    { action: 'status', since: 'yesterday' },
  ])
    assert.equal((await r.call(r.lead, 'team', args)).isError, true, JSON.stringify(args));
});

test('since reads news after a cursor without draining what else is unread, and kinds filter by type', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  const pixel = await r.connect('sub1');
  await r.call(pixel, 'team_report', { text: 'First' });
  const cursor = (await r.status({ verbose: false })).body.cursor;
  r.set('sub2', 'needs_input', { activity: 'Allow rm?' });
  await r.call(pixel, 'team_report', { text: 'Which branch?', question: true });
  const blocked = await r.status({ kinds: ['blocked'], verbose: false });
  assert.deepEqual(
    blocked.body.news.map((e: { kind: string }) => e.kind),
    ['needs_input'],
  );
  const after = await r.status({ since: cursor, verbose: false });
  assert.deepEqual(
    after.body.news.map((e: { kind: string; id: string }) => `${e.kind} ${e.id}`),
    ['needs_input team:floor:2', 'question team:floor:3'],
    'since includes news already heard',
  );
  assert.deepEqual((await r.status({ verbose: false })).body.news, [], 'the since read drained what it showed');
  assert.deepEqual((await r.status({ since: after.body.cursor })).body.news, []);
  assert.equal((await r.status({ since: '2' })).body.news.length, 1, 'a bare seq is on the caller’s floor');
  assert.deepEqual(
    [...parseCursor('team:a:3,team:b-2:7,team:a:1', 'own')!],
    [
      ['a', 3],
      ['b-2', 7],
    ],
  );
  assert.equal(parseCursor('team:a:x', 'own'), undefined);
});

test('a question makes the subagent blocked_on_question until its lead answers through question_answer', async (t) => {
  const r = await rig(t);
  await r.hire();
  const pixel = await r.connect('sub1');
  await r.call(pixel, 'team_report', { text: 'Which database?', question: true, options: ['Postgres', 'SQLite'] });
  r.set('sub1', 'done');
  const listed = await r.call(r.lead, 'questions_list');
  assert.equal(listed.body.questions.length, 1);
  const [asked] = listed.body.questions;
  assert.equal(asked.id, 'team:floor:1');
  assert.equal(asked.kind, 'team');
  assert.deepEqual(asked.options, [
    { id: '1', label: 'Postgres' },
    { id: '2', label: 'SQLite' },
  ]);
  assert.equal((await r.status()).body.workers[0].state, 'blocked_on_question');
  assert.equal((await r.status()).body.workers[0].openQuestionId, 'team:floor:1');
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: asked.id, optionId: '3' })).isError, true);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: asked.id })).isError, true);
  const answered = await r.call(r.lead, 'question_answer', { questionId: asked.id, optionId: '2', text: 'Keep it local.' });
  assert.equal(answered.isError, undefined);
  assert.deepEqual(answered.body, { answered: true, questionId: 'team:floor:1', worker: 'sub1' });
  assert.match(r.prompts.at(-1)![1], /SQLite\n\nKeep it local\./);
  assert.deepEqual((await r.call(r.lead, 'questions_list')).body.questions, []);
  assert.equal((await r.status()).body.workers[0].state, 'done');
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: asked.id, text: 'again' })).isError, true, 'answered once');

  await r.call(pixel, 'team_report', { text: 'Another?', question: true });
  r.set('sub1', 'working');
  assert.deepEqual((await r.call(r.lead, 'questions_list')).body.questions, [], 'a new turn moves on from an unanswered question');
  const restarted = new Team(
    {
      list: () => [...r.people.values()],
      get: (id) => r.people.get(id),
      deskOccupied: () => false,
      officeDefault: undefined,
      hire: () => 'no',
      prompt: () => undefined,
      resume: () => undefined,
      kill: async () => ({}),
      tail: () => '',
      setTask() {},
    },
    { dataDir: r.dir, dir: r.dir, git: true, settings: () => r.settings, toast() {} },
  );
  t.after(() => restarted.stop());
  assert.deepEqual(restarted.questions('lead'), [], 'answered questions stay answered after a restart');
});

test('terminal questions are listed like the Asks inbox and answered only while the same menu shows; permission prompts are refused', async (t) => {
  const r = await rig(t);
  await r.hire();
  r.screens.set('sub1', DIGITS);
  r.set('sub1', 'needs_input', {
    ask: { kind: 'question', questions: [{ question: 'Which file should I create?', options: ['hello.txt', 'bye.txt', 'Other (type your answer)'], multiSelect: false }] },
    waitingSince: Date.parse('2026-11-03T12:00:00Z'),
  });
  const [menu] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.equal(menu.kind, 'terminal');
  assert.match(menu.id, /^ask:floor:sub1:[0-9a-f]{12}$/);
  assert.equal(menu.question, 'Which file should I create?');
  assert.deepEqual(
    menu.options.map((o: { id: string; label: string }) => `${o.id} ${o.label}`),
    ['1 hello.txt', '2 bye.txt', '3 Other (type your answer)'],
  );
  assert.equal(menu.takesText, true);
  assert.equal(menu.answerable, true);
  assert.equal((await r.status()).body.workers[0].state, 'blocked_on_question');
  r.screens.set(
    'sub1',
    DIGITS.map((line) => line.replace('bye.txt', 'farewell.txt')),
  );
  assert.match((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '1' })).text, /question changed/);
  assert.deepEqual(r.writes, []);
  r.screens.set('sub1', DIGITS);
  assert.match((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '3', text: 'notes.txt' })).text, /not both/, 'a terminal question never drops the typed half of an answer');
  assert.deepEqual(r.writes, []);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '9' })).isError, true);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '1' })).isError, undefined);
  assert.deepEqual(r.writes, [['sub1', '1']]);
  assert.match((await r.call(r.lead, 'question_answer', { questionId: menu.id, optionId: '1' })).text, /already being answered/, 'the shared answer queue stops a second answer');

  r.set('sub1', 'needs_input', { ask: { kind: 'permission', tool: 'Execute', command: 'rm -rf build', risk: 'high' } });
  const [permission] = (await r.call(r.lead, 'questions_list')).body.questions;
  assert.equal(permission.kind, 'permission');
  assert.equal(permission.answerable, false);
  assert.match(permission.question, /Approve high-risk command: rm -rf build/);
  const refused = await r.call(r.lead, 'question_answer', { questionId: permission.id, optionId: '1' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /desk/);
  assert.equal(r.writes.length, 1);
  assert.equal((await r.call(r.lead, 'question_answer', { questionId: 'ask:floor:lead:permission', optionId: '1' })).isError, true, 'only the caller’s own subagents');
});

test('team_wait returns as soon as news arrives, times out, cancels and never leaks listeners or blocks other calls', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  const pixel = await r.connect('sub1');
  const listed = (await r.lead.listTools()).tools.find((tool) => tool.name === 'team_wait');
  assert.ok(listed?.outputSchema, 'team_wait advertises its structured output');

  const started = Date.now();
  const waiting = r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 20 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(r.team.watchers(), 1);
  assert.equal((await r.status({ verbose: false })).isError, undefined, 'other calls are served while a wait is open');
  await r.call(pixel, 'team_report', { text: 'Finished the redirect.' });
  const woke = await waiting;
  assert.ok(Date.now() - started < 5000);
  assert.equal(woke.body.matched, true);
  assert.equal(woke.body.reason, 'report');
  assert.equal(woke.body.events[0].id, 'team:floor:1');
  assert.equal(woke.body.cursor, 'team:floor:1');
  assert.equal(r.team.watchers(), 0);
  assert.deepEqual((await r.status()).body.news, [], 'a local wait drains what it returned, like status');

  const timeout = await r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 1 });
  assert.equal(timeout.body.matched, false);
  assert.equal(timeout.body.reason, 'timeout');
  assert.equal(r.team.watchers(), 0);

  const blocked = r.call(r.lead, 'team_wait', { until: ['blocked'], workers: ['Byte'], timeoutSec: 20 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  r.set('sub1', 'needs_input', { activity: 'ignored: not watched' });
  r.set('sub2', 'needs_input', { activity: 'Allow rm?' });
  const got = await blocked;
  assert.equal(got.body.reason, 'blocked');
  assert.deepEqual(
    got.body.events.map((e: { worker: string }) => e.worker),
    ['sub2'],
  );

  r.set('sub1', 'done');
  r.set('sub2', 'done');
  const rested = await r.call(r.lead, 'team_wait', { until: ['idle'], timeoutSec: 1 });
  assert.equal(rested.body.matched, false, 'a team already at rest is no news, so the wait does not return at once');
  const idle = r.call(r.lead, 'team_wait', { until: ['idle'], timeoutSec: 20 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  r.set('sub2', 'working');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(r.team.watchers(), 1, 'still waiting while one works');
  r.set('sub2', 'done');
  assert.equal((await idle).body.reason, 'idle', 'the team settling during the wait ends it');

  await r.status();
  const question = r.call(r.lead, 'team_wait', { timeoutSec: 20 });
  r.set('sub1', 'working');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await r.call(pixel, 'team_report', { text: 'Which branch?', question: true });
  const asked = await question;
  assert.equal(asked.body.reason, 'question');
  assert.equal(asked.body.questions[0].id, asked.body.events[0].id);
  const again = await r.call(r.lead, 'team_wait', { until: ['question'], timeoutSec: 1 });
  assert.equal(again.body.matched, false, 'a question already heard does not end the next wait');
  assert.equal(again.body.questions[0].id, asked.body.events[0].id, 'it is still listed as waiting on the lead');
  assert.equal(again.body.news, undefined, 'events is the one list of what happened');

  // The plain curl-style client a remote bot uses: one POST, then it hangs up.
  const controller = new AbortController();
  const raw = fetch(r.url, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer token-lead' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'team_wait', arguments: { until: ['report'], timeoutSec: 20 } } }),
  }).then((response) => response.text());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(r.team.watchers(), 1);
  controller.abort();
  await assert.rejects(raw);
  for (let i = 0; i < 50 && r.team.watchers(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.team.watchers(), 0, 'a wait whose caller hung up unsubscribes');

  const held = Array.from({ length: 4 }, () => r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match((await r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 1 })).text, /already have 4/);
  await Promise.all(held);
  assert.equal(r.team.watchers(), 0);
  for (const args of [{ timeoutSec: 601 }, { timeoutSec: 0 }, { until: [] }, { until: ['soon'] }, { workers: ['Nobody'] }, { since: 'later' }]) assert.equal((await r.call(r.lead, 'team_wait', args)).isError, true, JSON.stringify(args));

  r.settings.wakeLead = true;
  assert.ok(!(await r.lead.listTools()).tools.some((tool) => tool.name === 'team_wait'), 'wake notes replace waiting for a local lead');
  assert.match((await r.call(r.lead, 'team_wait', {})).text, /Wake the lead is on/);
});

test('team_wait returns every event that landed before it answered, and counts a terminal question that appears during it', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  const blocked = r.call(r.lead, 'team_wait', { until: ['blocked'], timeoutSec: 20 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Both get stuck in one pass: the first wakes the wait, the second lands before it answers.
  r.set('sub1', 'needs_input', { activity: 'Allow rm?' });
  r.set('sub2', 'needs_input', { activity: 'Allow push?' });
  const got = await blocked;
  assert.deepEqual(
    got.body.events.map((e: { id: string }) => e.id),
    ['team:floor:1', 'team:floor:2'],
  );
  assert.equal(got.body.cursor, 'team:floor:2');

  r.set('sub1', 'working');
  r.set('sub2', 'working');
  const question = r.call(r.lead, 'team_wait', { until: ['question'], timeoutSec: 20 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  r.screens.set('sub1', DIGITS);
  r.set('sub1', 'needs_input', { ask: { kind: 'question', questions: [{ question: 'Which file should I create?', options: ['hello.txt', 'bye.txt', 'Other (type your answer)'], multiSelect: false }] } });
  const asked = await question;
  assert.equal(asked.body.reason, 'question');
  assert.deepEqual(asked.body.events, [], 'its needs_input news is not what this wait asked for');
  assert.equal(asked.body.questions[0].kind, 'terminal');
  const again = await r.call(r.lead, 'team_wait', { until: ['question'], timeoutSec: 1 });
  assert.equal(again.body.matched, false, 'the same terminal question does not end the next wait');
  assert.equal(again.body.questions[0].id, asked.body.questions[0].id);
});

test('team_wait sends progress to a client that asked for it', async (t) => {
  const r = await rig(t);
  await r.hire();
  const beats: number[] = [];
  const result = await r.call(r.lead, 'team_wait', { until: ['report'], timeoutSec: 16 }, { onprogress: (p) => beats.push(p.progress), resetTimeoutOnProgress: true, timeout: 20_000 });
  assert.equal(result.body.reason, 'timeout');
  assert.deepEqual(beats, [15]);
});

test('the team event seq never goes back, so cursors stay valid after a lead leaves and the office restarts', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-seq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const people = new Map([
    ['a', worker('a')],
    ['b', worker('b')],
    ['s', worker('s', { lead: 'b' })],
  ]);
  const workers: TeamWorkers = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    deskOccupied: () => false,
    officeDefault: undefined,
    hire: () => 'no',
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => '',
    setTask() {},
  };
  const options = { dataDir: dir, dir, git: true, settings: () => ({ ...SUBAGENT_DEFAULTS, wakeLead: false }), toast() {} };
  const team = new Team(workers, options);
  void team.handle(people.get('s')!, { action: 'report', text: 'to b' });
  assert.equal(team.latest(), 1);
  people.delete('b');
  people.delete('s');
  team.onWorkerGone('b');
  team.stop();
  const restarted = new Team(workers, options);
  t.after(() => restarted.stop());
  assert.equal(restarted.latest(), 1);
});
