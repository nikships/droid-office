import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTask } from '../src/server/tasks.js';

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
