import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkerInfo, WorktreeState } from '../src/shared/protocol.js';
import { cleanupAllowed, describeWorktree, hireMsg, rebuildMsg, sendHomeMsg, sendHomeText, workerActions } from '../src/mobile/actions.js';
import { ago, childSummary, duration, modelLabel, statusLabel } from '../src/mobile/format.js';
import { emptyOffice, expireToasts, reduceOffice, withToast } from '../src/mobile/office-state.js';
import { FeedPool } from '../src/mobile/thread-feed.js';
import { decodeEntities, parseMarkdown, safeHref } from '../src/mobile/markdown.js';
import { emptyOffice as office0, toolContext } from '../src/mobile/office-state.js';
import { TOOLS, toolAvailability } from '../src/shared/companion-tools.js';

function worker(id: string, over: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, kind: 'agent', deskId: `d-${id}`, name: id, color: '#fff', status: 'idle', acked: true, createdBy: 'owner', createdAt: 1, cols: 80, rows: 24, open: false, sessionId: `s-${id}`, ...over };
}
const ids = (w: WorkerInfo, up = true) => workerActions(w, up).map((a) => a.id);
const refusal = (w: WorkerInfo, id: string, up = true) => workerActions(w, up).find((a) => a.id === id)?.refusal;

test('each kind of worker offers only what the office lets it do', () => {
  assert.deepEqual(ids(worker('g', { guest: { pid: 1, tty: 't', provider: 'claude', cwd: '/x', startedAt: 0, seen: 'process', cantBringIn: 'Not a droid session' } })), ['bring-in']);
  assert.equal(refusal(worker('g', { guest: { pid: 1, tty: 't', provider: 'droid', cwd: '/x', startedAt: 0, seen: 'transcript', cantBringIn: 'Mid-turn' } }), 'bring-in'), 'Mid-turn');
  const cloud = ids(worker('c', { kind: 'cloud', cloud: { computerName: 'box' } as never }));
  assert.deepEqual(cloud, ['cloud', 'send-home'], 'a cloud worker: its cloud window and send home, no terminal, thread or fork');
  const shell = ids(worker('s', { kind: 'shell', status: 'exited' }));
  assert.ok(shell.includes('terminal') && shell.includes('resume') && !shell.includes('thread') && !shell.includes('fork'));
  const agent = ids(worker('a', { status: 'working', worktree: { path: 'p', branch: 'b', base: 'x' } }));
  assert.ok(agent.includes('thread') && agent.includes('terminal') && agent.includes('stop') && agent.includes('pr') && agent.includes('fork') && agent.includes('changes'));
  assert.equal(refusal(worker('a', { status: 'working', worktree: { path: 'p', branch: 'b', base: 'x' } }), 'pr'), 'It is mid-turn: wait until it is done');
  assert.equal(refusal(worker('a', { status: 'working' }), 'fork'), 'Wait until its turn ends before forking');
  assert.equal(refusal(worker('a', { status: 'idle' }), 'resume'), 'It is awake');
  const lost = worker('l', { status: 'offline', lost: { branch: 'origin' }, worktree: { path: 'p', branch: 'b', base: 'x' } });
  assert.equal(refusal(lost, 'rebuild'), undefined);
  assert.equal(refusal(lost, 'pr'), 'Its worktree is missing: rebuild it first');
  assert.equal(refusal(worker('a'), 'send-home', false), 'Disconnected. Nothing can be sent.');
  assert.equal(refusal(worker('a'), 'changes', true), undefined);
  assert.match(workerActions(worker('a'), true, true).find((a) => a.id === 'changes')?.refusal ?? '', /plain folder/);
  assert.equal(workerActions(worker('a'), true).find((a) => a.id === 'send-home')?.confirm, true);
  assert.ok(ids(worker('d', { deskId: 'station-actions' })).includes('station-ask'), 'a board agent is asked at its kiosk');
});

test('rebuild is this worker only, send home keeps cloud sessions and never cascades', () => {
  assert.deepEqual(rebuildMsg(worker('l')), { t: 'worker.rebuild', workerId: 'l' });
  assert.deepEqual(sendHomeMsg(worker('c', { kind: 'cloud', cloud: {} as never }), 'all'), { t: 'worker.kill', workerId: 'c', cleanup: 'keep', deleteSession: false });
  assert.deepEqual(sendHomeMsg(worker('a', { worktree: { path: 'p', branch: 'b', base: 'x' } }), 'worktree'), { t: 'worker.kill', workerId: 'a', cleanup: 'worktree', deleteSession: false });
  assert.match(sendHomeText(worker('lead'), 'floor a', 2), /2 subagents stay on the floor/);
  assert.ok(!/subagent/.test(sendHomeText(worker('solo'), 'floor a', 0)));
  assert.match(sendHomeText(worker('k', { kind: 'cloud' }), 'floor a', 0), /Factory session/, 'a kind:cloud worker without the cloud field is still cloud');
});

