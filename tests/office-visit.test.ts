import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ASK_DEFAULT_S, UsageError, buildBody, buildRequest, formatOutcome, formatRoster, main, needsText, parseArgs, refusal } from '../bin/office-visit.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-visit.js');
const ENV = { DROID_OFFICE_HOOK_URL: 'http://127.0.0.1:4455/', DROID_OFFICE_WORKER_ID: 'w1 &x', DROID_OFFICE_HOOK_TOKEN: 'tok' };

test('parses every command, its aliases and its options', () => {
  assert.deepEqual(parseArgs(['roster']), { cmd: 'roster', names: [], opts: {} });
  for (const a of ['ls', 'list', 'who']) assert.equal(parseArgs([a]).cmd, 'roster');
  assert.deepEqual(parseArgs(['look', 'Nibble', '--lines=20']), { cmd: 'look', names: ['Nibble'], opts: { '--lines': 20 } });
  assert.equal(parseArgs(['read', 'Nibble']).cmd, 'look');
  assert.deepEqual(parseArgs(['tell', 'Nibble', '--urgent']), { cmd: 'tell', names: ['Nibble'], opts: { '--urgent': true } });
  assert.equal(parseArgs(['say', 'Nibble']).cmd, 'tell');
  assert.deepEqual(parseArgs(['ask', 'Nibble', '--timeout', '600']), { cmd: 'ask', names: ['Nibble'], opts: { '--timeout': 600 } });
  assert.deepEqual(parseArgs(['handoff', 'Nibble', '--title', 'Tests']), { cmd: 'handoff', names: ['Nibble'], opts: { '--title': 'Tests' } });
  assert.deepEqual(parseArgs(['reply', 'v-1a2b']), { cmd: 'reply', names: ['v-1a2b'], opts: {} });
  assert.equal(parseArgs(['answer', 'v-1a2b']).cmd, 'reply');
  assert.deepEqual(parseArgs([]), { cmd: 'help', full: true });
  assert.deepEqual(parseArgs(['ask', '-h']), { cmd: 'help', full: false });
  assert.equal(needsText(parseArgs(['tell', 'Nibble'])), true);
  assert.equal(needsText(parseArgs(['tell', 'Nibble', '--message', 'hi'])), false);
  assert.equal(needsText(parseArgs(['look', 'Nibble'])), false);
});

