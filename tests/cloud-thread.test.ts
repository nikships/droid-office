import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudWorkers } from '../src/server/cloud-workers.js';
import { FactoryApi } from '../src/server/factory/api.js';
import { mountCloud, type CloudFeature, type CloudFloor } from '../src/server/factory/cloud.js';
import { CloudThreadReader } from '../src/server/factory/cloud-thread.js';
import type { FeatureHost } from '../src/server/factory/feature.js';
import type { FactoryRegistry } from '../src/server/factory/registry.js';
import { SEQ_STRIDE, cloudEntries, todoText } from '../src/shared/cloud-thread.js';
import { computerOf } from '../src/shared/factory-computers.js';
import { mergeMessages, messageOf, type FactoryMessage } from '../src/shared/factory-sessions.js';
import { DESKS } from '../src/shared/layout.js';
import type { ClientMsg } from '../src/shared/protocol.js';
import { presentThread, THREAD_MODEL_VERSION } from '../src/shared/thread-presentation.js';

const KEY = 'fk-test-thread-1234';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 15));

// A real session that ran on the owner's Mac Mini (GET /sessions/{id}/messages, newest first as
// Factory sends it), trimmed: signatures, encrypted reasoning and long outputs cut.
const RAW = [
  {
    id: '3ac9d305-dc2c-4365-ad85-0904c49afcbc',
    role: 'assistant',
    createdAt: 1793440975788,
    seq: 406,
    modelId: 'gpt-6-sol',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '[PR #352](https://github.com/nikships/droid-office/pull/352) is merged. The prompt chips and their setting are removed; prompt history remains.' },
    ],
  },
  { id: '75624579-2096-4d0e-82c4-d9ef2966da92', role: 'tool', createdAt: 1793440971299, seq: 405, content: [{ type: 'tool_result', toolUseId: 'call_hK2BBUKkQvWCoXabfypazF3f', content: 'TODO List Updated', isError: false }] },
  {
    id: 'ac47ae19-f508-4eb8-a726-44d508ef7cb7',
    role: 'assistant',
    createdAt: 1793440971237,
    seq: 402,
    modelId: 'gpt-6-sol',
    content: [
      { type: 'thinking', thinking: '' },
      {
        type: 'tool_use',
        id: 'call_hK2BBUKkQvWCoXabfypazF3f',
        input: {
          todos: '1. [completed] Locate the prompt chips implementation and repository instructions\n2. [completed] Remove the pre-saved prompt chips feature and related dead code\n3. [in_progress] Commit, push, and open a pull request',
        },
        name: 'TodoWrite',
      },
    ],
  },
  {
    id: '56fcf8dc-f11f-4e67-aee0-fac8b46d0ed0',
    role: 'tool',
    createdAt: 1793440967810,
    seq: 401,
    content: [{ type: 'tool_result', toolUseId: 'call_KhwApw9UBCEg85e8TBYYrx3j', content: '{"mergeCommit":{"oid":"7de8c15f75fc36e2c12ebbeb4b035432d7ef16aa"},"mergedAt":"2026-10-31T10:02:43Z","state":"MERGED"}', isError: false }],
  },
  {
    id: '0eb4b1fd-54ab-403e-aad4-92389d68dc8a',
    role: 'assistant',
    createdAt: 1793440967416,
    seq: 398,
    modelId: 'gpt-6-sol',
    content: [
      { type: 'thinking', thinking: '' },
      {
        type: 'tool_use',
        id: 'call_KhwApw9UBCEg85e8TBYYrx3j',
        input: { command: 'gh pr view 352 --repo nikships/droid-office --json state,mergedAt,mergeCommit,url', summary: 'Confirm pull request merged cleanly', timeout: 60, riskLevel: 'low' },
        name: 'Execute',
      },
    ],
  },
  {
    id: 'f119642c-1a54-45bc-a2fa-a2115983e48e',
    role: 'tool',
    createdAt: 1793440964380,
    seq: 397,
    content: [{ type: 'tool_result', toolUseId: 'call_1aj2Wi3iF1nuOqB4OGce7972', content: 'Command completed successfully\n\n[Process exited with code 0]', isError: false }],
  },
  {
    id: '26019abe-1b40-4a6c-a453-b20d1e165984',
    role: 'assistant',
    createdAt: 1793440961724,
    seq: 394,
    modelId: 'gpt-6-sol',
    content: [
      {
        type: 'tool_use',
        id: 'call_1aj2Wi3iF1nuOqB4OGce7972',
        input: { command: 'gh pr merge 352 --repo nikships/droid-office --merge', summary: 'Merge green prompt chip pull request', timeout: 120, riskLevel: 'high' },
        name: 'Execute',
      },
    ],
  },
  {
    id: 'cb9034f6-774e-4d66-9e82-98936af1407d',
    role: 'assistant',
    createdAt: 1793440954816,
    seq: 386,
    modelId: 'gpt-6-sol',
    content: [
      { type: 'thinking', thinking: '**Verifying PR status**\n\nI need to make sure the PR status checks are updated and the base is current before merging.' },
      { type: 'text', text: 'The rerun passed, including the release job. I’ll verify the PR is still mergeable, then merge it.' },
    ],
  },
  {
    id: 'execute-completion:call_zDU5wKQWHMnE6qEVgsHcXFNt',
    role: 'user',
    createdAt: 1793440949213,
    seq: 385,
    visibility: 'llm_only',
    content: [{ type: 'text', text: 'Background Execute command finished.\ntool_use_id: call_zDU5wKQWHMnE6qEVgsHcXFNt' }],
  },
  { id: '21e680b1-4f6c-46f5-a0ae-291c3c1a58fe', role: 'user', createdAt: 1793439039708, seq: 116, content: [{ type: 'text', text: 'create pr when done, merging when green' }] },
];

