import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkerInfo, WorktreeState } from '../src/shared/protocol.js';
import { cleanupAllowed, describeWorktree, hireMsg, rebuildMsg, sendHomeMsg, sendHomeText, workerActions } from '../src/mobile/actions.js';
import { ago, childSummary, duration, modelLabel, statusLabel } from '../src/mobile/format.js';
import { emptyOffice, expireToasts, reduceOffice, withToast } from '../src/mobile/office-state.js';
import { teamAllowed, THREAD_SESSIONS } from '../src/mobile/thread-feed.js';
import { MANAGEMENT_TOOLS, toolsFor } from '../src/mobile/tools.js';

function worker(id: string, over: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, kind: 'agent', deskId: `d-${id}`, name: id, color: '#fff', status: 'idle', acked: true, createdBy: 'owner', createdAt: 1, cols: 80, rows: 24, open: false, sessionId: `s-${id}`, ...over };
}
const ids = (w: WorkerInfo, up = true) => workerActions(w, up).map((a) => a.id);
const refusal = (w: WorkerInfo, id: string, up = true) => workerActions(w, up).find((a) => a.id === id)?.refusal;

test('each kind of worker offers only what the office lets it do', () => {
  assert.deepEqual(ids(worker('g', { guest: { pid: 1, tty: 't', provider: 'claude', cwd: '/x', startedAt: 0, seen: 'process', cantBringIn: 'Not a droid session' } })), ['bringIn']);
  assert.equal(refusal(worker('g', { guest: { pid: 1, tty: 't', provider: 'droid', cwd: '/x', startedAt: 0, seen: 'transcript', cantBringIn: 'Mid-turn' } }), 'bringIn'), 'Mid-turn');
  const cloud = ids(worker('c', { kind: 'cloud', cloud: { computerName: 'box' } as never }));
  assert.ok(!cloud.includes('terminal') && !cloud.includes('thread') && !cloud.includes('fork') && cloud.includes('sendHome'));
  const shell = ids(worker('s', { kind: 'shell', status: 'exited' }));
  assert.ok(shell.includes('terminal') && shell.includes('resume') && !shell.includes('thread') && !shell.includes('fork'));
  assert.equal(workerActions(worker('s', { kind: 'shell', status: 'exited' }), true).find((a) => a.id === 'resume')?.label, 'Restart');
  const agent = ids(worker('a', { status: 'working', worktree: { path: 'p', branch: 'b', base: 'x' } }));
  assert.ok(agent.includes('thread') && agent.includes('terminal') && agent.includes('stop') && agent.includes('pr') && agent.includes('fork'));
  assert.equal(refusal(worker('a', { status: 'working', worktree: { path: 'p', branch: 'b', base: 'x' } }), 'pr'), 'Wait until its turn ends.');
  assert.equal(refusal(worker('a', { status: 'working' }), 'fork'), 'Wait until its turn ends before forking');
  assert.ok(!ids(worker('a', { pr: { number: 3, url: 'https://x' }, worktree: { path: 'p', branch: 'b', base: 'x' } })).includes('pr'));
  const lost = worker('l', { status: 'offline', lost: { branch: 'origin' }, worktree: { path: 'p', branch: 'b', base: 'x' } });
  assert.ok(ids(lost).includes('rebuild'));
  assert.equal(refusal(lost, 'resume'), 'Rebuild its worktree first.');
  assert.equal(refusal(worker('a'), 'sendHome', false), 'Disconnected. Nothing can be sent.');
});

test('rebuild is this worker only, send home keeps cloud sessions and never cascades', () => {
  assert.deepEqual(rebuildMsg(worker('l')), { t: 'worker.rebuild', workerId: 'l' });
  assert.deepEqual(sendHomeMsg(worker('c', { kind: 'cloud', cloud: {} as never }), 'all'), { t: 'worker.kill', workerId: 'c', cleanup: 'keep', deleteSession: false });
  assert.deepEqual(sendHomeMsg(worker('a', { worktree: { path: 'p', branch: 'b', base: 'x' } }), 'worktree'), { t: 'worker.kill', workerId: 'a', cleanup: 'worktree', deleteSession: false });
  assert.match(sendHomeText(worker('lead'), 'floor a', 2), /2 subagents stay on the floor/);
  assert.ok(!/subagent/.test(sendHomeText(worker('solo'), 'floor a', 0)));
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
});

test('panes plus a team rollup stay within the office’s conversation reader', () => {
  assert.equal(teamAllowed(2), true);
  assert.equal(teamAllowed(3), false);
  assert.equal(THREAD_SESSIONS, 8);
});

test('management tools needing a checkout of their own leave a plain floor', () => {
  assert.ok(toolsFor(true).length < MANAGEMENT_TOOLS.length);
  assert.ok(!toolsFor(true).some((t) => t.id === 'pulls'));
  assert.ok(toolsFor(true).some((t) => t.id === 'docs'));
});
