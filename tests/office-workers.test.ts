import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { UsageError, ago, buildBody, buildRequest, formatEvents, formatMember, formatTeam, formatWho, main, needsText, parseArgs, refusal } from '../bin/office-workers.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-workers.js');
const ENV = { DROID_OFFICE_HOOK_URL: 'http://127.0.0.1:4455/', DROID_OFFICE_WORKER_ID: 'w1 &x', DROID_OFFICE_HOOK_TOKEN: 'tok' };

test('parses every command, its aliases and its options', () => {
  assert.deepEqual(parseArgs(['hire', '--title', 'Fix login', '--model=glm-5.3', '--effort', 'high', '--no-worktree']), {
    cmd: 'hire',
    names: [],
    opts: { '--title': 'Fix login', '--model': 'glm-5.3', '--effort': 'high', '--no-worktree': true },
  });
  assert.deepEqual(parseArgs(['wait', 'Pixel', 'Byte', '--all', '--timeout', '600']), { cmd: 'wait', names: ['Pixel', 'Byte'], opts: { '--all': true, '--timeout': 600 } });
  assert.deepEqual(parseArgs(['tail', 'Pixel', '--lines=20']), { cmd: 'read', names: ['Pixel'], opts: { '--lines': 20 } });
  assert.equal(parseArgs(['ls']).cmd, 'list');
  assert.equal(parseArgs(['who']).cmd, 'whoami');
  assert.equal(parseArgs(['fire', 'Pixel']).cmd, 'dismiss');
  assert.equal(parseArgs(['ask', 'Pixel']).cmd, 'send');
  assert.deepEqual(parseArgs(['report', '--question']), { cmd: 'report', names: [], opts: { '--question': true } });
  assert.deepEqual(parseArgs([]), { cmd: 'help', full: true });
  assert.deepEqual(parseArgs(['help']), { cmd: 'help', full: true });
  assert.deepEqual(parseArgs(['hire', '--help']), { cmd: 'help', full: false });
});