const parsed = (raw: readonly unknown[]) =>
  mergeMessages(
    [],
    raw.map(messageOf).filter((m): m is FactoryMessage => !!m),
  );

test('projection: Factory messages become the entries a local thread has', () => {
  const entries = cloudEntries(parsed(RAW));
  const byId = new Map(entries.map((e) => [e.id, e]));
  // Oldest first, whole and unique positions, Factory's seq times the stride plus twice the block.
  assert.deepEqual(
    entries.map((e) => e.seq),
    [...entries.map((e) => e.seq)].sort((a, b) => a - b),
  );
  assert.equal(new Set(entries.map((e) => e.seq)).size, entries.length);
  assert.ok(entries.every((e) => Number.isSafeInteger(e.seq)));
  assert.equal(entries[0].seq, 116 * SEQ_STRIDE);
  assert.deepEqual(entries[0], { id: '21e680b1-4f6c-46f5-a0ae-291c3c1a58fe:0', seq: 116 * SEQ_STRIDE, role: 'user', kind: 'text', text: 'create pr when done, merging when green' });
  // The model's own bookkeeping turn (llm_only) and empty thinking are left out.
  assert.equal(
    entries.some((e) => e.id.startsWith('execute-completion')),
    false,
  );
  assert.equal(entries.filter((e) => e.kind === 'thinking').length, 1);
  assert.equal(byId.get('cb9034f6-774e-4d66-9e82-98936af1407d:1')?.kind, 'text');
  // A tool call carries its input as JSON and its result once it's listed.
  const merge = byId.get('tool:call_1aj2Wi3iF1nuOqB4OGce7972')!;
  assert.equal(merge.kind, 'tool');
  assert.equal(merge.name, 'Execute');
  assert.equal(JSON.parse(merge.input!).summary, 'Merge green prompt chip pull request');
  assert.equal(merge.output, 'Command completed successfully\n\n[Process exited with code 0]');
  assert.equal(merge.error, false);
  assert.equal(merge.resultSeq, 394 * SEQ_STRIDE + 1, 'just after the entries before it');
  // TodoWrite's list is the plan.
  const todo = entries.find((e) => e.kind === 'todo')!;
  // Its empty thinking was left out, so the call is that message's first block.
  assert.equal(todo.seq, 402 * SEQ_STRIDE + 1);
  assert.match(todo.text!, /^1\. \[completed] Locate/);

  const rows = presentThread(entries, false);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['message', 'activity', 'message', 'activity', 'message'],
  );
  const run = rows[3];
  assert.ok(run.kind === 'activity');
  assert.equal(run.label, 'Ran 2 commands');
  assert.equal(run.state, 'complete');
  const tools = run.blocks.find((b) => b.kind === 'tools');
  assert.ok(tools?.kind === 'tools');
  assert.deepEqual(
    tools.plan?.map((s) => s.text),
    ['Locate the prompt chips implementation and repository instructions', 'Remove the pre-saved prompt chips feature and related dead code', 'Commit, push, and open a pull request'],
  );
  assert.equal(tools.actions[0].title, 'Merge green prompt chip pull request');
});

