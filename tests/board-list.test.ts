import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardList, priorityRank, type BoardSource } from '../src/server/board-list.js';
import type { GhIssue, GhLabel, GhPull, GhState } from '../src/shared/protocol.js';

const label = (name: string, color = '#888888'): GhLabel => ({ name, color });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function issue(number: number, labels: GhLabel[] = [], state = 'OPEN'): GhIssue {
  return { number, title: `Issue ${number}`, state, url: '', author: '', labels, assignees: [], createdAt: '', updatedAt: '', body: '', comments: 0 };
}

function pull(number: number, labels: GhLabel[] = [], state = 'OPEN'): GhPull {
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    url: '',
    author: '',
    labels,
    reviewDecision: '',
    headRefName: `b${number}`,
    baseRefName: 'main',
    createdAt: '',
    updatedAt: '',
    additions: 0,
    deletions: 0,
    checks: 'none',
    body: '',
    closes: [],
  };
}

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

/** A forge that answers from what the test sets, and can hold a list open. */
function source() {
  const s = {
    issues: [] as GhIssue[],
    pulls: [] as GhPull[],
    labels: [] as GhLabel[],
    issueCalls: 0,
    pullCalls: 0,
    labelCalls: 0,
    issueError: '',
    pullError: '',
    labelError: '',
    applyError: '',
    /** Returned instead of `issues`, so a list can lag behind a label change. */
    staleIssues: undefined as GhIssue[] | undefined,
    holdIssues: undefined as ReturnType<typeof gate> | undefined,
    holdPulls: undefined as ReturnType<typeof gate> | undefined,
  };
  const copy = <T extends { labels: GhLabel[] }>(items: T[]) => items.map((it) => ({ ...it, labels: it.labels.map((l) => ({ ...l })) }));
  const src: BoardSource = {
    async listIssues() {
      s.issueCalls++;
      const held = s.holdIssues;
      const error = s.issueError;
      const items = copy(s.staleIssues ?? s.issues);
      if (held) await held.promise;
      if (error) throw new Error(error);
      return items;
    },
    async listPulls() {
      s.pullCalls++;
      const held = s.holdPulls;
      const error = s.pullError;
      const items = copy(s.pulls);
      if (held) await held.promise;
      if (error) throw new Error(error);
      return items;
    },
    async listLabels() {
      s.labelCalls++;
      if (s.labelError) throw new Error(s.labelError);
      return s.labels.map((l) => ({ ...l }));
    },
    async applyLabels(kind, n, add, remove) {
      if (s.applyError) throw new Error(s.applyError);
      const items = kind === 'issue' ? s.issues : s.pulls;
      const it = items.find((item) => item.number === n);
      const names = new Set(it?.labels.map((l) => l.name) ?? []);
      for (const name of add) names.add(name);
      for (const name of remove) names.delete(name);
      const now = [...names].map((name) => s.labels.find((l) => l.name === name) ?? { name, color: '#888888' });
      if (it) it.labels = now.map((l) => ({ ...l }));
      return now.map((l) => ({ ...l }));
    },
  };
  return { s, src };
}

function board(src: BoardSource) {
  const issues: GhState<GhIssue>[] = [];
  const pulls: GhState<GhPull>[] = [];
  const list = new BoardList(
    src,
    (state) => issues.push(state),
    (state) => pulls.push(state),
  );
  return { list, issues, pulls };
}

const numbers = (items: { number: number }[]) => items.map((it) => it.number);

test('priority labels rank from critical down to none', () => {
  assert.equal(priorityRank([]), 4);
  assert.equal(priorityRank([label('P0')]), 0);
  assert.equal(priorityRank([label('  p1  ')]), 1);
  assert.equal(priorityRank([label('P2')]), 2);
  assert.equal(priorityRank([label('P3')]), 3);
  assert.equal(priorityRank([label('priority p2')]), 2);
  assert.equal(priorityRank([label('priority: high')]), 1);
  assert.equal(priorityRank([label('priority/low')]), 3);
  assert.equal(priorityRank([label('priority: highest')]), 0);
  assert.equal(priorityRank([label('critical')]), 0);
  assert.equal(priorityRank([label('urgent')]), 0);
  assert.equal(priorityRank([label('blocker')]), 0);
  assert.equal(priorityRank([label('priority medium')]), 2);
  assert.equal(priorityRank([label('priority: med')]), 2);
  assert.equal(priorityRank([label('priority normal')]), 2);
  assert.equal(priorityRank([label('priority moderate')]), 2);
  assert.equal(priorityRank([label('priority minor')]), 3);
  assert.equal(priorityRank([label('high')]), 4, 'a bare high is not a priority label');
  assert.equal(priorityRank([label('priority: someday')]), 4);
  assert.equal(priorityRank([label('P0'), label('priority: low')]), 0, 'the most urgent label wins');
});

