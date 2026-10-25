import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeClonePage, runnerOptions, runnerUrl } from '../.agents/skills/office-clone/scripts/office-run-options.mjs';

test('clone runner defaults stay headless with the original size and timeout', () => {
  const got = runnerOptions(['/tmp/office-clone-real', '/tmp/steps.mjs']);
  assert.deepEqual(got.positional, ['/tmp/office-clone-real', '/tmp/steps.mjs']);
  assert.equal(got.source, undefined);
  assert.equal(got.timeout, 120);
  assert.equal(got.size, '1440x900');
});

test('native clone runner arguments preserve checkout paths containing spaces', () => {
  const got = runnerOptions(['/tmp/office-clone-real', '--source', '/tmp/our built checkout', '--out', '/tmp/measurement proof', '--timeout', '360']);
  assert.equal(got.source, '/tmp/our built checkout');
  assert.equal(got.out, '/tmp/measurement proof');
  assert.equal(got.timeout, 360);
});

test('runner rejects unknown flags, malformed geometry, extra positions and invalid timeouts', () => {
  for (const args of [
    ['--soruce', '/tmp/checkout'],
    ['--size', '0x900'],
    ['--size', '1440by900'],
    ['--timeout', 'NaN'],
    ['--timeout', '0'],
    ['--timeout', 'Infinity'],
    ['/tmp/clone', '/tmp/steps', '/tmp/mistake'],
  ])
    assert.throws(() => runnerOptions(args));
  assert.equal(runnerOptions(['--help']).help, true);
});

test('native navigation and target selection use the exact clone origin', () => {
  assert.equal(runnerUrl(4677, true), 'http://localhost:4677/');
  assert.equal(runnerUrl(4677, false), 'http://127.0.0.1:4677/');
  assert.equal(nativeClonePage('http://localhost:4677/?pace=full', 4677), true);
  for (const url of ['http://localhost:46770/', 'http://localhost:4600/', 'https://localhost:4677/', 'http://localhost.evil:4677/', 'about:blank', 'bad URL']) assert.equal(nativeClonePage(url, 4677), false, url);
});
