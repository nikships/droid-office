import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationBrief } from '../src/server/stations.js';
import type { StationKind } from '../src/shared/layout.js';

const KINDS: StationKind[] = ['issues', 'pulls', 'actions'];

test('every board agent is briefed without a task queue, and ends where the request is typed in', () => {
  for (const kind of KINDS) {
    for (const forge of ['github', 'gitlab'] as const) {
      const brief = stationBrief(kind, forge);
      assert.doesNotMatch(brief, /office-queue|task queue|curl|DROID_OFFICE_HOOK_TOKEN|Authorization/, `${kind} on ${forge}`);
      assert.match(brief, /You don't change code yourself/, kind);
      assert.match(brief, /a worker at a desk/, kind);
      assert.match(brief, /the Team lead/, kind);
      assert.match(brief, /say in a few lines what you did, with links/, kind);
      assert.ok(brief.endsWith('The request:'), kind);
    }
  }
});

test('the issues and PR agents keep their jobs', () => {
  const issues = stationBrief('issues');
  assert.match(issues, /Issues agent/);
  assert.match(issues, /GitHub issues with the gh CLI/);
  const pulls = stationBrief('pulls');
  assert.match(pulls, /PR agent/);
  assert.match(pulls, /gh pr diff/);
});

test('the Pipeline agent runs, watches, re-runs and explains GitHub Actions with gh', () => {
  const brief = stationBrief('actions');
  assert.match(brief, /Pipeline agent/);
  assert.match(brief, /🚀 Pipelines board/);
  assert.match(brief, /gh run list/);
  assert.match(brief, /gh run view <id> --log-failed/);
  assert.match(brief, /gh workflow run <workflow> --ref <branch> -f <input>=<value>/);
  assert.match(brief, /gh run watch <id> --exit-status/);
  assert.match(brief, /gh run rerun <id> --failed/);
  assert.match(brief, /gh run cancel <id>/);
  assert.match(brief, /ask which before you start anything/);
  assert.match(brief, /pull request/);
});

test('on a GitLab floor the Pipeline agent drives pipelines with glab', () => {
  const brief = stationBrief('actions', 'gitlab');
  assert.match(brief, /GitLab CI\/CD pipelines with the glab CLI/);
  assert.match(brief, /glab ci list/);
  assert.match(brief, /glab ci run --branch <branch>/);
  assert.match(brief, /--variables <key>:<value>/);
  assert.match(brief, /glab ci trace <job id>/);
  assert.match(brief, /glab ci retry <job id>/);
  assert.match(brief, /merge request/);
  assert.doesNotMatch(brief, /\bgh (run|workflow)\b/);
});

test('the Pipeline agent heals a failed run by hiring a worker with office-workers, on both forges', () => {
  for (const forge of ['github', 'gitlab'] as const) {
    const brief = stationBrief('actions', forge);
    assert.match(brief, /Healing a failed run/, forge);
    assert.match(brief, /auto-heal is on/, forge);
    assert.match(brief, /office-workers/, forge);
  }
  for (const kind of ['issues', 'pulls'] as const) assert.doesNotMatch(stationBrief(kind), /office-workers|auto-heal/, kind);
});
