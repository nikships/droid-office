import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { UsageError, buildRequest, formatTicket, formatTransitions, main, officeEnv, parseArgs, refusal } from '../bin/office-jira.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-jira.js');
const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'w1 &x', token: 'tok' };

test('parses view, transitions, transition and comment, with --key', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['view', '--help']), { cmd: 'help' });
  assert.deepEqual(parseArgs(['view']), { cmd: 'view' });
  assert.deepEqual(parseArgs(['show', '--key', 'EDP-12']), { cmd: 'view', key: 'EDP-12' });
  assert.deepEqual(parseArgs(['transitions', '--key=EDP-12']), { cmd: 'transitions', key: 'EDP-12' });
  assert.deepEqual(parseArgs(['transition', 'In', 'Review']), { cmd: 'transition', to: 'In Review' });
  assert.deepEqual(parseArgs(['move', 'Done']), { cmd: 'transition', to: 'Done' });
  assert.deepEqual(parseArgs(['comment']), { cmd: 'comment' });
  assert.deepEqual(parseArgs(['comment', 'PR', 'is', 'up']), { cmd: 'comment', text: 'PR is up' });
});

test('says what is wrong with a bad command line', () => {
  const bad: [string[], RegExp][] = [
    [['frobnicate'], /Unknown command: frobnicate/],
    [['view', 'EDP-12'], /view takes no arguments/],
    [['transitions', 'x'], /transitions takes no arguments/],
    [['transition'], /Say where to move it/],
    [['view', '--key'], /--key needs a ticket key/],
  ];
  for (const [argv, message] of bad)
    assert.throws(
      () => parseArgs(argv),
      (e: Error) => e instanceof UsageError && message.test(e.message),
      argv.join(' '),
    );
});

