import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutoHeal, HEAL_TRIES, HealWatch, seedAutoHeal } from '../src/server/auto-heal.js';
import { officePrompt } from '../src/server/prompts.js';
import { healPromptVars } from '../src/shared/prompts.js';
import type { PipelineRun } from '../src/shared/pipelines.js';

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 101,
    number: 7,
    workflow: 'CI',
    title: 'feat: a thing',
    state: 'failure',
    status: 'completed',
    event: 'push',
    branch: 'main',
    sha: 'abcdef1234567890',
    url: 'https://github.com/o/r/actions/runs/101',
    createdAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:05:00Z',
    path: '.github/workflows/ci.yml',
    ...over,
  };
}

test('auto-heal is off until someone turns it on, and stays as it was set', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-heal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen: boolean[] = [];
  const a = new AutoHeal(dir, (s) => seen.push(s.on));
  assert.equal(a.on, false);
  a.set(true, 'Ada');
  assert.deepEqual(seen, [true]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'auto-heal.json'), 'utf8')).on, true);
  const again = new AutoHeal(dir, () => {});
  assert.equal(again.on, true);
  assert.equal(again.state().by, 'Ada');
});

test('each floor keeps its own auto-heal, and one with none yet starts from the office file', (t) => {
  const office = mkdtempSync(path.join(tmpdir(), 'droid-office-heal-office-'));
  const aDir = mkdtempSync(path.join(tmpdir(), 'droid-office-heal-a-'));
  const bDir = mkdtempSync(path.join(tmpdir(), 'droid-office-heal-b-'));
  const cDir = mkdtempSync(path.join(tmpdir(), 'droid-office-heal-c-'));
  t.after(() => {
    for (const dir of [office, aDir, bDir, cDir]) rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(path.join(office, 'auto-heal.json'), JSON.stringify({ on: true, by: 'Ada', at: 5 }));
  seedAutoHeal(aDir, office);
  seedAutoHeal(bDir, office);
  const a = new AutoHeal(aDir, () => {});
  const b = new AutoHeal(bDir, () => {});
  assert.equal(a.on, true);
  assert.equal(a.state().by, 'Ada');
  assert.equal(b.on, true);
  a.set(false, 'Bea');
  assert.equal(a.on, false);
  assert.equal(b.on, true, 'turning one floor off leaves the other on');
  seedAutoHeal(aDir, office);
  assert.equal(new AutoHeal(aDir, () => {}).on, false, 'a floor that chose is not copied over');
  seedAutoHeal(office, office);
  assert.equal(new AutoHeal(office, () => {}).on, true, 'the office file itself is that floor when they are the same folder');
  const bare = new AutoHeal(cDir, () => {});
  assert.equal(bare.on, false, 'no office file: still off');
  writeFileSync(path.join(office, 'auto-heal.json'), JSON.stringify({ on: true }));
  const dDir = mkdtempSync(path.join(tmpdir(), 'droid-office-heal-d-'));
  t.after(() => rmSync(dDir, { recursive: true, force: true }));
  seedAutoHeal(dDir, office);
  const seeded = new AutoHeal(dDir, () => {});
  assert.equal(seeded.on, true);
  assert.equal(seeded.state().by, 'someone', 'a file with no name still seeds');
  writeFileSync(path.join(office, 'auto-heal.json'), JSON.stringify({ on: 'yes' }));
  seedAutoHeal(cDir, office);
  assert.equal(new AutoHeal(cDir, () => {}).on, false, 'a file that is not a switch is not copied');
  writeFileSync(path.join(office, 'auto-heal.json'), '{');
  seedAutoHeal(cDir, office);
  assert.equal(new AutoHeal(cDir, () => {}).on, false, 'a file that cannot be read is not copied');
});

test('a failure is healed once, only while auto-heal is on', () => {
  const w = new HealWatch();
  assert.equal(w.finished(run({ id: 1 }), false), undefined, 'off: nothing');
  assert.equal(w.finished(run({ id: 2 }), true), 'heal');
  assert.equal(w.finished(run({ id: 2 }), true), undefined, 'the same run seen ending twice');
  assert.equal(w.finished(run({ id: 2, attempt: 2 }), true), 'heal', 'a re-run is a new attempt');
  assert.equal(w.finished(run({ id: 3, state: 'cancelled' }), true), undefined);
  assert.equal(w.finished(run({ id: 4, state: 'success' }), true), undefined);
});

test('a workflow that keeps failing on a branch is left to a person, until it passes', () => {
  const w = new HealWatch();
  for (let i = 1; i <= HEAL_TRIES; i++) assert.equal(w.finished(run({ id: i }), true), 'heal', `try ${i}`);
  assert.equal(w.finished(run({ id: 50 }), true), 'gaveUp');
  assert.equal(w.finished(run({ id: 51 }), true), undefined, 'said once');
  assert.equal(w.finished(run({ id: 60, branch: 'feature' }), true), 'heal', 'another branch has its own count');
  assert.equal(w.finished(run({ id: 61, workflow: 'Release' }), true), 'heal', 'and so does another workflow');
  w.finished(run({ id: 70, state: 'success' }), false);
  assert.equal(w.finished(run({ id: 71 }), true), 'heal', 'a pass starts it over, even one seen while off');
});

test('the heal prompt sends a worker to push to the failing branch, or to open a pull request against the default one', () => {
  const onMain = officePrompt(undefined, 'pipeline.heal', healPromptVars('github', run(), 'main'));
  assert.match(onMain, /^Droid Office notice: CI failure \(auto-heal enabled\)\nCI #7 on `main`: "feat: a thing"\nCommit: abcdef1 \| Event: push\nhttps:\/\/github\.com\/o\/r\/actions\/runs\/101/);
  assert.match(onMain, /gh run view 101 --log-failed/);
  assert.match(onMain, /gh run rerun 101 --failed/);
  assert.match(onMain, /office-workers hire --title "Fix CI on main" --from origin\/main/);
  assert.match(onMain, /open a pull request against `main` with `gh`/);
  assert.match(onMain, /gh run list --branch main --workflow ci\.yml --limit 3/);
  assert.match(onMain, /office-workers wait/);
  assert.doesNotMatch(onMain, /\{\{/);

  const onBranch = officePrompt(undefined, 'pipeline.heal', healPromptVars('github', run({ branch: 'fix/thing', event: 'pull_request' }), 'main'));
  assert.match(onBranch, /push it to `fix\/thing` \(`git push origin HEAD:fix\/thing`\)/);
  assert.match(onBranch, /--from origin\/fix\/thing/);

  const lab = officePrompt(undefined, 'pipeline.heal', healPromptVars('gitlab', run({ path: undefined, workflow: 'Pipeline' }), 'main'));
  assert.match(lab, /glab ci trace <job id>/);
  assert.match(lab, /projects\/:id\/pipelines\/101\/retry/);
  assert.match(lab, /glab ci status --branch main --live/);
  assert.match(lab, /merge request against `main` with `glab`/);
  assert.doesNotMatch(lab, /\bgh run\b/);
});
