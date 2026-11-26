import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardCommands } from '../src/server/server-runtime/board-commands.js';
import type { Client } from '../src/server/server-runtime/client.js';
import type { Floor } from '../src/server/floor.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';

/** A floor whose forge answers each call with `answers[call]`, and records nothing else. */
function fakeFloor(answers: Record<string, unknown>) {
  const answer = (name: string) => async () => answers[name];
  return {
    board: { forge: 'github', merge: answer('merge'), comment: answer('comment'), close: answer('close'), setLabels: answer('labels') },
    pipelines: { state: { runs: [{ id: 5, workflow: 'CI', number: 3, branch: 'main' }], workflows: [], defaultBranch: 'main' }, rerun: answer('rerun'), cancel: answer('cancel'), run: answer('run') },
    merged: () => {},
  } as unknown as Floor;
}

async function outcome(floor: Floor | undefined, msg: ClientMsg): Promise<{ settled: (string | undefined)[]; sent: ServerMsg[] }> {
  const sent: ServerMsg[] = [];
  const settled: (string | undefined)[] = [];
  const run = createBoardCommands({ floorOf: () => floor, sendTo: (_c, m) => sent.push(m), toastFloor: () => {} });
  run(
    { peer: { name: 'Alex (guest)' } } as Client,
    msg as Parameters<typeof run>[1],
    () => floor,
    (error) => settled.push(error),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { settled, sent };
}

test('a forge change settles its audit only once the forge has answered, and only as a success when it happened', async () => {
  const ok = fakeFloor({ merge: undefined, comment: { comment: { id: 1 } }, close: undefined, labels: { labels: ['bug'] }, rerun: undefined, cancel: undefined, run: undefined });
  const failed = fakeFloor({ merge: 'Not mergeable', comment: { error: 'Forbidden' }, close: 'Forbidden', labels: { error: 'No such label' }, rerun: 'Gone', cancel: 'Already done', run: 'No workflow' });
  const writes: ClientMsg[] = [
    { t: 'gh.merge', number: 7, method: 'squash' } as ClientMsg,
    { t: 'gh.comment', kind: 'pull', number: 7, body: 'LGTM' } as ClientMsg,
    { t: 'gh.close', kind: 'issue', number: 7 } as ClientMsg,
    { t: 'gh.labels', kind: 'issue', number: 7, add: ['bug'] } as ClientMsg,
    { t: 'pipelines.rerun', id: 5 } as ClientMsg,
    { t: 'pipelines.cancel', id: 5 } as ClientMsg,
    { t: 'pipelines.run', workflow: 'ci.yml', ref: 'main' } as ClientMsg,
  ];
  for (const msg of writes) {
    assert.deepEqual((await outcome(ok, msg)).settled, [undefined], `${msg.t} succeeded`);
    const bad = await outcome(failed, msg);
    assert.equal(bad.settled.length, 1, msg.t);
    assert.equal(typeof bad.settled[0], 'string', `${msg.t} failed at the forge`);
  }
  // Refused before the forge: never settled, so never audited.
  const refused: ClientMsg[] = [
    { t: 'gh.merge', number: 7, method: 'octopus' } as unknown as ClientMsg,
    { t: 'gh.comment', kind: 'pull', number: 7, body: '   ' } as ClientMsg,
    { t: 'gh.labels', kind: 'issue', number: 7, add: [] } as ClientMsg,
    { t: 'gh.close', kind: 'issue', number: -1 } as ClientMsg,
    { t: 'pipelines.rerun', id: 0 } as ClientMsg,
  ];
  for (const msg of refused) assert.deepEqual((await outcome(ok, msg)).settled, [], msg.t);
  assert.deepEqual((await outcome(undefined, { t: 'pipelines.run', workflow: 'ci.yml', ref: 'main' } as ClientMsg)).settled, [], 'no floor');
  // The reply to the guest is unchanged.
  assert.deepEqual((await outcome(failed, writes[0]!)).sent, [{ t: 'gh.merged', number: 7, error: 'Not mergeable' }]);
});
