import test from 'node:test';
import assert from 'node:assert/strict';
import { DROID_MODEL_MAX, isValidDroidModel, validateWorkerEffort, validateWorkerModel } from '../src/server/agents.js';

test('Droid model ids accept settings ids and reject whitespace or control characters', () => {
  assert.equal(isValidDroidModel('custom:droidproxy:gpt-6-sol'), true);
  assert.equal(isValidDroidModel('glm-5.3-flash'), true);
  assert.equal(isValidDroidModel('custom:droidproxy:gpt 6'), false);
  assert.equal(isValidDroidModel('custom:droidproxy:gpt\n6'), false);
  assert.equal(isValidDroidModel(''), false);
  assert.equal(isValidDroidModel(`custom:${'x'.repeat(256)}`), false);
  assert.equal(isValidDroidModel(`${'x'.repeat(DROID_MODEL_MAX)}`), true);
});

test('models can be selected for Droid workers only', () => {
  assert.equal(validateWorkerModel('agent', 'custom:droidproxy:gpt-6-sol'), undefined);
  assert.match(validateWorkerModel('agent', 'has a space') ?? '', /Droid model/);
  assert.match(validateWorkerModel('shell', 'glm-5.3-flash') ?? '', /Shell workers/);
});

test('reasoning effort can be selected for agent workers only', () => {
  assert.equal(validateWorkerEffort('agent', 'high'), undefined);
  assert.match(validateWorkerEffort('agent', 'overdrive') ?? '', /effort/);
  assert.match(validateWorkerEffort('shell', 'high') ?? '', /Shell workers/);
});