test('deleting a worktree waits for the office to say what it holds', () => {
  const clean: WorktreeState = { exists: true, dirty: 0, ahead: 0, unpushed: 0 };
  const risky: WorktreeState = { exists: true, dirty: 2, ahead: 3, unpushed: 1 };
  assert.equal(describeWorktree(clean, 'b').risky, false);
  const r = describeWorktree(risky, 'b');
  assert.equal(r.risky, true);
  assert.match(r.lines.join('\n'), /2 uncommitted changes/);
  assert.match(r.lines.join('\n'), /1 commit on b that no remote has/);
  const failed = describeWorktree({ ...clean, error: 'branch gone' }, 'b');
  assert.equal(failed.checked, false);
  assert.equal(cleanupAllowed('all', undefined), false);
  assert.equal(cleanupAllowed('all', failed), false);
  assert.equal(cleanupAllowed('keep', undefined), true);
  assert.equal(cleanupAllowed('worktree', describeWorktree(clean, 'b')), true);
  const across = describeWorktree(
    {
      ...clean,
      repos: [
        { name: 'api', state: clean },
        { name: 'web', state: { ...clean, error: 'x' } },
      ],
    },
    'b',
  );
  assert.equal(across.checked, false);
});

test('a hire takes the first free seat and drops engine fields for a shell', () => {
  assert.deepEqual(hireMsg({ kind: 'shell', prompt: ' ls ', worktree: false, model: 'm', effort: 'high', images: ['i'] }), { t: 'worker.spawn', deskId: 'auto', kind: 'shell', prompt: 'ls', worktree: false });
  assert.deepEqual(hireMsg({ kind: 'agent', prompt: '', worktree: true, model: 'm', effort: 'high', images: [] }), { t: 'worker.spawn', deskId: 'auto', kind: 'agent', worktree: true, model: 'm', effort: 'high' });
});

test('office state follows the floor the server put this connection on', () => {
  let s = emptyOffice();
  s = reduceOffice(s, { t: 'floor.enter', arrival: { floor: 'b', via: 'requested' }, floor: 'b', project: null, workers: [worker('x')], pulls: { items: [], fetchedAt: 0, loading: false } } as never);
  assert.equal(s.floor, 'b');
  assert.equal(s.arrival, 1);
  s = reduceOffice(s, { t: 'worker.worktree', workerId: 'x', state: { exists: true, dirty: 0, ahead: 0, unpushed: 0 } });
  s = reduceOffice(s, { t: 'worker.remove', workerId: 'x' });
  assert.deepEqual(s.workers, {});
  assert.deepEqual(s.worktrees, {});
  s = withToast(s, 'hi', 'info', 1000);
  assert.equal(expireToasts(s, 2000).toasts.length, 1);
  assert.equal(expireToasts(s, 8000).toasts.length, 0);
});

test('labels and durations come only from what the office sent', () => {
  assert.equal(statusLabel('offline'), 'asleep');
  assert.equal(statusLabel('needs_input'), 'needs input');
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(3 * 3600_000 + 5 * 60_000), '3h 05m');
  assert.equal(ago(undefined, 1000), undefined);
  assert.equal(ago(500_000, 400_000), undefined, 'a time from the future is not shown');
  assert.equal(modelLabel(worker('a', { model: 'claude', activeModel: 'opus', activeEffort: 'high' })), 'opus · high');
  assert.equal(modelLabel(worker('s', { kind: 'shell', model: 'x' })), undefined);
  assert.equal(childSummary({ working: 2, needs_input: 1 }), '1 needs input · 2 working');
  assert.equal(childSummary({ exited: 1, offline: 2 }), '3 asleep', 'one count per word');
});

test('panes plus a team rollup stay within the office’s conversation reader', () => {
  const pool = new FeedPool();
  const lead = { id: 'lead', kind: 'agent', sessionId: 's-lead' } as WorkerInfo;
  const kids = Array.from({ length: 8 }, (_, n) => ({ id: `k${n}`, kind: 'agent', lead: 'lead', sessionId: `s-k${n}` }) as WorkerInfo);
  const others = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `p${k}`, kind: 'agent', sessionId: `s-p${k}` }) as WorkerInfo);
  pool.sync([lead], 'lead', [lead, ...kids], 'x');
  assert.equal(pool.teamLimit, 6, 'one pane: the full team of six');
  assert.equal(pool.team.members.size, 6);
  pool.sync([lead, ...others(3)], 'lead', [lead, ...kids], 'x');
  assert.equal(pool.teamLimit, 3, 'four panes keep three children, not none: 4 + 3 + 1 for paging = 8');
  assert.equal(pool.teamOn, true);
  assert.equal(pool.team.members.size, 3);
});

