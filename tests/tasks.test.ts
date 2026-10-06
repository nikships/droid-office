import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNamer, fallbackTask } from '../src/server/tasks.js';
import { PROMPTS } from '../src/shared/prompts.js';

test('the fallback label is the prompt itself, cleaned up and clipped', () => {
  assert.deepEqual(fallbackTask('Fix the login redirect'), { name: 'Fix the login redirect', summary: 'Fix the login redirect' });
  assert.deepEqual(fallbackTask('  please,  can you fix the   login?  '), { name: 'Can you fix the', summary: 'Please, can you fix the login?' });
  assert.deepEqual(fallbackTask('ok so first do a thing, then another, then a third, then a fourth'), {
    name: 'So first do a',
    summary: 'Ok so first do a thing, then another, then a third, then a fourth',
  });
  const long = fallbackTask(`do ${'x'.repeat(300)}`);
  assert.ok(long.name.length <= 40, `name clipped, got ${long.name.length}`);
  assert.ok(long.summary.length <= 110, `summary clipped, got ${long.summary.length}`);
  assert.ok(long.name.endsWith('…') && long.summary.endsWith('…'));
});

test('without a droid binary there is no naming: the prompt stays the label and nothing is asked', () => {
  const named: string[] = [];
  const namer = new TaskNamer(
    null,
    {},
    () => PROMPTS['office.namer'].text,
    (id) => named.push(id),
  );
  assert.equal(namer.enabled, false);
  namer.request('w1', { prompts: ['Fix the login'], tools: [], epoch: 0 });
  namer.forget('w1');
  assert.deepEqual(named, []);
});