test('says what is wrong with a bad command line', () => {
  const bad = (argv: string[], msg: RegExp) =>
    assert.throws(
      () => parseArgs(argv),
      (e: Error) => e instanceof UsageError && msg.test(e.message),
    );
  bad(['spawn'], /Unknown command: spawn/);
  bad(['hire', '--color', 'red'], /Unknown option for hire: --color/);
  bad(['hire', 'Fix', 'login'], /Unexpected argument: Fix \(quote the title, and give the brief on stdin\)/);
  bad(['hire', '--title'], /--title needs a value/);
  bad(['hire', '--worktree', '--no-worktree'], /Pick --worktree or --no-worktree/);
  bad(['hire', '--no-worktree=yes'], /takes no value/);
  bad(['hire', '--provider', 'droid'], /Unknown option for hire: --provider/);
  bad(['hire', '--effort', 'huge'], /--effort is one of low, medium, high, xhigh, max/);
  bad(['read'], /read takes the subagent's name, e\.g\. office-workers read Pixel/);
  bad(['send', 'Pixel', 'Byte'], /send takes one subagent's name \(got Pixel Byte\)/);
  bad(['wait', '--timeout', '0'], /--timeout takes a whole number from 1 to 1800 \(got 0\)/);
  bad(['wait', '--timeout', '3601'], /from 1 to 1800/);
  bad(['read', 'Pixel', '--lines', '1.5'], /--lines takes a whole number from 1 to 400/);
});

test('builds the /office/workers requests, with the text from stdin', () => {
  const body = (argv: string[], text?: string) => buildBody(parseArgs(argv), text);
  assert.deepEqual(body(['whoami']), { action: 'whoami' });
  assert.deepEqual(body(['list']), { action: 'list' });
  assert.deepEqual(body(['hire', '--title', ' Fix login ', '--model', ' opus ', '--effort', 'max', '--worktree'], '  Fix the redirect.\r\nTest it.\n'), {
    action: 'hire',
    task: 'Fix the redirect.\nTest it.',
    title: 'Fix login',
    model: 'opus',
    effort: 'max',
    worktree: true,
  });
  assert.deepEqual(body(['hire', '--no-worktree', '--task', 'Look around']), { action: 'hire', task: 'Look around', worktree: false });
  assert.deepEqual(body(['wait']), { action: 'events' });
  assert.deepEqual(body(['wait', 'Pixel']), { action: 'events', workers: ['Pixel'] });
  assert.deepEqual(body(['read', 'Pixel', '--lines', '30']), { action: 'read', worker: 'Pixel', lines: 30 });
  assert.deepEqual(body(['send', 'Pixel'], 'Yes, use the v2 API'), { action: 'send', worker: 'Pixel', text: 'Yes, use the v2 API' });
  assert.deepEqual(body(['dismiss', 'Pixel']), { action: 'dismiss', worker: 'Pixel' });
  assert.deepEqual(body(['report'], 'Done: PR #4'), { action: 'report', text: 'Done: PR #4' });
  assert.deepEqual(body(['report', '--question', '--message', 'Which API?']), { action: 'report', text: 'Which API?', question: true });
  assert.throws(() => body(['hire'], '  '), /needs a brief/);
  assert.throws(() => body(['send', 'Pixel'], ''), /Give the message on stdin/);
  assert.throws(() => body(['report', '--question'], ''), /Give the question on stdin/);

  assert.equal(needsText(parseArgs(['hire'])), true);
  assert.equal(needsText(parseArgs(['hire', '--task', 'x'])), false);
  assert.equal(needsText(parseArgs(['send', 'Pixel'])), true);
  assert.equal(needsText(parseArgs(['report', '--message', 'x'])), false);
  assert.equal(needsText(parseArgs(['list'])), false);

  assert.deepEqual(buildRequest({ action: 'list' }, { url: 'http://127.0.0.1:4455', worker: 'w1 &x', token: 'tok' }), {
    method: 'POST',
    url: 'http://127.0.0.1:4455/office/workers?worker=w1+%26x',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: '{"action":"list"}',
  });
});

const PIXEL = {
  id: 'w2',
  name: 'Pixel',
  status: 'done',
  desk: 'Desk 3',
  model: 'glm-5.3',
  effort: 'high',
  worktree: { path: '/proj/.droid-office/worktrees/w2', branch: 'office/w2' },
  task: 'Fix login',
  settled: true,
  report: { text: 'Fixed it.\nPR #4', question: false, at: 0 },
};

test('prints who you are, your team and its news readably', () => {
  assert.equal(ago(0, 30_000), '30s ago');
  assert.equal(ago(0, 180_000), '3m ago');
  assert.equal(ago(0, 7_200_000), '2h ago');
  assert.equal(
    formatWho({ you: { name: 'Nibble', desk: 'Desk 1', role: 'worker' }, canHire: true, max: 4, worktree: true, wakeLead: true }),
    ["You're Nibble at Desk 1, with no subagents yet (at most 4 at once).", 'You can hire. New subagents get their own git worktree.', 'The office wakes you when your team has news, so you can end your turn while they work.'].join('\n'),
  );
  assert.equal(
    formatWho({ you: { name: 'Pixel', desk: 'Desk 3', role: 'subagent' }, lead: { id: 'w1', name: 'Nibble' }, canHire: false, why: "You're a subagent of Nibble" }),
    ["You're Pixel at Desk 3, a subagent of Nibble.", "You can't hire: You're a subagent of Nibble.", "When you're done, report to Nibble with office-workers report."].join('\n'),
  );
  assert.match(
    formatWho({ you: { name: 'Team lead', desk: 'Team kiosk', role: 'lead' }, subagents: 2, max: 4, canHire: true, worktree: false, wakeLead: false }),
    /a lead with 2 of at most 4 subagents[\s\S]*main checkout[\s\S]*check with office-workers wait/,
  );

  assert.equal(
    formatMember(PIXEL, 60_000),
    ['Pixel (w2) · done · Desk 3 · glm-5.3 high', '  task: Fix login', '  worktree: /proj/.droid-office/worktrees/w2 on office/w2', '  last report (1m ago):', '    Fixed it.', '    PR #4'].join('\n'),
  );
  assert.equal(
    formatMember({ id: 'w3', name: 'Byte', status: 'working', desk: 'Desk 2', settled: false, activity: 'Running tests', pr: { number: 7, url: 'https://x/7' } }),
    ['Byte (w3) · working … · Desk 2', '  doing: Running tests', '  in the main checkout', '  pull request #7: https://x/7'].join('\n'),
  );
  assert.equal(formatTeam({ team: [], canHire: true }), 'You have no subagents. Hire one with office-workers hire.');
  assert.equal(formatTeam({ team: [], canHire: false }), 'You have no subagents.');
  assert.match(formatTeam({ team: [PIXEL], max: 4 }, 60_000), /^1 subagent \(at most 4\):\n\nPixel \(w2\)/);

  assert.equal(
    formatEvents([
      { kind: 'question', name: 'Pixel', text: 'v1 or v2?' },
      { kind: 'done', name: 'Byte', text: 'Fix the tests' },
      { kind: 'needs_input', name: 'Dot', text: 'Allow edit?' },
      { kind: 'stopped', name: 'Echo', text: 'exit code 1' },
      { kind: 'left', name: 'Fizz' },
    ]),
    [
      '❓ Pixel asked:\n    v1 or v2?',
      '✅ Byte finished its turn without reporting: Fix the tests. Read its terminal with office-workers read Byte.',
      '✋ Dot is waiting on an answer in its own terminal (Allow edit?): someone has to answer it there.',
      '⛔ Echo stopped (exit code 1).',
      '👋 Fizz left the floor.',
    ].join('\n\n'),
  );
  assert.match(refusal(401, { error: 'Send your own id' }), /didn't accept this agent's token \(401\): Send your own id/);
  assert.equal(refusal(403, { error: 'Subagents are turned off' }), 'The office said no (403): Subagents are turned off.');
  assert.equal(refusal(500, {}), 'The office said no (500).');
});

/** Runs main() against a fake office; `replies` answers each request in turn (the last one repeats). */
async function run(argv: string[], opts: { env?: Record<string, string>; stdin?: string; tty?: boolean; replies?: { status?: number; body: unknown }[] } = {}) {
  const sent: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const replies = opts.replies ?? [{ body: {} }];
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
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
  return { code, sent, urls, out: out.join('\n'), err: err.join('\n') };
}

test('hire sends the brief from stdin and says where the subagent sat down', async () => {
  const r = await run(['hire', '--title', 'Fix login'], { stdin: 'Fix the redirect.\n', replies: [{ body: { worker: PIXEL } }] });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.sent, [{ action: 'hire', task: 'Fix the redirect.', title: 'Fix login' }]);
  assert.equal(r.urls[0], 'http://127.0.0.1:4455/office/workers?worker=w1+%26x');
  assert.equal(
    r.out,
    ['Hired Pixel (w2) at Desk 3, in its own worktree /proj/.droid-office/worktrees/w2 on office/w2.', "It's on it. Wait for its report with office-workers wait, or see its terminal with office-workers read Pixel."].join('\n'),
  );
});

test('the other commands print what the office sent back', async () => {
  const list = await run(['list'], { replies: [{ body: { you: { name: 'Nibble', desk: 'Desk 1', role: 'lead' }, subagents: 1, max: 4, canHire: true, worktree: true, wakeLead: true, team: [PIXEL] } }] });
  assert.match(list.out, /^You're Nibble at Desk 1, a lead with 1 of at most 4 subagents\.[\s\S]*\n\n1 subagent \(at most 4\):\n\nPixel \(w2\)/);
  assert.equal((await run(['read', 'Pixel'], { replies: [{ body: { worker: { name: 'Pixel' }, text: '$ npm test\nok' } }] })).out, '$ npm test\nok');
  assert.equal((await run(['read', 'Pixel'], { replies: [{ body: { worker: { name: 'Pixel' }, text: '' } }] })).out, "(Pixel's terminal is empty)");
  assert.equal((await run(['send', 'Pixel'], { stdin: 'Use v2', replies: [{ body: { worker: { name: 'Pixel' } } }] })).out, 'Sent to Pixel.');
  assert.equal((await run(['dismiss', 'Pixel'], { replies: [{ body: { name: 'Pixel', note: 'Kept its worktree' } }] })).out, 'Sent Pixel home. Kept its worktree.');
  assert.equal((await run(['report'], { stdin: 'Done', replies: [{ body: { lead: 'Nibble' } }] })).out, 'Reported to Nibble. End your turn now: Nibble answers with your next message.');
  assert.match((await run(['report', '--question'], { stdin: 'Which?', replies: [{ body: { lead: 'Nibble' } }] })).out, /^Asked Nibble\./);
  const help = await run(['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /HOW TO RUN A TEAM/);
  assert.match((await run(['hire', '-h'])).out, /^Usage:/);
});

test('wait returns at the first news, or once the team is at rest with --all, or when time is up', async () => {
  const busy = { ...PIXEL, status: 'working', settled: false, report: undefined };
  const first = await run(['wait'], {
    replies: [{ body: { events: [], team: [busy] } }, { body: { events: [{ kind: 'report', name: 'Pixel', text: 'Fixed it' }], team: [PIXEL] } }],
  });
  assert.equal(first.code, 0);
  assert.equal(first.sent.length, 2, 'it polls until there is news');
  assert.deepEqual(first.sent[0], { action: 'events' });
  assert.equal(first.out, '📨 Pixel reported:\n    Fixed it\n\nAt rest: Pixel (done, Desk 3).');

  const byte = { ...busy, id: 'w3', name: 'Byte', desk: 'Desk 2' };
  const all = await run(['wait', '--all'], {
    replies: [
      { body: { events: [{ kind: 'report', name: 'Pixel', text: 'Fixed it' }], team: [PIXEL, byte] } },
      { body: { events: [], team: [PIXEL, byte] } },
      { body: { events: [{ kind: 'done', name: 'Byte' }], team: [PIXEL, { ...byte, status: 'done', settled: true }] } },
    ],
  });
  assert.equal(all.sent.length, 3, '--all keeps going until everyone is at rest');
  assert.match(all.out, /📨 Pixel reported[\s\S]*✅ Byte finished its turn[\s\S]*At rest: Pixel \(done, Desk 3\), Byte \(done, Desk 2\)\.$/);

  const named = await run(['wait', 'pixel', '--all'], { replies: [{ body: { events: [], team: [PIXEL, byte] } }] });
  assert.equal(named.sent.length, 1, 'only the named subagents count');
  assert.deepEqual(named.sent[0], { action: 'events', workers: ['pixel'] });

  const timeout = await run(['wait', '--timeout', '5'], { replies: [{ body: { events: [], team: [busy] } }] });
  assert.equal(timeout.code, 0);
  assert.equal(timeout.sent.length, 4, 'polls every 2s for 5s: at 0, 2, 4 and 5');
  assert.equal(timeout.out, 'Nothing after 5s. Run office-workers wait again to keep waiting.\n\nStill working: Pixel (working, Desk 3).');

  const nobody = await run(['wait'], { replies: [{ body: { events: [], team: [] } }] });
  assert.equal(nobody.out, 'You have no subagents to wait for.');
});

test('clear errors when the environment is missing, stdin is a terminal, or the office says no', async () => {
  const noEnv = await run(['list'], { env: {} });
  assert.equal(noEnv.code, 1);
  assert.equal(noEnv.sent.length, 0);
  assert.match(noEnv.err, /^office-workers: DROID_OFFICE_HOOK_URL, DROID_OFFICE_WORKER_ID, DROID_OFFICE_HOOK_TOKEN aren't set\. office-workers only works inside Droid Office/);
  assert.match((await run(['list'], { env: { DROID_OFFICE_HOOK_URL: 'x', DROID_OFFICE_WORKER_ID: 'w1' } })).err, /DROID_OFFICE_HOOK_TOKEN isn't set/);

  const tty = await run(['hire', '--title', 'T'], { tty: true });
  assert.equal(tty.code, 2);
  assert.equal(tty.sent.length, 0);
  assert.match(tty.err, /hire needs its text on stdin[\s\S]*Usage:/);

  const off = await run(['hire', '--title', 'T'], { stdin: 'x', replies: [{ status: 403, body: { error: 'Subagents are turned off in this office' } }] });
  assert.equal(off.code, 1);
  assert.equal(off.err, 'office-workers: The office said no (403): Subagents are turned off in this office.');

  const usage = await run(['hire', 'oops']);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /Unexpected argument: oops[\s\S]*Usage:/);
});

test('runs as a command: a heredoc brief goes over HTTP with the agent’s own token', async (t) => {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const ok = req.headers.authorization === 'Bearer tok';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { worker: { ...PIXEL, worktree: undefined } } : { error: 'Send your own DROID_OFFICE_WORKER_ID' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cli = (env: Record<string, string>, input: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [SCRIPT, 'hire', '--title', 'Fix login', '--no-worktree'], { env: { PATH: process.env.PATH ?? '', ...env } }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
      );
      child.stdin?.end(input);
    });

  const ok = await cli({ ...ENV, DROID_OFFICE_HOOK_URL: url, DROID_OFFICE_WORKER_ID: 'w1' }, "Don't expand $HOME or `this`.\n");
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Hired Pixel \(w2\) at Desk 3, in the main checkout\.\n/);
  assert.deepEqual(seen[0], {
    method: 'POST',
    url: '/office/workers?worker=w1',
    auth: 'Bearer tok',
    body: JSON.stringify({ action: 'hire', task: "Don't expand $HOME or `this`.", title: 'Fix login', worktree: false }),
  });

  const stale = await cli({ ...ENV, DROID_OFFICE_HOOK_URL: url, DROID_OFFICE_HOOK_TOKEN: 'old' }, 'x');
  assert.equal(stale.code, 1);
  assert.equal(stale.stdout, '');
  assert.match(stale.stderr, /didn't accept this agent's token \(401\)/);
});
