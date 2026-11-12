import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import Ajv from 'ajv';
import { Answers } from '../src/server/answers.js';
import { closedUnionAt, createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore, type CardRenders, type PinnedCard, type RenderImage, type RenderOutcome, type WhiteboardRenderer } from '../src/server/whiteboard.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';
import { OWNER, OWNER_AUTHOR, findCard, readPoint, type Op } from '../src/shared/whiteboard.js';
import type { ReadOut } from '../src/server/whiteboard-agent.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TOOL_NAMES = ['whiteboard_apply', 'whiteboard_card', 'whiteboard_guide', 'whiteboard_marks', 'whiteboard_read', 'whiteboard_state'];

class Renderer implements WhiteboardRenderer {
  available = true;
  failed = new Set<string>();
  throwing = false;
  images = new Map<string, RenderImage>();
  during?: () => void;
  gate?: Promise<void>;
  after?: () => void;
  status() {
    return this.available ? { available: true } : { available: false, reason: 'no browser' };
  }
  async render(pin: PinnedCard): Promise<RenderOutcome> {
    if (this.throwing) throw new Error('private renderer failure');
    this.during?.();
    await this.gate;
    if (this.failed.has(pin.card.id)) return { ok: false, error: 'the page crashed' };
    const image: RenderImage = { key: pin.key, rev: pin.rev, at: Date.now() - 5, width: 1280, height: 40, tileHeight: 20, tiles: [PNG, PNG], capped: { capPx: 40 } };
    this.images.set(pin.card.id, image);
    queueMicrotask(() => this.after?.());
    return { ok: true, image };
  }
  changed() {}
  latest(id: string): CardRenders {
    return { image: this.images.get(id) };
  }
  forget(id: string) {
    this.images.delete(id);
  }
  stop() {}
}

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-whiteboard-'));
  const cwd = path.join(dir, '.droid-office', 'worktrees', 'sub');
  mkdirSync(cwd, { recursive: true });
  const settings = { ...SUBAGENT_DEFAULTS };
  const worker = (id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
    id,
    name: id,
    kind: 'agent',
    deskId: 'desk-1',
    color: '#ff8800',
    status: 'idle',
    acked: true,
    createdBy: 'test',
    createdAt: 1,
    cols: 100,
    rows: 30,
    open: false,
    ...extra,
  });
  const people = [worker('lead'), worker('sub', { lead: 'lead', worktree: { path: path.relative(dir, cwd), branch: 'office/sub', base: 'abc' } })];
  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => people,
    get: (id) => people.find((person) => person.id === id),
    authenticate: (id, token) => (token === `token-${id}` ? people.find((person) => person.id === id) : undefined),
    officeDefault: undefined,
    deskOccupied: () => false,
    hire: () => 'not used',
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => '',
    setTask() {},
  };
  const team = new Team(workers, { dataDir: dir, dir, git: true, settings: () => settings, toast() {} });
  const visits = new Visits({ ...workers, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  const renderer = new Renderer();
  const store = new WhiteboardStore(dir, { renderer, readers: () => [OWNER, ...people.map((person) => person.id)] });
  store.start();
  const floor: OfficeMcpFloor = { id: 'floor', name: 'Main', dir, workers, team, visits, whiteboard: store };
  const mcp = createOfficeMcp({ answers: new Answers(), settings: () => settings, floor: (id) => (workers.get(id) ? floor : undefined) });
  let disconnected: (() => void) | undefined;
  const http = createServer((req, res) => {
    void mcp.handle(req, res);
    res.once('close', () => {
      if (!res.writableFinished) disconnected?.();
    });
  });
  const disconnect = () =>
    new Promise<void>((resolve) => {
      disconnected = resolve;
    });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    team.stop();
    visits.stop();
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const connect = async (id: string) => {
    const client = new Client({ name: 'whiteboard-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}${OFFICE_MCP_PATH}`), { requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer token-${id}` } } }),
    );
    return client;
  };
  const client = await connect('sub');
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent!;
  };
  const card = (title = 'Plan', source: Record<string, unknown> = { html: '<h1 data-wb-id="title">Plan</h1>' }) => ok('whiteboard_card', { action: 'create', title, source });
  const owner = (...ops: Op[]) => {
    const result = store.apply({ epoch: store.issueEpoch(), seq: 1, ops }, OWNER_AUTHOR, 'window');
    assert.equal(result.kind, 'ack', JSON.stringify(result));
  };
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}${OFFICE_MCP_PATH}`);
  return { dir, cwd, url, disconnect, client, connect, call, ok, card, owner, store, renderer };
}

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text?: string }[])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
const readOf = (value: unknown) => value as ReadOut;

test('both lead and subagent discover all six Whiteboard tools and their complete artifact guide', async (t) => {
  const r = await rig(t);
  const lead = await r.connect('lead');
  for (const client of [lead, r.client])
    assert.deepEqual(
      (await client.listTools()).tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('whiteboard_'))
        .sort(),
      TOOL_NAMES,
    );
  const instructions = r.client.getInstructions() ?? '';
  for (const detail of ['reviewable screenshots', 'name its title and id', 'Read feedback', 'window.whiteboard', 'data-wb-id', '1280', 'Never put secrets', 'state.fields', 'Linked cards', 'board.json', 'whiteboard_guide'])
    assert.ok(instructions.includes(detail), detail);
  for (const detail of ['data-wb-ping="', 'pinged.<name>', 'data-wb-ping-state']) assert.ok(instructions.includes(detail), detail);
});

test('reads move only returned read points, preserve full feedback, and sanitize text but not exact JSON', async (t) => {
  const r = await rig(t);
  const a = (await r.card()).card as string;
  const b = (await r.card()).card as string;
  r.owner(
    { op: 'card.title', card: a, title: 'Pi\x1b]0;owned\x07xel' },
    { op: 'state.set', card: a, path: ['fields', 'email'], value: 'owner@example.com' },
    { op: 'sticky.add', card: a, id: 'note', anchor: { kind: 'point', point: { x: 10, y: 20 } }, text: 'feedback\nsecond\x1b\x07 line' },
    { op: 'card.title', card: b, title: 'Other card' },
  );
  const before = r.store.board.rev;
  const result = await r.call('whiteboard_read', { cards: [a, a, 'unknown'] });
  assert.equal(result.isError, undefined);
  const out = readOf(result.structuredContent);
  assert.equal(out.rev, before);
  assert.deepEqual(out.returned, [a]);
  assert.deepEqual(out.unknown, ['unknown']);
  assert.equal(out.cards[0].changed, true);
  assert.equal(out.cards[0].title, 'Pi\x1b]0;owned\x07xel');
  assert.match(textOf(result), /CHANGED/);
  assert.match(textOf(result), /Pi\\u001b]0;owned\\u0007xel/);
  assert.ok(!textOf(result).includes('\x1b'));
  assert.match(textOf(result), /owner@example.com/);
  assert.match(textOf(result), /feedback\nsecond line/);
  assert.match(textOf(result), /HTML:[\s\S]*data-wb-id="title"/);
  assert.equal(readPoint(r.store.board, 'sub', a), before);
  assert.equal(readPoint(r.store.board, 'sub', b), 0);
  assert.equal(readPoint(r.store.board, 'lead', a), 0);
  const again = readOf(await r.ok('whiteboard_read', { json: true }));
  assert.equal(again.cards.find((card) => card.id === a)?.changed, false);
  assert.equal(again.cards.find((card) => card.id === b)?.changed, true);
  const json = await r.call('whiteboard_read', { cards: [a], json: true });
  assert.equal(JSON.parse(textOf(json)).cards[0].title, 'Pi\x1b]0;owned\x07xel');
  r.owner({ op: 'sticky.rm', card: a, id: 'note' }, { op: 'card.rm', card: b });
  const removed = readOf(await r.ok('whiteboard_read', {}));
  assert.equal(removed.cards[0].removed[0].id, 'note');
  assert.deepEqual(removed.returned, [a, b]);
  assert.equal(readPoint(r.store.board, 'sub', b), removed.rev);
});

test('PNG reads return labeled MCP images for snapshot tiles, no duplicated base64, and snapshot freshness', async (t) => {
  const r = await rig(t);
  const card = (await r.card()).card as string;
  r.owner({ op: 'state.set', card, path: ['choice'], value: 'a' });
  const snapshot = r.store.board.rev;
  r.renderer.during = () => r.owner({ op: 'state.set', card, path: ['choice'], value: 'b' });
  const result = await r.call('whiteboard_read', { cards: [card], png: true });
  const items = result.content as { type: string; data?: string; text?: string; mimeType?: string }[];
  const images = items.filter((item) => item.type === 'image');
  assert.equal(images.length, 2);
  assert.deepEqual(
    images.map((image) => image.mimeType),
    ['image/png', 'image/png'],
  );
  assert.ok(images.every((image) => Buffer.from(image.data!, 'base64').equals(PNG)));
  assert.match(textOf(result), /PNG tile 1\/2/);
  assert.match(textOf(result), /card changed since snapshot/);
  const out = result.structuredContent as { rev: number; cards: { state: { choice: string }; png: { current: boolean; tileCount: number; tiles?: unknown; capped: { capPx: number } } }[] };
  assert.equal(out.rev, snapshot);
  assert.equal(out.cards[0].state.choice, 'a');
  assert.equal(out.cards[0].png.current, false);
  assert.equal(out.cards[0].png.tileCount, 2);
  assert.equal(out.cards[0].png.tiles, undefined);
  assert.equal(out.cards[0].png.capped.capPx, 40);
  assert.equal(readPoint(r.store.board, 'sub', card), snapshot);
  assert.equal(readOf(await r.ok('whiteboard_read', { cards: [card] })).cards[0].changed, true);
});

test('PNG failures keep those cards unread, unavailable renders never return stale images, failed reads move nothing', async (t) => {
  const r = await rig(t);
  const a = (await r.card()).card as string;
  const b = (await r.card()).card as string;
  r.owner({ op: 'state.set', card: a, path: ['x'], value: 1 }, { op: 'state.set', card: b, path: ['x'], value: 1 });
  r.renderer.failed.add(a);
  const snapshot = r.store.board.rev;
  const mixed = await r.call('whiteboard_read', { png: true });
  assert.equal(readPoint(r.store.board, 'sub', a), 0);
  assert.equal(readPoint(r.store.board, 'sub', b), snapshot);
  assert.match(textOf(mixed), /page crashed.*wasn't moved/);
  r.owner({ op: 'state.set', card: b, path: ['x'], value: 2 });
  r.renderer.available = false;
  const none = await r.call('whiteboard_read', { cards: [b], png: true });
  assert.match(textOf(none), /Renders: unavailable \(no browser\)/);
  assert.match(textOf(none), /last image is of revision \d+, \d+s ago/);
  assert.equal((none.content as { type: string }[]).filter((item) => item.type === 'image').length, 0);
  assert.equal(readPoint(r.store.board, 'sub', b), snapshot);
  r.renderer.available = true;
  r.renderer.images.clear();
  r.renderer.throwing = true;
  const before = structuredClone(r.store.board.reads);
  const failure = await r.call('whiteboard_read', { png: true });
  assert.equal(failure.isError, true);
  assert.match(textOf(failure), /Read the current state/);
  assert.doesNotMatch(textOf(failure), /private renderer/);
  assert.deepEqual(r.store.board.reads, before);
});

test('a PNG read the worker disconnects from moves no read points', async (t) => {
  const r = await rig(t);
  const card = (await r.card()).card as string;
  r.owner({ op: 'state.set', card, path: ['x'], value: 1 });
  const before = structuredClone(r.store.board.reads);
  let started!: () => void;
  const rendering = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  r.renderer.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.renderer.during = started;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  r.renderer.after = finished;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whiteboard_read', arguments: { cards: [card], png: true } } });
  const req = request(r.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [OFFICE_MCP_WORKER_HEADER]: 'sub', Authorization: 'Bearer token-sub' } });
  req.on('error', () => undefined);
  req.end(body);
  await rendering;
  const gone = r.disconnect();
  req.destroy();
  await gone;
  release();
  await done;
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.store.board.reads, before, 'the read never reached the worker, so its feedback stays CHANGED');
  assert.equal(readOf(await r.ok('whiteboard_read', { cards: [card] })).cards[0].changed, true);
});
test('card sources load from the calling worktree, preserve assets and marks, and support canvas/image/link/show', async (t) => {
  const r = await rig(t);
  writeFileSync(path.join(r.cwd, 'plan.html'), '<link rel="stylesheet" href="style.css"><h1>Worktree</h1><img src="../outside.png">');
  writeFileSync(path.join(r.dir, 'plan.html'), '<h1>Wrong working folder</h1>');
  writeFileSync(path.join(r.cwd, 'style.css'), 'h1 { color: teal }');
  writeFileSync(path.join(r.cwd, 'shot.png'), PNG);
  const created = await r.call('whiteboard_card', { action: 'create', title: 'Plan', source: { file: 'plan.html' } });
  const card = created.structuredContent!.card as string;
  const stored = findCard(r.store.board, card)!;
  assert.match(r.store.readBlob(stored.content!.files['plan.html'].hash)!.toString(), /Worktree/);
  assert.ok(stored.content!.files['style.css']);
  assert.match(textOf(created), /Not collected: \.\.\/outside.png/);
  const sticky = await r.ok('whiteboard_marks', { card, kind: 'sticky', op: 'add', text: 'Keep this' });
  await r.ok('whiteboard_card', { action: 'update', card, title: 'Renamed', source: { html: '<p>New content</p>' } });
  assert.equal(findCard(r.store.board, card)!.stickies[0].id, sticky.id);
  assert.equal(findCard(r.store.board, card)!.title, 'Renamed');
  const canvas = await r.card('Canvas', { canvas: true });
  assert.equal(findCard(r.store.board, canvas.card as string)!.kind, 'canvas');
  const image = await r.card('Screenshot', { image: 'shot.png' });
  assert.ok(Object.values(findCard(r.store.board, image.card as string)!.content!.files).some((file) => file.mime === 'image/png'));
  const live = (await r.card('Live', { link: 'plan.html' })).card as string;
  assert.equal(findCard(r.store.board, live)!.link?.path, path.join(r.cwd, 'plan.html'));
  const refused = await r.call('whiteboard_card', { action: 'update', card: live, source: { file: 'plan.html' } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /unlink the card first/);
  await r.ok('whiteboard_card', { action: 'unlink', card: live });
  await r.ok('whiteboard_card', { action: 'update', card: live, source: { file: 'plan.html' } });
  await r.ok('whiteboard_card', { action: 'link', card: live, source: { link: 'plan.html' } });
  assert.equal(findCard(r.store.board, live)!.link?.status, 'ok');
  await r.ok('whiteboard_card', { action: 'show', card });
  assert.deepEqual(r.store.board.selection, { kind: 'card', id: card });
  await r.ok('whiteboard_card', { action: 'show', grid: true });
  assert.deepEqual(r.store.board.selection, { kind: 'grid' });
  assert.equal((await r.call('whiteboard_card', { action: 'show', card, grid: true })).isError, true);
  await r.ok('whiteboard_card', { action: 'remove', card: live });
  assert.equal(findCard(r.store.board, live), undefined);
});

test('Droid validation with Ajv removeAdditional keeps every source and anchor shape intact', async (t) => {
  const r = await rig(t);
  const listed = new Map((await r.client.listTools()).tools.map((tool) => [tool.name, tool.inputSchema]));
  // Droid checks Script tool calls against the listed schema with these options before sending them.
  const ajv = new Ajv({ removeAdditional: true, allErrors: true, useDefaults: true });
  // The keywords involved behave the same in draft-07 and 2020-12; drop $schema so default Ajv compiles it.
  const compile = (name: string) => ajv.compile({ ...listed.get(name)!, $schema: undefined });
  const card = compile('whiteboard_card');
  const marks = compile('whiteboard_marks');
  const site = { dir: '/repo/.droid-office/artifacts/setup', entry: 'index.html' };
  const calls: [typeof card, Record<string, unknown>][] = [
    [card, { action: 'update', card: 'atlas-mcp-setup', title: 'Setup', source: site }],
    [card, { action: 'update', card: 'atlas-mcp-setup', source: { file: '/repo/index.html' } }],
    ...[{ html: '<p>x</p>' }, { image: 'shot.png' }, { canvas: true }, { link: 'site', entry: 'page.html' }, { dir: 'site' }].map((source): [typeof card, Record<string, unknown>] => [card, { action: 'create', title: 'T', source }]),
    ...[{ on: 'title', offset: { x: 1, y: 2 } }, { selector: 'h1', quote: 'Plan', at: { x: 1, y: 2 } }, { at: { x: 3, y: 4 } }].map((anchor): [typeof card, Record<string, unknown>] => [
      marks,
      { card: 'c', kind: 'comment', op: 'add', text: 'Hi', anchor },
    ]),
  ];
  for (const [validate, args] of calls) {
    const sent = structuredClone(args);
    assert.ok(validate(sent), `${JSON.stringify(args)}: ${ajv.errorsText(validate.errors)}`);
    assert.deepEqual(sent, args, 'validation must not strip any key');
  }
  for (const [name, schema] of listed) assert.equal(closedUnionAt(schema), undefined, name);
  assert.equal(closedUnionAt({ properties: { source: { anyOf: [{ type: 'object', additionalProperties: false }] } } }), '/properties/source/anyOf');

  writeFileSync(path.join(r.cwd, 'v1.html'), '<p>First</p>');
  mkdirSync(path.join(r.cwd, 'site'));
  writeFileSync(path.join(r.cwd, 'site', 'index.html'), '<p>Revised</p>');
  const id = (await r.card('Setup', { file: 'v1.html' })).card as string;
  await r.ok('whiteboard_card', { action: 'update', card: id, title: 'Setup, revised', source: { dir: 'site', entry: 'index.html' } });
  const stored = findCard(r.store.board, id)!;
  assert.equal(stored.title, 'Setup, revised');
  assert.match(r.store.readBlob(stored.content!.files['index.html'].hash)!.toString(), /Revised/);
});

test('source and anchor mistakes get errors that say how to fix them and change nothing', async (t) => {
  const r = await rig(t);
  const card = (await r.card()).card as string;
  const before = r.store.board.rev;
  const refusal = async (name: string, args: Record<string, unknown>, expected: RegExp) => {
    const result = await r.call(name, args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), expected);
  };
  await refusal('whiteboard_card', { action: 'update', card, source: {} }, /source needs one of html, markdown, markdownFile, file, dir, video, image, link or canvas, for example/);
  await refusal('whiteboard_card', { action: 'update', card, source: { file: 'a.html', dir: 'site' } }, /exactly one of .*not file and dir/);
  await refusal('whiteboard_card', { action: 'update', card, source: { file: 'a.html', entry: 'index.html' } }, /entry goes with dir or link, not file/);
  await refusal('whiteboard_card', { action: 'update', card, source: { link: 'a.html' } }, /Use the link action/);
  await refusal('whiteboard_card', { action: 'link', card, source: { dir: 'site' } }, /Link needs source/);
  await refusal('whiteboard_card', { action: 'create', title: 'X', source: { canvas: true, html: '<p>x</p>' } }, /not html and canvas/);
  await refusal('whiteboard_card', { action: 'update', card, source: { dirr: 'site' } }, /Unrecognized key/);
  const mark = { card, kind: 'comment', op: 'add', text: 'Hi' };
  await refusal('whiteboard_marks', { ...mark, anchor: { on: 'title', selector: 'h1' } }, /on or selector, not both/);
  await refusal('whiteboard_marks', { ...mark, anchor: {} }, /anchor needs on/);
  await refusal('whiteboard_marks', { ...mark, anchor: { at: { x: 1, y: 2 }, offset: { x: 1, y: 1 } } }, /offset goes with on or selector/);
  await refusal('whiteboard_marks', { ...mark, anchor: { on: 'title', quote: 'Plan' } }, /quote goes with selector/);
  assert.equal(r.store.board.rev, before);
});

test('directory and batch file loads preserve CLI containment and resolve paths without changing the server cwd', async (t) => {
  const r = await rig(t);
  const site = path.join(r.cwd, 'site');
  mkdirSync(site);
  writeFileSync(path.join(site, 'index.html'), '<p>Index</p>');
  writeFileSync(path.join(site, 'page.html'), '<p>Page</p>');
  writeFileSync(path.join(site, 'data.json'), '{"answer":42}');
  writeFileSync(path.join(site, '.secret'), 'not collected');
  const bundled = await r.card('Site', { dir: 'site', entry: 'page.html' });
  const content = findCard(r.store.board, bundled.card as string)!.content!;
  assert.equal(content.entry, 'page.html');
  assert.deepEqual(Object.keys(content.files).sort(), ['data.json', 'index.html', 'page.html']);
  const before = r.store.board.rev;
  const escapedEntry = await r.call('whiteboard_card', { action: 'create', title: 'No', source: { dir: 'site', entry: '../plan.html' } });
  assert.equal(escapedEntry.isError, true);
  assert.match(textOf(escapedEntry), /inside the folder/);
  assert.equal(r.store.board.rev, before);
  writeFileSync(path.join(r.cwd, 'outside.png'), PNG);
  symlinkSync(path.join(r.cwd, 'outside.png'), path.join(site, 'escaped.png'));
  const symlink = await r.call('whiteboard_card', { action: 'create', title: 'No symlinks', source: { dir: 'site' } });
  assert.equal(symlink.isError, true);
  assert.match(textOf(symlink), /outside the folder/);
  writeFileSync(path.join(site, 'page.html'), '<img src="escaped.png">');
  const page = (await r.card('One page', { file: 'site/page.html' })).card as string;
  assert.match(findCard(r.store.board, page)!.content!.missing![0].reason, /outside the folder/);
  await r.ok('whiteboard_apply', {
    ops: [
      { op: 'card.create', card: 'batch', kind: 'html', title: 'Batch', content: { load: { file: 'site/index.html' } } },
      { op: 'picture.add', card: 'batch', id: 'pic', anchor: { kind: 'point', point: { x: 0, y: 0 } }, file: { load: 'outside.png' } },
    ],
  });
  assert.equal(findCard(r.store.board, 'batch')!.content!.entry, 'index.html');
  assert.equal(findCard(r.store.board, 'batch')!.pictures[0].file.mime, 'image/png');
  await r.ok('whiteboard_apply', { ops: [{ op: 'card.linkTo', card: 'batch', path: 'site/index.html' }] });
  assert.equal(findCard(r.store.board, 'batch')!.link?.path, path.join(site, 'index.html'));
  // Absolute and parent-relative source paths were allowed by the CLI; only collected assets and entries are contained.
  const parent = path.join(r.cwd, '..', 'parent.html');
  writeFileSync(parent, '<p>Parent</p>');
  await r.card('Parent path', { file: '../parent.html' });
  await r.card('Absolute path', { file: parent });
  const invalid = await r.call('whiteboard_apply', {
    ops: [
      { op: 'card.title', card: page, title: 'Should roll back' },
      { op: 'card.content', card: page, content: { load: { file: 'missing.html' } } },
    ],
  });
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /Operation 1 \(card.content\)/);
  assert.equal(findCard(r.store.board, page)!.title, 'One page');
  assert.equal(readFileSync(parent, 'utf8'), '<p>Parent</p>');
});

test('state reads do not hide feedback; set, merge and del keep dotted path semantics and reject invalid roots', async (t) => {
  const r = await rig(t);
  const card = (await r.card()).card as string;
  r.owner({ op: 'state.set', card, path: ['fields', 'email'], value: 'owner@example.com' });
  const get = await r.ok('whiteboard_state', { card, op: 'get', path: 'fields.email' });
  assert.equal(get.value, 'owner@example.com');
  assert.equal(readPoint(r.store.board, 'sub', card), 0);
  await r.ok('whiteboard_state', { card, op: 'set', value: { fields: { name: 'Ada' }, list: [1, 2] } });
  await r.ok('whiteboard_state', { card, op: 'merge', value: { fields: { email: 'new@example.com' }, list: [3] } });
  await r.ok('whiteboard_state', { card, op: 'set', path: 'fields.choice', value: null });
  assert.deepEqual((await r.ok('whiteboard_state', { card, op: 'get' })).value, { fields: { name: 'Ada', email: 'new@example.com', choice: null }, list: [3] });
  await r.ok('whiteboard_state', { card, op: 'merge', path: 'fields', value: { name: 'Grace' } });
  await r.ok('whiteboard_state', { card, op: 'del', path: 'fields.choice' });
  for (const args of [{ op: 'set', value: 1 }, { op: 'merge', value: [] }, { op: 'set' }, { op: 'get', path: 'fields.choice' }, { op: 'get', card: 'missing' }])
    assert.equal((await r.call('whiteboard_state', { card, ...args })).isError, true);
});

test('marks cover comment, sticky and picture edits, replies, reattachment, movement and removal', async (t) => {
  const r = await rig(t);
  const card = (await r.card()).card as string;
  writeFileSync(path.join(r.cwd, 'shot.png'), PNG);
  const mark = (kind: string, op: string, args: Record<string, unknown> = {}) => r.ok('whiteboard_marks', { card, kind, op, ...args });
  const comment = await mark('comment', 'add', { text: 'Why?', anchor: { on: 'title', offset: { x: 1, y: 2 } } });
  const thread = comment.id as string;
  assert.match(comment.message as string, /^m-/);
  await mark('comment', 'reply', { id: thread, text: 'Because.' });
  await mark('comment', 'edit', { id: thread, message: comment.message, text: 'Why this?' });
  await mark('comment', 'resolve', { id: thread });
  assert.equal(findCard(r.store.board, card)!.threads[0].resolved, true);
  await mark('comment', 'reopen', { id: thread });
  await mark('comment', 'reattach', { id: thread, anchor: { selector: 'h1', quote: 'Plan', at: { x: 10, y: 15 } } });
  assert.equal(findCard(r.store.board, card)!.threads[0].anchor.kind, 'element');
  await mark('comment', 'remove', { id: thread, message: comment.message });
  assert.equal(findCard(r.store.board, card)!.threads[0].messages.length, 1);
  const sticky = (await mark('sticky', 'add', { text: 'Note', color: 'pink', anchor: { at: { x: 4, y: 5 } }, box: { w: 200, h: 160 } })).id;
  await mark('sticky', 'edit', { id: sticky, text: 'Edited', color: 'blue' });
  await mark('sticky', 'move', { id: sticky, box: { x: 20, y: 30, w: 220 } });
  await mark('sticky', 'reattach', { id: sticky, anchor: { on: 'title' } });
  assert.equal(findCard(r.store.board, card)!.stickies[0].text, 'Edited');
  assert.equal(findCard(r.store.board, card)!.stickies[0].box.w, 220);
  const picture = (await mark('picture', 'add', { file: 'shot.png', anchor: { at: { x: 0, y: 0 } }, box: { w: 40, h: 40 } })).id;
  await mark('picture', 'file', { id: picture, file: 'shot.png' });
  await mark('picture', 'move', { id: picture, anchor: { at: { x: 80, y: 90 } }, box: { h: 50 } });
  await mark('picture', 'reattach', { id: picture, anchor: { selector: 'h1' } });
  assert.equal(findCard(r.store.board, card)!.pictures[0].box.y, 90);
  assert.equal(findCard(r.store.board, card)!.pictures[0].box.h, 50);
  const out = readOf(await r.ok('whiteboard_read', { cards: [card] }));
  assert.ok(readFileSync(out.cards[0].pictures[0].file.file).equals(PNG));
  await mark('comment', 'remove', { id: thread });
  await mark('sticky', 'remove', { id: sticky });
  await mark('picture', 'remove', { id: picture });
  assert.deepEqual([findCard(r.store.board, card)!.threads.length, findCard(r.store.board, card)!.stickies.length, findCard(r.store.board, card)!.pictures.length], [0, 0, 0]);
  for (const args of [
    { kind: 'picture', op: 'add' },
    { kind: 'sticky', op: 'resolve', id: 'x' },
    { kind: 'comment', op: 'edit', id: thread, text: 'x' },
    { kind: 'comment', op: 'add', text: '' },
    { kind: 'sticky', op: 'move', id: 'x' },
    { kind: 'picture', op: 'reattach', id: 'x' },
    { kind: 'sticky', op: 'remove' },
  ])
    assert.equal((await r.call('whiteboard_marks', { card, ...args })).isError, true);
});

test('invalid atomic batches and uncertain commit failures report what to do without hiding changes', async (t) => {
  const r = await rig(t);
  const card = (await r.card()).card as string;
  const before = r.store.board.rev;
  const invalid = await r.call('whiteboard_apply', {
    ops: [
      { op: 'card.title', card, title: 'Not committed' },
      { op: 'sticky.rm', card, id: 'missing' },
    ],
  });
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /Operation 1 \(sticky.rm\).*Nothing was changed/);
  assert.equal(r.store.board.rev, before);
  assert.equal(findCard(r.store.board, card)!.title, 'Plan');
  const apply = r.store.apply.bind(r.store);
  r.store.apply = (...args) => {
    apply(...args);
    throw new Error('private failure after commit');
  };
  const uncertain = await r.call('whiteboard_card', { action: 'update', card, title: 'Committed' });
  assert.equal(uncertain.isError, true);
  assert.match(textOf(uncertain), /Read the current state before retrying/);
  assert.doesNotMatch(textOf(uncertain), /Nothing was changed|private failure/);
  assert.equal(findCard(r.store.board, card)!.title, 'Committed');
});

test('whiteboard_guide serves Factory design system topics and safely exports official SVG logos inside the worktree', async (t) => {
  const r = await rig(t);
  const full = await r.call('whiteboard_guide', {});
  assert.equal(full.isError, undefined);
  assert.match(textOf(full), /Factory Design Guide/);
  assert.match(textOf(full), /#EE6018/);
  assert.match(textOf(full), /FACTORY_ARTIFACT_CSS/);

  const exported = await r.call('whiteboard_guide', { topic: 'brand', exportLogosTo: 'assets/brand' });
  assert.equal(exported.isError, undefined);
  const glyph = readFileSync(path.join(r.cwd, 'assets', 'brand', 'rotor-white.svg'), 'utf8');
  assert.match(glyph, /^<svg/);

  for (const bad of ['../escaped', '/tmp/escaped', '.git/logos', '.droid-office/logos']) {
    const res = await r.call('whiteboard_guide', { topic: 'brand', exportLogosTo: bad });
    assert.equal(res.isError, true, bad);
  }
  const outside = mkdtempSync(path.join(tmpdir(), 'wb-guide-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(r.cwd, 'linked-out'));
  const symRes = await r.call('whiteboard_guide', { topic: 'brand', exportLogosTo: 'linked-out/brand' });
  assert.equal(symRes.isError, true);
});

test('markdown, markdownFile, video, SVG image, live .md links, show:true, onlyChanged and peek work end to end', async (t) => {
  const r = await rig(t);

  // 1. Inline Markdown card with inferred title, action buttons and show: true
  const mdCreated = await r.ok('whiteboard_card', {
    action: 'create',
    show: true,
    source: {
      markdown: '# Launch Readiness\n\n- [x] Lint & typecheck\n- [ ] Smoke test\n',
      actions: [{ action: 'ship', label: 'Ship release', ping: 'Approved Launch Readiness — ship it.', primary: true }],
    },
  });
  const mdId = mdCreated.card as string;
  assert.equal(r.store.board.selection.kind, 'card');
  if (r.store.board.selection.kind === 'card') assert.equal(r.store.board.selection.id, mdId);
  const mdCard = findCard(r.store.board, mdId)!;
  assert.equal(mdCard.title, 'Launch Readiness');
  assert.equal(mdCard.content?.format, 'markdown');
  assert.ok(mdCard.content?.files['document.md']);

  // 2. Markdown file card collecting relative local images
  const docsDir = path.join(r.cwd, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, 'arch.png'), PNG);
  writeFileSync(path.join(docsDir, 'rfc.md'), '# Storage Engine\n\n![Architecture](./arch.png)\n');
  const fileMd = await r.ok('whiteboard_card', {
    action: 'create',
    source: { markdownFile: 'docs/rfc.md' },
  });
  const fileMdCard = findCard(r.store.board, fileMd.card as string)!;
  assert.equal(fileMdCard.title, 'Storage Engine');
  assert.ok(fileMdCard.content?.files['arch.png']);
  assert.ok(fileMdCard.content?.files['document.md']);

  // 3. Video card with auto-detected sibling poster + caption
  writeFileSync(path.join(r.cwd, 'demo-take.mp4'), Buffer.from('00000018667479706d703432', 'hex'));
  writeFileSync(path.join(r.cwd, 'demo-take.poster.png'), PNG);
  const vid = await r.ok('whiteboard_card', {
    action: 'create',
    source: { video: 'demo-take.mp4', caption: 'Full flow at 60 fps' },
  });
  const vidCard = findCard(r.store.board, vid.card as string)!;
  assert.equal(vidCard.title, 'demo-take');
  assert.equal(vidCard.content?.format, 'video');
  assert.ok(vidCard.content?.files['video.mp4']);
  assert.ok(vidCard.content?.files['poster.png']);

  // 4. SVG image card with caption
  writeFileSync(path.join(r.cwd, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
  const svgOut = await r.ok('whiteboard_card', {
    action: 'create',
    title: 'Topology SVG',
    source: { image: 'diagram.svg', caption: 'Zero-trust boundary' },
  });
  const svgCard = findCard(r.store.board, svgOut.card as string)!;
  assert.equal(svgCard.content?.format, 'image');
  assert.ok(svgCard.content?.files['image.svg']);

  // 5. Read named Markdown card: returns inline Markdown source and format
  const namedRead = await r.call('whiteboard_read', { cards: [mdId] });
  assert.match(textOf(namedRead), /html:markdown/);
  assert.match(textOf(namedRead), /Markdown:\n\s+\| # Launch Readiness/);
  assert.equal(readOf(namedRead.structuredContent).cards[0].format, 'markdown');
  assert.match(readOf(namedRead.structuredContent).cards[0].content?.markdown ?? '', /# Launch Readiness/);

  // 5b. Live-linked .md file updates automatically when edited on disk
  writeFileSync(path.join(docsDir, 'live.md'), '# Draft v1\n\nInitial copy.\n');
  const linkedMd = await r.ok('whiteboard_card', {
    action: 'create',
    title: 'Live Spec',
    source: { link: 'docs/live.md' },
  });
  const linkedMdId = linkedMd.card as string;
  writeFileSync(path.join(docsDir, 'live.md'), '# Draft v2\n\nUpdated live copy.\n');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const cur = findCard(r.store.board, linkedMdId)?.content;
    const rawMd = cur?.files['document.md'] ? r.store.readBlob(cur.files['document.md'].hash)?.toString() : '';
    if (rawMd?.includes('Draft v2')) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const finalMd = r.store.readBlob(findCard(r.store.board, linkedMdId)!.content!.files['document.md'].hash)!.toString();
  assert.match(finalMd, /Draft v2/);

  // Mark whole board read for sub, then have owner comment on vidCard only.
  await r.ok('whiteboard_read', {});
  const vidId = vid.card as string;
  r.owner({
    op: 'comment.add',
    card: vidId,
    thread: 't-vid',
    message: 'm-vid',
    anchor: { kind: 'point', point: { x: 120, y: 80 } },
    text: 'Trim pause @00:14',
  });
  const revAfterComment = r.store.board.rev;

  // 6. peek: true + onlyChanged: true sees only vidId AND leaves its read point untouched!
  const peeked = await r.call('whiteboard_read', { onlyChanged: true, peek: true });
  const peekOut = readOf(peeked.structuredContent);
  assert.deepEqual(peekOut.returned, [vidId]);
  assert.equal(peekOut.totalCards, 5);
  assert.match(textOf(peeked), /peek — read points unchanged/);
  assert.ok(readPoint(r.store.board, 'sub', vidId) < revAfterComment, 'peek leaves read point unchanged');

  // 7. Non-peek onlyChanged: true advances read point for vidId only, then next onlyChanged is empty.
  const consumed = readOf(await r.ok('whiteboard_read', { onlyChanged: true }));
  assert.deepEqual(consumed.returned, [vidId]);
  assert.equal(readPoint(r.store.board, 'sub', vidId), revAfterComment);
  const noneLeft = await r.call('whiteboard_read', { onlyChanged: true });
  assert.deepEqual(readOf(noneLeft.structuredContent).returned, []);
  assert.match(textOf(noneLeft), /No cards changed for you since your last read/);
});