test('Markdown becomes native blocks: headings, emphasis, links, lists, code, quotes and tables', () => {
  const blocks = parseMarkdown(
    '# Title *it*\n\nSome **bold _both_** ~~gone~~ `x` [site](https://example.com) [bad](javascript:alert(1))\n\n- [x] done\n- plain\n  1. inner\n\n> quoted\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|:-|-:|\n| 1 | **2** |\n\n---',
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'paragraph', 'list', 'quote', 'code', 'table', 'rule'],
  );
  const heading = blocks[0] as Extract<(typeof blocks)[number], { kind: 'heading' }>;
  assert.equal(heading.depth, 1);
  assert.deepEqual(heading.spans, [{ text: 'Title ' }, { text: 'it', italic: true }]);
  const para = blocks[1] as Extract<(typeof blocks)[number], { kind: 'paragraph' }>;
  assert.ok(para.spans.some((x) => x.text === 'both' && x.bold && x.italic));
  assert.ok(para.spans.some((x) => x.text === 'gone' && x.strike));
  assert.ok(para.spans.some((x) => x.text === 'x' && x.code));
  assert.equal(para.spans.find((x) => x.text === 'site')?.href, 'https://example.com');
  assert.equal(para.spans.find((x) => x.text.includes('bad'))?.href, undefined, 'a javascript: link is only text');
  const list = blocks[2] as Extract<(typeof blocks)[number], { kind: 'list' }>;
  assert.equal(list.items[0].checked, true);
  assert.equal(list.items[1].checked, undefined);
  assert.equal(list.items[1].blocks.at(-1)?.kind, 'list', 'a nested list stays nested');
  const code = blocks[4] as Extract<(typeof blocks)[number], { kind: 'code' }>;
  assert.deepEqual(code, { kind: 'code', lang: 'ts', text: 'const a = 1;' });
  const table = blocks[5] as Extract<(typeof blocks)[number], { kind: 'table' }>;
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.rows[0][1], [{ text: '2', bold: true }]);
});

test('Markdown never renders HTML, loads pictures or opens unsafe links', () => {
  const [p] = parseMarkdown('<img src=x onerror=alert(1)> a &amp; b ![shot](https://x.test/a.png) ![local](file:///etc/passwd)');
  assert.equal(p.kind, 'paragraph');
  const spans = (p as Extract<typeof p, { kind: 'paragraph' }>).spans;
  assert.ok(spans[0].text.startsWith('<img src=x onerror=alert(1)>'), 'raw HTML is literal text');
  assert.ok(spans.some((x) => x.text.includes('a & b')));
  assert.equal(spans.find((x) => x.text === '[shot]')?.href, 'https://x.test/a.png', 'a picture is a link, never loaded');
  assert.equal(spans.find((x) => x.text === '[local]')?.href, undefined);
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeHref(' JAVASCRIPT:alert(1)'), undefined);
  assert.equal(safeHref('intent://x'), undefined);
  assert.equal(decodeEntities('&#x1F600; &#55296; &bogus;'), '😀 &#55296; &bogus;');
  assert.deepEqual(parseMarkdown('   '), []);
  const deep = parseMarkdown(`${'> '.repeat(200)}bottom`);
  assert.ok(JSON.stringify(deep).includes('bottom'), 'deep nesting is flattened, not dropped or overflowed');
});

test('management tools come from the shared catalogue, judged on what the office said', () => {
  let s = reduceOffice(office0(), { t: 'floor.enter', floor: 'a', project: null, workers: [worker('w'), worker('c', { kind: 'cloud', cloud: {} as never })], pulls: { items: [], fetchedAt: 0, loading: false }, jira: {} } as never);
  s = { ...s, floors: [{ id: 'a', name: 'A', plain: true } as never] };
  assert.equal(toolAvailability('jira', toolContext(s, true)).available, false);
  assert.match((toolAvailability('pulls', toolContext(s, true)) as { reason: string }).reason, /plain folder/);
  assert.equal(toolAvailability('docs', toolContext(s, true)).available, true);
  assert.equal(toolAvailability('docs', toolContext(s, false)).available, false, 'nothing opens before the office is ready');
  s = reduceOffice(s, { t: 'factory', state: { connection: { connected: true } } } as never);
  assert.equal(toolAvailability('wiki', toolContext(s, true)).available, true);
  assert.equal(toolAvailability('cloud', toolContext(s, true, { workerId: 'c' }), { workerId: 'c' }).available, true);
  assert.equal(toolAvailability('cloud', toolContext(s, true, { workerId: 'w' }), { workerId: 'w' }).available, false);
  assert.equal(toolAvailability('cloud', toolContext(s, true, { workerId: '__proto__' }), { workerId: '__proto__' }).available, false);
  assert.ok(TOOLS.some((t) => t.id === 'hire' && t.listed));
});