test('says what is wrong with a bad command line', () => {
  const bad = (argv: string[], msg: RegExp) =>
    assert.throws(
      () => parseArgs(argv),
      (e: Error) => e instanceof UsageError && msg.test(e.message),
    );
  bad(['visit'], /Unknown command: visit/);
  bad(['look'], /look takes the worker's name, e\.g\. office-visit look Nibble/);
  bad(['reply'], /reply takes the visit id from the question/);
  bad(['tell', 'Nibble', 'hello', 'there'], /tell takes one worker's name \(got Nibble hello there\): give the text on stdin/);
  bad(['roster', 'Nibble'], /Unexpected argument: Nibble/);
  bad(['tell', 'Nibble', '--loud'], /Unknown option for tell: --loud/);
  bad(['tell', 'Nibble', '--urgent=yes'], /takes no value/);
  bad(['ask', 'Nibble', '--timeout'], /--timeout needs a value/);
  bad(['ask', 'Nibble', '--timeout', '0'], /from 1 to 1800/);
  bad(['ask', 'Nibble', '--timeout', '1801'], /from 1 to 1800/);
  bad(['look', 'Nibble', '--lines', '2.5'], /--lines takes a whole number from 1 to 400/);
});

test('builds the /office/visits requests, with the text from stdin', () => {
  const body = (argv: string[], text?: string) => buildBody(parseArgs(argv), text);
  assert.deepEqual(body(['whoami']), { action: 'whoami' });
  assert.deepEqual(body(['roster']), { action: 'roster' });
  assert.deepEqual(body(['look', 'Nibble']), { action: 'visit', kind: 'look', worker: 'Nibble' });
  assert.deepEqual(body(['look', 'Nibble', '--lines', '9']), { action: 'visit', kind: 'look', worker: 'Nibble', lines: 9 });
  assert.deepEqual(body(['tell', 'Nibble'], ' I renamed it\r\n'), { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'I renamed it' });
  assert.deepEqual(body(['tell', 'Nibble', '--urgent', '--message', 'Stop']), { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'Stop', urgent: true });
  assert.deepEqual(body(['ask', 'Nibble'], 'Port?'), { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Port?', timeout: ASK_DEFAULT_S });
  assert.deepEqual(body(['ask', 'Nibble', '--timeout', '60', '--urgent'], 'Port?'), { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Port?', urgent: true, timeout: 60 });
  assert.deepEqual(body(['handoff', 'Nibble', '--title', ' Tests '], 'Write them'), { action: 'visit', kind: 'handoff', worker: 'Nibble', text: 'Write them', title: 'Tests' });
  assert.deepEqual(body(['reply', 'v-1'], '5173'), { action: 'reply', visit: 'v-1', text: '5173' });
  assert.throws(() => body(['ask', 'Nibble'], '  '), /Give the question on stdin \(office-visit ask Nibble <<'EOF' … EOF\)/);
  assert.throws(() => body(['reply', 'v-1'], ''), /Give the answer on stdin/);
  assert.deepEqual(buildRequest({ action: 'roster' }, { url: 'http://127.0.0.1:4455', worker: 'w1 &x', token: 'tok' }), {
    method: 'POST',
    url: 'http://127.0.0.1:4455/office/visits?worker=w1+%26x',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: '{"action":"roster"}',
  });
});

test('prints the roster and each visit’s outcome readably', () => {
  const roster = formatRoster({
    you: { name: 'Pixel', desk: 'Desk 3' },
    roster: [
      { id: 'w1', name: 'Pixel', desk: 'Desk 3', status: 'working', busy: true, you: true },
      { id: 'w2', name: 'Nibble', desk: 'Desk 9', status: 'done', busy: false, task: 'Fix Login', activity: 'Running tests', visiting: 'Dot' },
    ],
  });
  assert.equal(
    roster,
    ["You're Pixel at Desk 3.", '', '2 independent workers on this floor:', '  Pixel (you) (w1) · Desk 3 · busy (working)', "  Nibble (w2) · Desk 9 · idle (done) · at Dot's desk", '      task: Fix Login', '      doing: Running tests'].join(
      '\n',
    ),
  );
  assert.match(formatRoster({ you: { name: 'Pixel', desk: 'Desk 3' }, roster: [{ id: 'w1', name: 'Pixel', you: true }] }), /No other independent workers on this floor/);
  assert.match(formatRoster({ you: { name: 'Pixel', desk: 'Desk 3' }, visiting: { host: 'Nibble', kind: 'ask', visit: 'v-1' }, roster: [] }), /You're at Nibble's desk now \(ask, v-1\)/);
  assert.deepEqual(formatOutcome('look', 'Nibble', { ok: true, text: '$ ls' }), { text: "Nibble's screen:\n\n$ ls", code: 0 });
  assert.deepEqual(formatOutcome('look', 'Nibble', { ok: true, text: '' }), { text: "Nibble's screen:\n\n(its terminal is empty)", code: 0 });
  assert.deepEqual(formatOutcome('ask', 'Nibble', { ok: true, answer: '5173\nand 4600' }), { text: 'Nibble answered:\n    5173\n    and 4600', code: 0 });
  assert.deepEqual(formatOutcome('tell', 'Nibble', { ok: true, delivered: true }), { text: "Your message is in Nibble's session now.", code: 0 });
  assert.match(formatOutcome('handoff', 'Nibble', { ok: true, delivered: true }).text, /^The task is in Nibble's session now\. Nibble decides/);
  assert.match(formatOutcome('tell', 'Nibble', { ok: true, queued: true }).text, /^Nibble is busy, so you walked back and left it: your message waits in its queue/);
  assert.deepEqual(formatOutcome('ask', 'Nibble', { ok: false, error: "Nibble didn't answer within 5 seconds" }), { text: "office-visit: Nibble didn't answer within 5 seconds.", code: 1 });
  assert.equal(formatOutcome('ask', 'Nibble', undefined).code, 1);
  assert.match(refusal(401, {}), /didn't accept this agent's token \(401\)/);
  assert.equal(refusal(403, { error: 'Visits are off' }), 'office-visit: The office said no (403): Visits are off.'.replace('office-visit: ', ''));
});

async function run(argv: string[], opts: { stdin?: string; tty?: boolean; env?: Record<string, string>; replies?: { status?: number; body: unknown }[] } = {}) {
  const sent: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const replies = opts.replies ?? [{ body: {} }];
  const fetch = async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  const stdin = Object.assign(Readable.from(opts.stdin === undefined ? [] : [opts.stdin]), opts.tty ? { isTTY: true } : {});
  const code = await main(argv, {
    env: opts.env ?? ENV,
    stdin,
    fetch: fetch as typeof globalThis.fetch,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { code, sent, out: out.join('\n'), err: err.join('\n') };
}

const STARTED = { visit: 'v-1', kind: 'ask', host: { id: 'w2', name: 'Nibble', desk: 'Desk 9' }, walkMs: 4000, timeout: 120 };

test('ask walks over, waits for the answer and prints it', async () => {
  const r = await run(['ask', 'Nibble', '--timeout', '120'], {
    stdin: 'Which port?\n',
    replies: [{ body: STARTED }, { body: { phase: 'walking', done: false } }, { body: { phase: 'waiting', done: false } }, { body: { phase: 'waiting', done: false } }, { body: { phase: 'waiting', done: true, ok: true, answer: '5173' } }],
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.sent[0], { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Which port?', timeout: 120 });
  assert.deepEqual(r.sent[1], { action: 'status', visit: 'v-1' });
  assert.equal(r.sent.length, 5);
  assert.equal(r.out, ['Walking over to Nibble at Desk 9 to ask it…', "Asked. Waiting at Nibble's desk for its answer (visit v-1)…", 'Nibble answered:\n    5173'].join('\n'));

  const late = await run(['ask', 'Nibble', '--timeout', '5'], { stdin: 'x', replies: [{ body: { ...STARTED, timeout: 5 } }, { body: { phase: 'waiting', done: true, ok: false, error: "Nibble didn't answer within 5 seconds" } }] });
  assert.equal(late.code, 1);
  assert.match(late.out, /office-visit: Nibble didn't answer within 5 seconds\.$/);
});

test('look, tell, handoff and reply print what the office sent back', async () => {
  const look = await run(['look', 'Nibble'], { replies: [{ body: { ...STARTED, kind: 'look', timeout: undefined } }, { body: { done: true, ok: true, text: 'ok 12 tests' } }] });
  assert.equal(look.code, 0);
  assert.equal(look.out, "Walking over to Nibble at Desk 9 to read its screen…\nNibble's screen:\n\nok 12 tests");
  const tell = await run(['tell', 'Nibble'], { stdin: 'fyi', replies: [{ body: { ...STARTED, kind: 'tell', after: 2000 } }, { body: { done: true, ok: true, queued: true } }] });
  assert.match(tell.out, /^You're finishing your last visit; then you go over to Nibble at Desk 9 to tell it\.\nNibble is busy/);
  const hand = await run(['handoff', 'Nibble', '--title', 'Tests'], { stdin: 'Write them', replies: [{ body: { ...STARTED, kind: 'handoff' } }, { body: { done: true, ok: true, delivered: true } }] });
  assert.match(hand.out, /The task is in Nibble's session now/);
  const reply = await run(['reply', 'v-1'], { stdin: '5173', replies: [{ body: { to: 'Pixel' } }] });
  assert.equal(reply.out, 'Answered Pixel. It has your answer and walks back to its desk.');
  const roster = await run(['roster'], { replies: [{ body: { you: { name: 'Pixel', desk: 'Desk 3' }, roster: [] } }] });
  assert.match(roster.out, /^You're Pixel at Desk 3\./);
  const who = await run(['whoami'], { replies: [{ body: { you: { name: 'Pixel', desk: 'Desk 3' }, visiting: { host: 'Nibble', kind: 'look', visit: 'v-1' } } }] });
  assert.match(who.out, /^You're Pixel at Desk 3\. You can visit[\s\S]*You're at Nibble's desk now \(look, v-1\)\.$/);
  const help = await run(['help']);
  assert.match(help.out, /PRIORITY[\s\S]*ONE VISIT AT A TIME[\s\S]*WHAT YOU GET IN YOUR SESSION/);
  assert.match((await run(['tell', '-h'])).out, /^Usage:/);
  // An office that never finishes the visit: it gives up in the end, saying so.
  const stuck = await run(['look', 'Nibble'], { replies: [{ body: { ...STARTED, kind: 'look' } }, { body: { done: false, phase: 'walking' } }] });
  assert.equal(stuck.code, 1);
  assert.match(stuck.out, /didn't finish the visit in 180s/);
});

test('a subagent, a turned-off office and a missing environment get a clear refusal', async () => {
  const sub = await run(['roster'], { replies: [{ status: 403, body: { error: "You're a subagent of Pixel: subagents don't visit other workers or see the roster" } }] });
  assert.equal(sub.code, 1);
  assert.equal(sub.err, "office-visit: The office said no (403): You're a subagent of Pixel: subagents don't visit other workers or see the roster.");
  const off = await run(['tell', 'Nibble'], { stdin: 'x', replies: [{ status: 403, body: { error: 'Visits between workers are turned off in this office' } }] });
  assert.match(off.err, /turned off/);
  const noEnv = await run(['roster'], { env: {} });
  assert.equal(noEnv.code, 1);
  assert.equal(noEnv.sent.length, 0);
  assert.match(noEnv.err, /aren't set\. office-visit only works inside Droid Office/);
  const tty = await run(['tell', 'Nibble'], { tty: true });
  assert.equal(tty.code, 2);
  assert.match(tty.err, /tell needs its text on stdin[\s\S]*Usage:/);
});

test('runs as a command: the question goes over HTTP with the agent’s own token', async (t) => {
  const seen: { url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const b = JSON.parse(body);
      res.writeHead(req.headers.authorization === 'Bearer tok' ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b.action === 'visit' ? STARTED : { done: true, ok: true, answer: 'yes' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [SCRIPT, 'ask', 'Nibble'], { env: { PATH: process.env.PATH ?? '', ...ENV, DROID_OFFICE_HOOK_URL: url, DROID_OFFICE_WORKER_ID: 'w1' } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin?.end("Don't expand $HOME?\n");
  });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Nibble answered:\n {4}yes\n$/);
  assert.equal(seen[0].url, '/office/visits?worker=w1');
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.equal(seen[0].body, JSON.stringify({ action: 'visit', kind: 'ask', worker: 'Nibble', text: "Don't expand $HOME?", timeout: ASK_DEFAULT_S }));
});