test('needs the office address, its worker id and its token from the environment', () => {
  assert.deepEqual(officeEnv({ ...ENV, AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455/' }), { url: 'http://127.0.0.1:4455', worker: 'w1', token: 'tok' });
  assert.throws(() => officeEnv({}), /aren't set\. office-jira only works inside Agent Office/);
  assert.throws(() => officeEnv({ ...ENV, AGENT_OFFICE_HOOK_TOKEN: '' }), /^Error: AGENT_OFFICE_HOOK_TOKEN isn't set/);
});

test('builds the /office/jira requests', () => {
  const auth = { authorization: 'Bearer tok' };
  const json = { ...auth, 'content-type': 'application/json' };
  assert.deepEqual(buildRequest({ cmd: 'view' }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/jira?worker=w1+%26x', headers: auth });
  assert.deepEqual(buildRequest({ cmd: 'transitions', key: 'EDP-12' }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/jira?worker=w1+%26x&key=EDP-12&what=transitions', headers: auth });
  assert.deepEqual(buildRequest({ cmd: 'transition', to: 'In Review' }, OFFICE), {
    method: 'POST',
    url: 'http://127.0.0.1:4455/office/jira?worker=w1+%26x',
    headers: json,
    body: JSON.stringify({ action: 'transition', to: 'In Review' }),
  });
  assert.deepEqual(buildRequest({ cmd: 'comment' }, OFFICE, 'Line one\r\nLine two\n'), {
    method: 'POST',
    url: 'http://127.0.0.1:4455/office/jira?worker=w1+%26x',
    headers: json,
    body: JSON.stringify({ action: 'comment', body: 'Line one\nLine two' }),
  });
  assert.throws(
    () => buildRequest({ cmd: 'comment' }, OFFICE, '  '),
    (e: Error) => e instanceof UsageError && /The comment is empty/.test(e.message),
  );
});

test('prints the ticket, its moves and the refusals readably', () => {
  const view = {
    key: 'EDP-12',
    summary: 'Fix login',
    status: 'In Progress',
    type: 'Story',
    priority: 'High',
    assignee: 'Office Bot',
    url: 'https://x.atlassian.net/browse/EDP-12',
    description: 'It breaks.',
    comments: [{ author: 'Nik', created: '2026-09-28T10:20:30.000+0000', body: 'On it' }],
    transitions: [
      { id: '41', name: 'Review', to: 'In Review' },
      { id: '31', name: 'Done', to: 'Done' },
    ],
  };
  assert.equal(
    formatTicket(view),
    [
      'EDP-12  Fix login',
      'Status: In Progress · Story · High · assigned to Office Bot',
      'https://x.atlassian.net/browse/EDP-12',
      '',
      'It breaks.',
      '',
      'Comments (1):',
      '',
      '— Nik, 2026-09-28 10:20',
      'On it',
      '',
      'Can move to: In Review, Done',
    ].join('\n'),
  );
  assert.match(formatTicket({ key: 'EDP-1', summary: 'x' }), /unassigned\n\n\(No description\.\)$/);
  assert.equal(formatTransitions(view), 'EDP-12 can move to:\n  In Review  (transition "Review")\n  Done');
  assert.equal(formatTransitions({ key: 'EDP-12', transitions: [] }), "EDP-12 can't move anywhere from its status.");
  assert.match(refusal(401, {}), /didn't accept this worker's token \(401\)/);
  assert.equal(refusal(403, {}), 'The office said no (403): this worker can only update the Jira ticket it was handed.');
  assert.equal(refusal(502, { error: 'Jira is down' }), 'The office said no (502): Jira is down.');
});

/** Runs main() against a fake fetch; returns what it printed and what it sent. */
async function run(argv: string[], opts: { env?: Record<string, string>; stdin?: string; status?: number; body?: unknown } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status ?? 200 });
  };
  const code = await main(argv, {
    env: opts.env ?? ENV,
    stdin: Readable.from(opts.stdin === undefined ? [] : [opts.stdin]),
    fetch,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  });
  return { code, sent, out: out.join('\n'), err: err.join('\n') };
}

test('each command prints what the office sent back', async () => {
  const help = await run([]);
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage:/);
  const view = await run(['view'], { body: { key: 'EDP-12', summary: 'Fix', status: 'To Do' } });
  assert.equal(view.code, 0);
  assert.match(view.out, /^EDP-12 {2}Fix\nStatus: To Do/);
  const moves = await run(['transitions'], { body: { key: 'EDP-12', transitions: [{ name: 'Done', to: 'Done' }] } });
  assert.equal(moves.out, 'EDP-12 can move to:\n  Done');
  const moved = await run(['transition', 'review'], { body: { ok: true, status: 'In Review' } });
  assert.equal(moved.out, 'Moved to In Review.');
  const commented = await run(['comment'], { stdin: 'PR is up\n' });
  assert.equal(commented.out, 'Commented.');
  assert.deepEqual(JSON.parse(String(commented.sent[0].init.body)), { action: 'comment', body: 'PR is up' });
});

test('clear errors when the environment is missing or the office says no', async () => {
  const noEnv = await run(['view'], { env: {} });
  assert.equal(noEnv.code, 1);
  assert.equal(noEnv.sent.length, 0);
  const other = await run(['view', '--key', 'EDP-13'], { status: 403, body: { error: 'Pixel can only update EDP-12, the ticket it was handed (not EDP-13)' } });
  assert.equal(other.code, 1);
  assert.equal(other.err, 'office-jira: The office said no (403): Pixel can only update EDP-12, the ticket it was handed (not EDP-13).');
  const empty = await run(['comment'], { stdin: '' });
  assert.equal(empty.code, 2);
  assert.equal(empty.sent.length, 0);
  assert.match(empty.err, /The comment is empty[\s\S]*Usage:/);
  const unreachable = await main(['view'], {
    env: ENV,
    fetch: (async () => {
      throw Object.assign(new Error('boom'), { code: 'EHOSTUNREACH' });
    }) as typeof fetch,
    out: () => {},
    err: (s: string) => assert.match(s, /Couldn't reach the office at http:\/\/127\.0\.0\.1:4455 \(EHOSTUNREACH\)/),
  });
  assert.equal(unreachable, 1);
});

test("runs as a command: a heredoc comment goes over HTTP with the worker's own token", async (t) => {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [SCRIPT, 'comment'], { env: { PATH: process.env.PATH ?? '', ...ENV, AGENT_OFFICE_HOOK_URL: url } }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
    child.stdin!.end("Don't expand $HOME or `this`.\n");
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Commented.\n');
  assert.deepEqual(seen[0], { method: 'POST', url: '/office/jira?worker=w1', auth: 'Bearer tok', body: JSON.stringify({ action: 'comment', body: "Don't expand $HOME or `this`." }) });
});