test('projection: a call the owner stopped reads as cancelled, not failed', () => {
  // As Factory lists an interrupted Execute on the Mac Mini: the result is the session's last message.
  const entries = cloudEntries(
    parsed([
      { id: 'u', role: 'user', createdAt: 1, seq: 10, content: [{ type: 'text', text: 'Run the shell command sleep 90 then reply done.' }] },
      { id: 'a', role: 'assistant', createdAt: 2, seq: 12, content: [{ type: 'tool_use', id: 'c1', name: 'Execute', input: { command: 'sleep 90', summary: 'Wait for ninety seconds' } }] },
      { id: 't', role: 'tool', createdAt: 3, seq: 15, content: [{ type: 'tool_result', toolUseId: 'c1', content: 'Tool execution cancelled by user', isError: true }] },
    ]),
  );
  const run = presentThread(entries, false).find((r) => r.kind === 'activity');
  assert.ok(run?.kind === 'activity');
  assert.equal(run.state, 'cancelled');
});

test('projection: a call still running, a failed one, pictures, errors and reminders', () => {
  const entries = cloudEntries(
    parsed([
      {
        id: 'u',
        role: 'user',
        createdAt: 1,
        seq: 1,
        content: [
          { type: 'text', text: 'look <system-reminder>secret plumbing</system-reminder>' },
          { type: 'image', source: { mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      },
      {
        id: 'a',
        role: 'assistant',
        createdAt: 2,
        seq: 2,
        content: [
          { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/home/factory-user/a.ts' } },
          { type: 'tool_use', id: 'c2', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
      {
        id: 't',
        role: 'tool',
        createdAt: 3,
        seq: 3,
        content: [
          { type: 'tool_result', toolUseId: 'c2', content: 'Error: bad', isError: true },
          { type: 'tool_result', toolUseId: 'gone', content: 'orphan' },
        ],
      },
      { id: 'e', role: 'assistant', createdAt: 4, seq: 4, isError: true, content: [{ type: 'text', text: 'Model provider unavailable' }] },
    ]),
  );
  assert.deepEqual(
    entries.map((e) => [e.kind, e.text ?? e.name]),
    [
      ['text', 'look'],
      ['notice', '[Image attachment]'],
      ['tool', 'Read'],
      ['tool', 'Grep'],
      ['notice', 'Model provider unavailable'],
    ],
  );
  assert.equal(entries[2].output, undefined);
  assert.equal(entries[3].error, true);
  assert.equal(entries[4].error, true);
  const rows = presentThread(entries, true);
  const live = rows.find((r) => r.kind === 'activity');
  assert.ok(live?.kind === 'activity');
  assert.equal(live.state, 'failed');
  assert.equal(live.failed[0].preview, 'Error: bad');

  assert.equal(todoText({ todos: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress' }, { content: ' ' }, 'x'] }), '1. [completed] One\n2. [in progress] Two');
  assert.equal(todoText({ todos: 7 }), undefined);
  assert.equal(todoText({ todos: '  ' }), undefined);
  // Without Factory's seq, positions follow the order.
  assert.deepEqual(
    cloudEntries([{ id: 'x', role: 'user', createdAt: 1, blocks: [{ type: 'text', text: 'hi' }] }]).map((e) => e.seq),
    [0],
  );
});

interface Call {
  path: string;
  query: URLSearchParams;
}

/** Factory's GET /sessions/s1/messages over `all` (oldest first), paged newest first as Factory does, by `limit` and `cursor`. */
function messages(all: () => unknown[], hook?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const call = { path: url.pathname.replace(/^\/api\/v0/, ''), query: url.searchParams };
    calls.push(call);
    const hooked = hook?.(call);
    if (hooked) return hooked;
    const newest = [...all()].reverse();
    const from = Number(call.query.get('cursor') ?? 0);
    const limit = Number(call.query.get('limit') ?? 20);
    const page = newest.slice(from, from + limit);
    const more = from + limit < newest.length;
    return json(200, { messages: page, pagination: { hasMore: more, nextCursor: more ? String(from + limit) : null } });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), calls };
}

const say = (i: number, role = 'assistant') => ({ id: `m${i}`, role, createdAt: i, seq: i, content: [{ type: 'text', text: `message ${i}` }] });

test('reader: reads Factory far less often than the clients ask, and catches up on what is new', async () => {
  const all = Array.from({ length: 5 }, (_, i) => say(i, i ? 'assistant' : 'user'));
  const f = messages(() => all);
  let now = 10_000;
  const reader = new CloudThreadReader(() => f.api, { now: () => now, busyEveryMs: 2000, idleEveryMs: 15_000 });
  const src = { sessionId: 's1', createdAt: 0, busy: true };

  const first = await reader.read(src);
  assert.equal(first.sessionId, 's1');
  assert.equal(first.error, undefined);
  assert.deepEqual(
    first.entries.map((e) => e.text),
    ['message 0', 'message 1', 'message 2', 'message 3', 'message 4'],
  );
  assert.equal(first.hasMore, false);
  assert.equal(first.presentation?.version, 1);
  assert.equal(first.presentation?.rows.length, 5);
  assert.equal(f.calls[0].query.get('limit'), '100');

  // Asked again a second later: the same page, no call.
  now += 1000;
  await reader.read(src);
  assert.equal(f.calls.length, 1);

  // Past the busy interval: the newest few, merged in.
  all.push(say(5));
  now += 1500;
  const second = await reader.read(src);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].query.get('limit'), '30');
  assert.equal(second.entries.at(-1)?.text, 'message 5');

  // At rest it waits longer.
  now += 5000;
  await reader.read({ ...src, busy: false });
  assert.equal(f.calls.length, 2);
  now += 15_000;
  await reader.read({ ...src, busy: false });
  assert.equal(f.calls.length, 3);

  // More came than a tail page holds: it reads a full page again.
  for (let i = 6; i < 50; i++) all.push(say(i));
  now += 20_000;
  const caught = await reader.read(src);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[4].query.get('limit'), '100');
  assert.equal(caught.entries.length, 50);

  // What the cloud poller read anyway joins on; a page that doesn't join is left alone.
  reader.absorb('s1', [say(50), say(49)]);
  reader.absorb('s1', [say(90)]);
  reader.absorb('nobody', [say(1)]);
  const absorbed = await reader.read(src);
  assert.equal(f.calls.length, 5);
  assert.equal(absorbed.entries.at(-1)?.text, 'message 50');

  reader.forget('s1');
  await reader.read(src);
  assert.equal(f.calls.length, 6);
});

test('reader: pages back through older messages with Factory’s cursor', async () => {
  const all = Array.from({ length: 250 }, (_, i) => say(i));
  const f = messages(() => all);
  const reader = new CloudThreadReader(() => f.api, { now: () => 1 });
  const src = { sessionId: 's1', createdAt: 0, busy: false };
  const newest = await reader.read(src);
  assert.equal(newest.entries.length, 100);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.entries[0].text, 'message 150');

  const older = await reader.read(src, newest.entries[0].seq);
  assert.equal(f.calls.at(-1)?.query.get('cursor'), '100');
  assert.equal(older.entries.length, 100);
  assert.equal(older.entries[0].text, 'message 50');
  assert.equal(older.entries.at(-1)?.text, 'message 149');
  assert.equal(older.hasMore, true);
  assert.ok(older.presentation!.rows.every((r) => r.from < newest.entries[0].seq));

  const oldest = await reader.read(src, older.entries[0].seq);
  assert.equal(oldest.entries[0].text, 'message 0');
  assert.equal(oldest.entries.length, 50);
  assert.equal(oldest.hasMore, false);

  // A reader asked for a page before anything was read reads the newest first.
  const fresh = new CloudThreadReader(() => f.api, { now: () => 1 });
  const before = await fresh.read(src, 200 * SEQ_STRIDE);
  assert.equal(before.entries.at(-1)?.text, 'message 199');
});

test('reader: after the oldest held messages give way to new ones, paging back finds its cursor again', async () => {
  const all = Array.from({ length: 100 }, (_, i) => say(i));
  const f = messages(() => all);
  let now = 10_000;
  const reader = new CloudThreadReader(() => f.api, { now: () => now, busyEveryMs: 1000 });
  const src = { sessionId: 's1', createdAt: 0, busy: true };
  await reader.read(src);
  // A long turn: past 1,500 held, new messages push the oldest out.
  for (let i = 100; i < 1620; i++) all.push(say(i));
  reader.absorb('s1', [...all].reverse());
  now += 2000;
  const latest = await reader.read(src);
  assert.equal(latest.entries.at(-1)?.text, 'message 1619');
  assert.equal(reader.messages('s1').length, 1500);
  const oldestHeld = reader.messages('s1')[0].seq!;
  assert.equal(oldestHeld, 120);
  assert.equal(latest.hasMore, true);

  const back = await reader.read(src, oldestHeld * SEQ_STRIDE);
  assert.equal(back.entries.at(-1)?.text, 'message 119', 'the page just before what was held');
  assert.equal(back.entries.length, 100);
  assert.equal(back.hasMore, true);

  // What was paged back to stays while the turn goes on, and the tail still joins on to it.
  for (let i = 1620; i < 1640; i++) all.push(say(i));
  now += 2000;
  const calls = f.calls.length;
  assert.equal((await reader.read(src)).entries.at(-1)?.text, 'message 1639');
  assert.equal(f.calls.length, calls + 1);
  assert.equal(f.calls.at(-1)?.query.get('limit'), '30');
  assert.equal(reader.messages('s1').length, 1620);
  assert.equal(reader.messages('s1')[0].seq, 20);

  const first = await reader.read(src, back.entries[0].seq);
  assert.equal(f.calls.length, calls + 2, 'no walk: the cursor past what was paged back to is still held');
  assert.equal(first.entries[0].text, 'message 0');
  assert.equal(first.hasMore, false);
});

test('reader: a streamed thread whose oldest messages give way to new ones pages back to them', async () => {
  const all = Array.from({ length: 1500 }, (_, i) => say(i));
  const f = messages(() => all);
  const reader = new CloudThreadReader(() => f.api, { streaming: () => true, now: () => 1 });
  const src = { sessionId: 's1', createdAt: 0, busy: true };
  reader.streamSnapshot('s1', [...all].reverse());

  for (let i = 1500; i < 1520; i++) {
    all.push(say(i));
    reader.streamEvent('s1', { type: 'create_message', message: say(i) });
  }
  assert.equal(reader.messages('s1').length, 1500);
  assert.equal(reader.messages('s1')[0].seq, 20);
  assert.equal((await reader.read(src)).entries.at(-1)?.text, 'message 1519');

  // The dropped messages are still on Factory, past a cursor the stream never gave.
  const back = await reader.read(src, 20 * SEQ_STRIDE);
  assert.equal(back.entries[0].text, 'message 0');
  assert.equal(back.entries.at(-1)?.text, 'message 19');
  assert.equal(back.hasMore, false);

  // Once paged back, new messages don't push those out again.
  reader.streamEvent('s1', { type: 'create_message', message: say(1520) });
  assert.equal(reader.messages('s1')[0].seq, 0);
  assert.equal(reader.messages('s1').length, 1521);
});

test('reader: paging a streamed thread back stops at its history limit and keeps the reply that is streaming', async () => {
  const all = Array.from({ length: 3200 }, (_, i) => say(i));
  const f = messages(() => all);
  const reader = new CloudThreadReader(() => f.api, { streaming: () => true, now: () => 1 });
  const src = { sessionId: 's1', createdAt: 0, busy: true };
  reader.streamSnapshot('s1', all.slice(-100).reverse(), true);
  reader.streamEvent('s1', { type: 'assistant_text_delta', messageId: 'live', blockIndex: 0, textDelta: 'Hello' });
  let page = await reader.read(src);
  for (let i = 0; i < 40 && page.hasMore; i++) page = await reader.read(src, reader.messages('s1')[0].seq! * SEQ_STRIDE);
  assert.equal(page.hasMore, false);
  assert.equal(reader.messages('s1').length, 3000);
  reader.streamEvent('s1', { type: 'assistant_text_delta', messageId: 'live', blockIndex: 0, textDelta: ' world' });
  const live = reader.messages('s1').at(-1)!;
  assert.equal(live.id, 'live');
  assert.deepEqual(live.blocks, [{ type: 'text', text: 'Hello world' }]);
});

test('reader: a just-made session, Factory errors, a slow answer and no connection', async () => {
  let fail: (() => Response) | undefined = () => json(404, { detail: 'Session not found' });
  const all = [say(1)];
  const f = messages(
    () => all,
    () => fail?.(),
  );
  const now = 1_000_000;
  const reader = new CloudThreadReader(() => f.api, { now: () => now, busyEveryMs: 0, waitMs: 20 });
  // Factory 404s a session it has only just made: an empty thread, not an error.
  // With a presentation, so a client reads it as an empty thread rather than an older office.
  assert.deepEqual(await reader.read({ sessionId: 's1', createdAt: now - 1000, busy: true }), { sessionId: 's1', entries: [], hasMore: false, presentation: { version: THREAD_MODEL_VERSION, rows: [] } });
  // An older one that 404s is gone.
  const gone = await reader.read({ sessionId: 's1', createdAt: 0, busy: true });
  assert.match(gone.error ?? '', /Couldn't read its session on Factory: .*not found/i);
  assert.equal(gone.entries.length, 0);
  // Once there's a thread, a failed read keeps it up.
  fail = undefined;
  assert.equal((await reader.read({ sessionId: 's1', createdAt: 0, busy: true })).entries.length, 1);
  fail = () => json(500, { detail: 'boom' });
  const kept = await reader.read({ sessionId: 's1', createdAt: 0, busy: true });
  assert.equal(kept.error, undefined);
  assert.equal(kept.entries.length, 1);

  // A slow answer doesn't hold the page: what's held goes now, the rest at the next read.
  let release = () => {};
  const slow = new Promise<void>((r) => {
    release = r;
  });
  const slowApi = new FactoryApi(KEY, (async () => {
    await slow;
    return json(200, { messages: [say(2), say(1)], pagination: { hasMore: false, nextCursor: null } });
  }) as typeof fetch);
  const slowReader = new CloudThreadReader(() => slowApi, { now: () => now, busyEveryMs: 0, waitMs: 20 });
  assert.deepEqual((await slowReader.read({ sessionId: 's2', createdAt: 0, busy: true })).entries, []);
  release();
  await tick();
  assert.deepEqual(
    (await slowReader.read({ sessionId: 's2', createdAt: 0, busy: true })).entries.map((e) => e.text),
    ['message 1', 'message 2'],
  );

  const offline = new CloudThreadReader(() => undefined);
  assert.match((await offline.read({ sessionId: 's1', createdAt: 0, busy: false })).error ?? '', /isn't connected to Factory/);
});

const ORB = computerOf({ id: 'orb-id', name: 'orb', providerType: 'e2b', status: 'active', createdAt: 1, remoteUser: 'factory-user' })!;

test('cloud feature: thread, interrupt and a hire over the WebSocket', async (t) => {
  const routes: Record<string, () => Response> = {
    'POST /sessions': () => json(201, { sessionId: 's1' }),
    'POST /sessions/s1/messages': () => json(200, { status: 'running' }),
    'POST /sessions/s1/interrupt': () => json(200, { status: 'idle' }),
    'GET /sessions/s1/messages': () => json(200, { messages: [say(2), say(1, 'user')], pagination: { hasMore: false, nextCursor: null } }),
  };
  const calls: string[] = [];
  let connected = true;
  const api = new FactoryApi(KEY, (async (input: string | URL | Request, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(String(input)).pathname.replace(/^\/api\/v0/, '')}`;
    calls.push(key);
    return routes[key]?.() ?? json(404, { detail: `no ${key}` });
  }) as typeof fetch);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-cloud-thread-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cloud = new CloudWorkers(dir, { deskTaken: () => false, names: () => [], pool: { names: ['Ada', 'Bea'], colors: ['#fff'] } }, { update: () => {}, remove: () => {} });
  const floor: CloudFloor = { id: 'f1', name: 'proj', cloud, unstage: (ids) => cloud.drops.unstage(ids) };
  const registry = {
    register: (make: (host: FeatureHost) => CloudFeature) => make({ changed: () => {}, pollSoon: () => {}, api: () => (connected ? api : undefined), toast: () => {} }),
    feature: (key: string) => (key === 'computers' ? { state: () => ({ items: [ORB], instances: [], metrics: {}, providers: [], waking: {}, secrets: [], fetchedAt: 1 }) } : undefined),
  } as unknown as FactoryRegistry;
  const mounted = mountCloud(registry, { floors: () => [floor], agentArgs: [], toast: () => {} });
  const desk = DESKS.filter((d) => !d.station && !d.beanbag);

  const hired = await mounted.hire({ floor: 'f1', deskId: desk[0].id, computerId: 'orb-id', prompt: '' }, 'Nik');
  assert.ok(typeof hired !== 'string');
  assert.equal(hired.kind, 'cloud');
  assert.match((await mounted.hire({ floor: 'f1', deskId: desk[1].id, computerId: 'nope' }, 'Nik')) as string, /isn't on Factory any more/);

  const page = await mounted.thread(hired.id);
  assert.deepEqual(
    page?.entries.map((e) => [e.role, e.text]),
    [
      ['user', 'message 1'],
      ['assistant', 'message 2'],
    ],
  );
  assert.equal(mounted.thread('local-1'), undefined);

  const warned: string[] = [];
  const done: (string | undefined)[] = [];
  const ctx = { who: 'Nik', client: 'c1', warn: (x: string) => warned.push(x), done: (e?: string) => done.push(e) };
  assert.equal(mounted.message({ t: 'worker.interrupt', workerId: hired.id } as Extract<ClientMsg, { workerId: string }>, ctx), true);
  await tick();
  assert.ok(calls.includes('POST /sessions/s1/interrupt'));
  assert.deepEqual(done, [undefined]);

  routes['POST /sessions/s1/interrupt'] = () => json(500, { detail: 'relay down' });
  mounted.message({ t: 'worker.interrupt', workerId: hired.id } as Extract<ClientMsg, { workerId: string }>, ctx);
  await tick();
  assert.match(done[1] ?? '', /Couldn't interrupt Ada: .*relay down/);

  connected = false;
  mounted.message({ t: 'worker.interrupt', workerId: hired.id } as Extract<ClientMsg, { workerId: string }>, ctx);
  assert.match(done[2] ?? '', /isn't connected to Factory/);
  assert.match((await mounted.hire({ floor: 'f1', deskId: desk[1].id, computerId: 'orb-id' }, 'Nik')) as string, /isn't connected to Factory/);
  assert.match((await mounted.thread(hired.id))?.error ?? '', /isn't connected/);
});