test('issues lead with the most urgent priority, and pulls stay in the order the host listed', async () => {
  const { s, src } = source();
  s.issues = [issue(1), issue(2, [label('P0')]), issue(3, [label('priority: low')]), issue(4, [label('P0')]), issue(5, [label('priority: high')])];
  s.pulls = [pull(1, [label('priority: low')]), pull(2, [label('P0')])];
  const { list } = board(src);
  await list.refresh();
  assert.deepEqual(numbers(list.issues.items), [2, 4, 5, 3, 1], 'P0, then high, then low, then none; equal ranks keep host order');
  assert.deepEqual(numbers(list.pulls.items), [1, 2], 'pulls are not sorted by priority');
  assert.equal(list.issues.loading, false);
  assert.equal(list.issues.error, undefined);
});

test('a label edit shows at once, outlasts a list asked for before it, and yields to one asked for after', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { s, src } = source();
  const low = [label('priority: low')];
  s.issues = [issue(5), issue(6, low)];
  s.labels = [label('bug', '#d73a4a'), label('P0', '#b60205'), ...low];
  const { list, issues } = board(src);
  await list.refresh();
  assert.deepEqual(numbers(list.issues.items), [6, 5]);

  const held = gate();
  s.holdIssues = held;
  const pending = list.refresh();
  await settle();
  assert.equal(list.issues.loading, true);
  const calls = s.issueCalls;

  t.mock.timers.tick(50);
  const saved = await list.setLabels('issue', 5, ['P0'], []);
  assert.deepEqual(saved.labels, [label('P0', '#b60205')]);
  assert.equal(s.issueCalls, calls, 'the edit does not start a second list while one is already going');
  assert.deepEqual(numbers(list.issues.items), [5, 6], 'the board re-sorts before the list comes back');
  assert.deepEqual(list.issues.items[0].labels, [label('P0', '#b60205')]);
  assert.ok(issues.at(-1) === list.issues, 'listeners see that list');

  s.staleIssues = [issue(5), issue(6, low)];
  held.release();
  await pending;
  assert.deepEqual(list.issues.items[0].labels, [label('P0', '#b60205')], 'a list asked for before the edit keeps the new labels');
  assert.deepEqual(numbers(list.issues.items), [5, 6]);

  t.mock.timers.tick(50);
  await list.refresh();
  assert.deepEqual(list.issues.items.find((i) => i.number === 5)?.labels, [], 'a list asked for after the edit is believed');
  assert.deepEqual(numbers(list.issues.items), [6, 5]);
  s.staleIssues = undefined;
  await list.refresh();
  assert.deepEqual(list.issues.items.find((i) => i.number === 5)?.labels, [label('P0', '#b60205')], 'and the edit is forgotten, so the host is what shows');
});

test('a pull label edit shows at once and does not reorder the list', async () => {
  const { s, src } = source();
  s.pulls = [pull(1, [label('priority: low')]), pull(2, [label('P0')])];
  s.labels = [label('bug', '#d73a4a'), label('priority: low'), label('P0')];
  const { list } = board(src);
  await list.refresh();
  const saved = await list.setLabels('pull', 1, ['bug'], ['priority: low']);
  assert.deepEqual(saved.labels, [label('bug', '#d73a4a')]);
  assert.deepEqual(numbers(list.pulls.items), [1, 2]);
  assert.deepEqual(list.pulls.items[0].labels, [label('bug', '#d73a4a')]);
  assert.deepEqual(list.pulls.items[1].labels, [label('P0')]);
});

test('a label edit that fails looks again and leaves the cards as they were', async () => {
  const { s, src } = source();
  s.issues = [issue(1, [label('bug')])];
  const { list } = board(src);
  await list.refresh();
  s.applyError = 'nope';
  const calls = s.issueCalls;
  const saved = await list.setLabels('issue', 1, ['P0'], []);
  assert.deepEqual(saved, { error: 'nope' });
  await settle();
  assert.equal(s.issueCalls, calls + 1);
  assert.deepEqual(list.issues.items[0].labels, [label('bug')]);
});

