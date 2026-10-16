import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTrace, traceFile } from '../src/desktop/input-trace.js';

test('the trace is off unless DROID_OFFICE_INPUT_TRACE names a file', () => {
  assert.equal(traceFile({}), undefined);
  assert.equal(traceFile({ DROID_OFFICE_INPUT_TRACE: '' }), undefined);
  assert.equal(traceFile({ DROID_OFFICE_INPUT_TRACE: '/tmp/x.log' }), '/tmp/x.log');
  assert.doesNotThrow(() => createTrace(undefined)('nothing'));
});

test('the trace appends one stamped line per call and survives an unwritable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-trace-'));
  try {
    const file = path.join(dir, 'trace.log');
    const trace = createTrace(file, () => 1500);
    trace('one');
    trace('two');
    assert.equal(fs.readFileSync(file, 'utf8'), '1.500 js one\n1.500 js two\n');
    assert.doesNotThrow(() => createTrace(path.join(dir, 'missing', 'trace.log'))('lost'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
