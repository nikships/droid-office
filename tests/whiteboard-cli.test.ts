import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, printable } from '../bin/office-whiteboard.js';

const env = { DROID_OFFICE_HOOK_URL: 'http://127.0.0.1:1', DROID_OFFICE_WORKER_ID: 'w1', DROID_OFFICE_HOOK_TOKEN: 'tok' };
const HELLO = { epoch: 'e1', rev: 4, cards: 1, worker: { id: 'w1', name: 'Pixel' }, floor: { name: 'Main' }, renderer: { available: true } };
const tty = { isTTY: true } as unknown as NodeJS.ReadStream;

/** A fake office: answers each action with `answer`, or throws what it returns when that is an Error. */
function office(answer: (body: { action: string }) => unknown) {
  const calls: { action: string }[] = [];
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { action: string };
    calls.push(body);
    const a = answer(body);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a), { status: 200 });
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

async function run(argv: string[], fetch: typeof globalThis.fetch, cwd = tmpdir()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { env, stdin: tty, fetch, out: (s: string) => out.push(s), err: (s: string) => err.push(s), sleep: async () => {}, cwd });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('printable drops escape sequences and control characters but keeps newlines and tabs', () => {
  assert.equal(printable('a\x1b[2Jb\x07c\r\n\td\x9b'), 'a[2Jbc\n\td');
  assert.equal(printable(42), '42');
});

test('what the board says is printed without its escape sequences; JSON is printed as it is', async () => {
  const hello = { ...HELLO, worker: { id: 'w1', name: 'Pi\x1b]0;owned\x07xel' } };
  const { fetch } = office(() => hello);
  const plain = await run(['whoami'], fetch);
  assert.equal(plain.code, 0);
  assert.ok(!plain.out.includes('\x1b'));
  assert.match(plain.out, /You're Pi\]0;ownedxel \(w1\)/);
  const json = await run(['whoami', '--json'], fetch);
  assert.equal(JSON.parse(json.out).worker.name, hello.worker.name);
});

test('a change the office went quiet on says it may have applied and to read before trying again', async () => {
  const { fetch } = office((b) => (b.action === 'hello' ? HELLO : new Error('socket hang up')));
  const r = await run(['push', '--title', 'Plan', '--canvas'], fetch);
  assert.equal(r.code, 1);
  assert.match(r.err, /Couldn't reach the office/);
  assert.match(r.err, /may have applied the change/);
  assert.match(r.err, /If it did, card c-\S+ exists already\./);
});

test('an unreachable office on a read says nothing about a change', async () => {
  const { fetch } = office(() => new Error('socket hang up'));
  const r = await run(['read'], fetch);
  assert.equal(r.code, 1);
  assert.match(r.err, /Couldn't reach the office/);
  assert.doesNotMatch(r.err, /may have applied/);
});

test('a PNG that cannot be written is reported on its card, which stays unread', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocked = path.join(root, 'file');
  writeFileSync(blocked, '');
  const png = { ok: true, tiles: [Buffer.from('png').toString('base64')], width: 1, height: 1, rev: 4, at: Date.now(), current: true };
  const { calls, fetch } = office((b) => (b.action === 'hello' ? HELLO : b.action === 'read' ? { rev: 4, cards: [{ id: 'c-1', png }], returned: ['c-1'] } : { rev: 5 }));
  const r = await run(['read', 'c-1', '--png', path.join(blocked, 'out'), '--json'], fetch);
  assert.equal(r.code, 0);
  const card = JSON.parse(r.out).cards[0];
  assert.equal(card.png.ok, false);
  assert.match(card.png.error, /Couldn't write its PNG/);
  assert.deepEqual(
    calls.map((c) => c.action),
    ['hello', 'read'],
    'no read point is moved for a card whose image is missing',
  );
});