test('the repository label list is kept for a minute, and a failure is asked again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { s, src } = source();
  s.labels = [label('bug', '#d73a4a')];
  const { list } = board(src);
  assert.deepEqual(await list.repoLabels(), [label('bug', '#d73a4a')]);
  assert.deepEqual(await list.repoLabels(), [label('bug', '#d73a4a')]);
  assert.equal(s.labelCalls, 1);
  t.mock.timers.tick(60_000);
  await list.repoLabels();
  assert.equal(s.labelCalls, 1, 'a minute on the dot is still the same list');
  t.mock.timers.tick(1);
  await list.repoLabels();
  assert.equal(s.labelCalls, 2);

  t.mock.timers.tick(60_001);
  s.labelError = 'down';
  await assert.rejects(list.repoLabels(), /down/);
  s.labelError = '';
  await list.repoLabels();
  assert.equal(s.labelCalls, 4, 'a failed ask is not kept');
});

test('a close the list still shows as open is looked at again after 3 seconds, and a closed one is not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  const { s, src } = source();
  s.issues = [issue(7)];
  s.pulls = [pull(8)];
  const { list } = board(src);
  await list.refresh();

  list.closed('issue', 7);
  await settle();
  assert.equal(s.issueCalls, 2);
  t.mock.timers.tick(2_999);
  await settle();
  assert.equal(s.issueCalls, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(s.issueCalls, 3, 'still open, so it looks again');

  s.pulls = [pull(8, [], 'CLOSED')];
  const pulls = s.pullCalls;
  list.closed('pull', 8);
  await settle();
  assert.equal(s.pullCalls, pulls + 1);
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(s.pullCalls, pulls + 1, 'closed on the first look, so it does not look again');
});

test('a close during a list already going returns at once and looks again 3 seconds later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3_000_000 });
  const { s, src } = source();
  s.issues = [issue(9)];
  const { list } = board(src);
  await list.refresh();
  const held = gate();
  s.holdIssues = held;
  const pending = list.refresh();
  await settle();
  const calls = s.issueCalls;
  list.closed('issue', 9);
  await settle();
  assert.equal(s.issueCalls, calls, 'the look already going returns at once');
  assert.equal(list.issues.items[0].state, 'OPEN');
  s.issues = [issue(9, [], 'CLOSED')];
  held.release();
  await pending;
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(s.issueCalls, calls + 1, 'the later look is the one that can see it closed');
  assert.equal(list.issues.items[0].state, 'CLOSED');
});

test('a list that fails keeps the cards it had and says why', async () => {
  const { s, src } = source();
  s.issues = [issue(1, [label('bug')])];
  const { list, issues } = board(src);
  await list.refresh();
  s.issueError = "gh isn't logged in";
  await list.refresh();
  assert.equal(list.issues.loading, false);
  assert.equal(list.issues.error, "gh isn't logged in");
  assert.deepEqual(list.issues.items[0].labels, [label('bug')]);
  assert.equal(issues.at(-2)?.loading, true);
  assert.equal(issues.at(-1)?.error, "gh isn't logged in");
});

test('a second look at a list already going does not ask the host again', async () => {
  const { s, src } = source();
  const { list } = board(src);
  const held = gate();
  s.holdIssues = held;
  s.holdPulls = held;
  const first = list.refresh();
  await settle();
  const issues = s.issueCalls;
  const pulls = s.pullCalls;
  await list.refresh();
  assert.equal(s.issueCalls, issues);
  assert.equal(s.pullCalls, pulls);
  held.release();
  await first;
  assert.equal(list.issues.loading, false);
});

test('start looks now and again on its own clock, and stop ends that', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 4_000_000 });
  const { s, src } = source();
  s.issues = [issue(1)];
  const { list } = board(src);
  list.start();
  await settle();
  assert.equal(s.issueCalls, 1);
  t.mock.timers.tick(90_000);
  await settle();
  assert.equal(s.issueCalls, 2);
  list.stop();
  t.mock.timers.tick(90_000);
  await settle();
  assert.equal(s.issueCalls, 2);
});
