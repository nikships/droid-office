import test from 'node:test';
import assert from 'node:assert/strict';
import { debounce, toolRefresh } from '../src/server/hook-refresh.js';

test('file edits and commands refresh the Changes window; switches the branch; pushes and pull request commands the boards', () => {
  for (const tool of ['Create', 'Edit', 'ApplyPatch', 'MultiEdit']) assert.deepEqual(toolRefresh(tool, { file_path: 'a.ts' }), { changes: true }, tool);
  for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'AskUser', 'Task', undefined]) assert.equal(toolRefresh(tool, {}), undefined, String(tool));
  const run = (command: string) => toolRefresh('Execute', { command, riskLevel: 'low' });
  assert.deepEqual(run('npm test'), { changes: true });
  assert.deepEqual(toolRefresh('Execute', {}), { changes: true });
  for (const command of ['git switch -c fix-login', 'git checkout main', 'git -C ../api checkout -b x', 'git branch -m new-name', 'git worktree add ../x', 'gh pr checkout 12', 'glab mr checkout 3'])
    assert.deepEqual(run(command), { changes: true, branch: true }, command);
  assert.deepEqual(run('git branch'), { changes: true }, 'listing branches moves nothing');
  for (const command of ['git push -u origin HEAD', 'git -c push.default=current push', 'git add . && git commit -m x && git push']) assert.deepEqual(run(command), { changes: true, board: true, pipelines: true }, command);
  for (const command of ['gh pr create --fill', 'gh pr close 4', 'gh pr ready', 'glab mr create', 'gh issue create -t x']) assert.deepEqual(run(command), { changes: true, board: true }, command);
  assert.deepEqual(run('gh pr merge 12 --squash'), { changes: true, board: true, pipelines: true }, 'a merge starts CI on its base');
  assert.deepEqual(run('glab mr merge 3'), { changes: true, board: true, pipelines: true });
  assert.deepEqual(run('echo "git pushed"'), { changes: true });
  assert.deepEqual(run('gh pr view 12'), { changes: true });
});

test('a burst of calls runs its function once, after the last', async () => {
  let n = 0;
  const soon = debounce(() => n++, 20);
  soon();
  soon();
  await new Promise((resolve) => setTimeout(resolve, 10));
  soon();
  assert.equal(n, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(n, 1);
  soon();
  soon.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(n, 1, 'cancelled');
});
