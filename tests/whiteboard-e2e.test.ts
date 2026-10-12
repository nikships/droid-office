import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import type { ServerMsg } from '../src/shared/protocol.js';
import { findCard, type Board } from '../src/shared/whiteboard.js';
import { main } from '../bin/office-whiteboard.js';

const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const log = process.env.FAKE_AGENT_LOG;
const record = (extra = {}) => fs.appendFileSync(log, JSON.stringify({ ...extra, env: { workerId: process.env.DROID_OFFICE_WORKER_ID, hookToken: process.env.DROID_OFFICE_HOOK_TOKEN, hookUrl: process.env.DROID_OFFICE_HOOK_URL, path: process.env.PATH } }) + '\\n');
if (process.argv.includes('--output-format')) {
  process.stdout.write(JSON.stringify({ structured_output: { name: 'Fake Task', summary: 'A test task' } }));
  process.exit(0);
}
record();
process.stdout.write('fake-agent-ready\\r\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => record({ stdin: chunk }));
process.stdin.resume();
`;

async function waitFor<T>(read: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(25);
  }
}

test('an agent and the owner share a floor Whiteboard end to end: office-whiteboard, the window, card routes and pings', { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-e2e-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  for (const d of [project, home, work]) mkdirSync(d, { recursive: true });
  const agent = path.join(root, 'droid');
  writeFileSync(agent, fakeAgent, { mode: 0o700 });
  const log = path.join(root, 'agent.jsonl');
  writeFileSync(log, '');
  const before = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = log;
  const cfg = loadConfig([project, '--home', home, '--weather', 'clear', '--host', '127.0.0.1', '--agent', agent]);
  cfg.port = 0;
  const office = await startServer(cfg);
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await delay(150);
    if (before === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = before;
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;

  // The owner's window.
  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  const welcome = await waitFor(() => msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined, 'welcome');
  assert.equal(welcome.whiteboardSkill.on, true);
  const floor = welcome.floor!;
  const snap = await waitFor(() => msgs.find((m) => m.t === 'whiteboard' && m.update.kind === 'snapshot') as Extract<ServerMsg, { t: 'whiteboard' }> | undefined, 'the snapshot');
  assert.equal(snap.floor, floor);
  assert.equal(snap.renderer?.available, false);
  const epoch = snap.update.kind === 'snapshot' ? snap.update.epoch : '';
  assert.ok(epoch);
  const boardMsgs = () => msgs.filter((m): m is Extract<ServerMsg, { t: 'whiteboard' }> => m.t === 'whiteboard');
  const store = () => office.floors()[0].whiteboard;
  const send = (m: unknown) => ws.send(JSON.stringify(m));

  // A worker at a desk, with its hook token in its environment.
  send({ t: 'worker.spawn', deskId: 'desk-1', kind: 'agent', worktree: false });
  const launch = await waitFor(() => {
    // A poll can land mid-append. A finished record always ends with a newline, so a trailing segment without one is not a record yet.
    const text = readFileSync(log, 'utf8');
    const lines = text.split('\n');
    if (text.length > 0 && !text.endsWith('\n')) lines.pop();
    return lines
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((r) => r.env?.hookToken) as { env: { workerId: string; hookToken: string; hookUrl: string; path: string } } | undefined;
  }, 'the agent to start');
  const bin = launch.env.path.split(path.delimiter)[0];
  assert.ok(existsSync(path.join(bin, 'office-whiteboard')), 'office-whiteboard is on every agent PATH, next to office-workers');
  assert.ok(existsSync(path.join(bin, 'office-workers')));
  const env = { DROID_OFFICE_HOOK_URL: launch.env.hookUrl, DROID_OFFICE_WORKER_ID: launch.env.workerId, DROID_OFFICE_HOOK_TOKEN: launch.env.hookToken };
  const cli = async (args: string[], stdin = '', extra: { env?: Record<string, string> } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const s = Readable.from(stdin ? [stdin] : []);
    const code = await main(args, { env: extra.env ?? env, stdin: s as unknown as NodeJS.ReadStream, out: (x: string) => out.push(x), err: (x: string) => err.push(x), cwd: work });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  const who = await cli(['whoami']);
  assert.equal(who.code, 0, who.err);
  assert.match(who.out, /on the .* floor\. Its Whiteboard has 0 cards/);
  assert.match(who.out, /\(revision 0\)\. Cards are not rendered to images in this office yet: it has no renderer/);
  const wrong = await cli(['read'], '', { env: { ...env, DROID_OFFICE_HOOK_TOKEN: 'nope' } });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /didn't accept this agent's token \(401\)/);

  // A card from a file with its assets, pushed by the agent: the window hears it.
  writeFileSync(path.join(work, 'style.css'), 'h1 { color: teal }');
  writeFileSync(path.join(work, 'plan.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1 data-wb-id="title">Plan</h1><img src="../gone.png"><form><input name="email"></form>');
  const pushed = await cli(['push', '--title', 'The plan', '--file', 'plan.html']);
  assert.equal(pushed.code, 0, pushed.err);
  const card = pushed.out.trim();
  assert.match(card, /^c-[0-9a-f]{10}$/);
  assert.match(pushed.err, /Not collected: \.\.\/gone\.png/);
  const created = await waitFor(() => boardMsgs().find((m) => m.update.kind === 'patch' && m.update.patch.ops.some((o) => o.op === 'card.create')), 'the patch');
  assert.ok(created.caps?.[card], 'the new card comes with its capability');
  const cap = created.caps![card];

  // The card route: sandboxed, CORS for the card only, the SDK injected, no other card's files.
  const page = await fetch(`${base}/whiteboard/c/${cap}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get('content-security-policy')!, /allow-same-origin/);
  assert.equal(page.headers.get('access-control-allow-origin'), '*');
  assert.equal(page.headers.get('access-control-allow-credentials'), null);
  assert.match(await page.text(), /data-droid-office-whiteboard/);
  assert.equal((await fetch(`${base}/whiteboard/c/${cap}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${base}/whiteboard/c/${cap}/..%2F..%2Fboard.json`)).status, 404);
  const forged = await fetch(`${base}/whiteboard/c/k${'A'.repeat(40)}/`);
  assert.equal(forged.status, 404);
  assert.match(forged.headers.get('content-security-policy')!, /^sandbox/);
  assert.equal((await fetch(`${base}/api/health`)).headers.get('access-control-allow-origin'), null, 'no other route gets CORS');
  assert.equal((await fetch(`${base}/api/whiteboard/file?floor=${floor}&card=${card}&hash=${'0'.repeat(64)}`)).status, 404);
  const entryHash = findCard(store().board, card)!.content!.files['plan.html'].hash;
  assert.equal((await fetch(`${base}/api/whiteboard/file?floor=${floor}&card=${card}&hash=${entryHash}`)).status, 200);
  // A card capability is no key to anything else.
  assert.equal((await fetch(`${base}/api/whiteboard/render/status?floor=${floor}&card=${card}&cap=${cap}`)).status, 200);

  // The renderer isn't there: every render route says so.
  const render = await fetch(`${base}/api/whiteboard/render?floor=${floor}&card=${card}`);
  assert.equal(render.status, 503);
  assert.equal(((await render.json()) as { available: boolean }).available, false);
  const status = (await (await fetch(`${base}/api/whiteboard/render/status?floor=${floor}&card=${card}`)).json()) as { available: boolean; reason: string };
  assert.equal(status.available, false);
  assert.match(status.reason, /renderer/);

  // The window uploads a picture and comments: once, however many times it sends the batch.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await fetch(`${base}/api/whiteboard/blob?floor=${floor}&mime=image/png`, { method: 'POST', body: PNG })).status, 403, 'only the office page uploads');
  const up = await fetch(`${base}/api/whiteboard/blob?floor=${floor}&mime=image/png`, { method: 'POST', headers: { origin: base }, body: PNG });
  assert.equal(up.status, 200);
  const ref = await up.json();
  const comment = {
    t: 'whiteboard.apply',
    floor,
    envelope: {
      epoch,
      seq: 1,
      ops: [
        { op: 'comment.add', card, thread: 't1', message: 'm1', anchor: { kind: 'element', wbId: 'title', point: { x: 0, y: 0 } }, text: 'Why teal?' },
        { op: 'picture.add', card, id: 'p1', file: ref, anchor: { kind: 'point', point: { x: 10, y: 10 } }, box: { w: 40, h: 40 } },
        { op: 'state.set', card, path: ['fields', 'email'], value: 'owner@example.com' },
      ],
    },
  };
  send(comment);
  const acked = await waitFor(() => boardMsgs().find((m) => m.update.kind === 'ack' && m.update.seq === 1), 'the ack');
  const patch = boardMsgs().find((m) => m.update.kind === 'patch' && m.origin?.epoch === epoch && m.origin.seq === 1);
  assert.ok(patch, 'the patch names the batch it came from');
  assert.ok(boardMsgs().indexOf(patch!) < boardMsgs().indexOf(acked), 'the patch comes before the ack');
  const patches = boardMsgs().filter((m) => m.update.kind === 'patch').length;
  send(comment);
  await waitFor(() => boardMsgs().filter((m) => m.update.kind === 'ack' && m.update.seq === 1).length === 2 || undefined, 'the second ack');
  assert.equal(boardMsgs().filter((m) => m.update.kind === 'patch').length, patches, 'a retry is not applied again');
  assert.equal(findCard(store().board, card)!.threads.length, 1);
  send({ t: 'whiteboard.apply', floor, envelope: { epoch, seq: 2, ops: [{ op: 'card.title', card: 'nope', title: 'x' }] } });
  const bad = await waitFor(() => boardMsgs().find((m) => m.update.kind === 'rejected'), 'the rejection');
  assert.match(bad.update.kind === 'rejected' && bad.update.reason === 'invalid' ? bad.update.error.message : '', /Operation 0 \(card\.title\)/);
  send({ t: 'whiteboard.apply', floor, envelope: { epoch: 'x.y.zzzzzzzzzzzzzzzz', seq: 1, ops: [{ op: 'show', selection: { kind: 'grid' } }] } });
  await waitFor(() => boardMsgs().find((m) => m.update.kind === 'rejected' && m.update.reason === 'expired'), 'the expired rejection');

  // The agent reads: the owner's comment, picture and answer are changed; after the read they aren't.
  const read = await cli(['read', card]);
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /— CHANGED/);
  assert.match(read.out, /Changed for you: state fields\.email; comment thread t1 \(open or resolved, place\); comment t1\/m1; picture p1 \(file, position or size, place\)/);
  assert.match(read.out, /Why teal\?.*← CHANGED/);
  assert.match(read.out, /State {2}← CHANGED: \{"fields":\{"email":"owner@example.com"\}\}/);
  assert.match(read.out, /Picture p1 \(image\/png, 40×40 at 0,0, anchored at 10,10\): .*blobs/);
  assert.match(read.out, / {4}\| <!doctype html>.*<h1 data-wb-id="title">Plan<\/h1>/, 'a named card prints its HTML');
  assert.match(read.out, /Not collected: \.\.\/gone\.png/);
  const rev = store().board.rev;
  assert.equal(store().board.reads[launch.env.workerId][card], rev - 1, 'the read point moved to the read snapshot');
  const again = await cli(['read', '--json']);
  const json = JSON.parse(again.out);
  assert.equal(json.cards[0].changed, false);
  assert.equal(json.cards[0].pictures[0].file.file, store().blobFile(ref.hash));

  // The agent writes back: a reply, a state merge, a sticky; the window sees each, and the owner's read shows them changed.
  const reply = await cli(['comment', card, 'reply', 't1', '--text', 'It matches the logo']);
  assert.equal(reply.code, 0, reply.err);
  assert.equal((await cli(['state', card, 'merge', '{"fields":{"name":"Ada"}}'])).code, 0);
  assert.equal((await cli(['state', card, 'get', 'fields.name'])).out, '"Ada"');
  assert.equal((await cli(['state', card, 'get', 'fields.nope'])).code, 1);
  const sticky = await cli(['sticky', card, 'add', '--on', 'title', '--text', 'Looks good']);
  assert.match(sticky.out, /^s-/);
  assert.equal((await cli(['show', card])).code, 0);
  assert.deepEqual(store().board.selection, { kind: 'card', id: card });
  const t1 = findCard(store().board, card)!.threads[0];
  assert.equal(t1.messages[1].author.kind, 'worker');
  assert.equal(t1.messages[1].text, 'It matches the logo');

  // An invalid batch from the agent changes nothing, says which operation and why, and exits 1.
  const invalid = await cli(
    ['apply'],
    JSON.stringify([
      { op: 'card.title', card, title: 'ok' },
      { op: 'sticky.rm', card, id: 'nope' },
    ]),
  );
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /Operation 1 \(sticky\.rm\) failed/);
  assert.equal(findCard(store().board, card)!.title, 'The plan');
  const usage = await cli(['push']);
  assert.equal(usage.code, 2);

  // --png without a renderer: the read says so and doesn't move the read point.
  send({ t: 'whiteboard.apply', floor, envelope: { epoch, seq: 3, ops: [{ op: 'comment.reply', card, thread: 't1', message: 'm3', text: 'And the PNG?' }] } });
  await waitFor(() => boardMsgs().find((m) => m.update.kind === 'ack' && m.update.seq === 3), 'the third ack');
  const pngDir = path.join(work, 'png');
  const shot = await cli(['read', card, '--png', 'png']);
  assert.equal(shot.code, 0, shot.err);
  assert.match(shot.out, /PNG: none — .*renderer.*wasn't moved/);
  assert.ok(!existsSync(pngDir) || readdirSync(pngDir).length === 0);
  const still = JSON.parse((await cli(['read', card, '--json'])).out);
  assert.equal(still.cards[0].changed, true, 'the read with a failed PNG left the card unread');

  // A linked card follows its file; an update is refused while linked.
  writeFileSync(path.join(work, 'live.html'), '<p>live v1</p>');
  const linked = await cli(['push', '--title', 'Live', '--link', 'live.html']);
  assert.equal(linked.code, 0, linked.err);
  const live = linked.out.trim();
  assert.equal(findCard(store().board, live)!.link?.status, 'ok');
  const refused = await cli(['update', live, '--file', 'live.html']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /unlink the card first/);
  writeFileSync(path.join(work, 'live.html'), '<p>live v2</p>');
  await waitFor(() => store().serve(store().cardCap(live), '')?.body.toString().includes('live v2') || undefined, 'the link to update');
  assert.equal((await cli(['unlink', live])).code, 0);
  assert.equal((await cli(['rm', live])).code, 0);
  assert.equal(findCard(store().board, live), undefined);

  // Ping: refused while it's starting, typed in when idle, queued behind a turn when working.
  const pinged = () => msgs.filter((m): m is Extract<ServerMsg, { t: 'whiteboard.pinged' }> => m.t === 'whiteboard.pinged');
  send({ t: 'whiteboard.ping', worker: launch.env.workerId });
  const first = await waitFor(() => pinged()[0], 'the first ping');
  assert.equal(first.ok, false);
  assert.match(first.error!, /still starting/);
  const hook = (event: string) =>
    fetch(`${launch.env.hookUrl}/hooks/droid?worker=${launch.env.workerId}&event=${event}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${launch.env.hookToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: event, session_id: 'sess-1', prompt: 'work' }),
    });
  assert.equal((await hook('SessionStart')).status, 200);
  send({ t: 'whiteboard.ping', worker: launch.env.workerId });
  const second = await waitFor(() => pinged()[1], 'the second ping');
  assert.deepEqual([second.ok, second.how], [true, 'type']);
  await waitFor(() => readFileSync(log, 'utf8').includes('office-whiteboard read') || undefined, 'the line typed in');
  assert.equal((await hook('UserPromptSubmit')).status, 200);
  send({ t: 'whiteboard.ping', worker: launch.env.workerId });
  const third = await waitFor(() => pinged()[2], 'the third ping');
  assert.deepEqual([third.ok, third.how], [true, 'queue']);
  send({ t: 'whiteboard.ping', worker: 'nobody' });
  assert.equal((await waitFor(() => pinged()[3], 'the fourth ping')).ok, false);

  // A resync gives the same epoch, so its resends are still recognised.
  send({ t: 'whiteboard.sync', floor });
  const resync = await waitFor(() => boardMsgs().filter((m) => m.update.kind === 'snapshot')[1], 'the resync');
  assert.equal(resync.update.kind === 'snapshot' && resync.update.epoch, epoch);
  assert.equal((resync.update as { board: Board }).board.rev, store().board.rev);

  // The skill toggle.
  send({ t: 'whiteboardSkill.set', on: false });
  const skill = await waitFor(() => msgs.find((m) => m.t === 'whiteboardSkill') as Extract<ServerMsg, { t: 'whiteboardSkill' }> | undefined, 'the skill state');
  assert.equal(skill.state.on, false);
  assert.equal(JSON.parse(readFileSync(path.join(cfg.dataDir, 'whiteboard-skill.json'), 'utf8')).on, false);

  // Dismissed, its read points go.
  send({ t: 'worker.kill', workerId: launch.env.workerId, cleanup: 'keep' });
  await waitFor(() => (store().board.reads[launch.env.workerId] === undefined ? true : undefined), 'its read points to go');
});
