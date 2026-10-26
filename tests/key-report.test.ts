import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_REPORT_MAX_EVENTS, KeyRecorder, keyReportName, visibleBytes } from '../src/shared/key-report.js';

test('a key report spells out control bytes, so Ctrl+Enter reads as its escape sequence', () => {
  assert.equal(visibleBytes('\x1b[13;5u'), '\\e[13;5u');
  assert.equal(visibleBytes('hi\r'), 'hi\\r');
  assert.equal(visibleBytes('a\nb\tc'), 'a\\nb\\tc');
  assert.equal(visibleBytes('\x03\x7f'), '\\x03\\x7f');
  assert.equal(visibleBytes('back\\slash'), 'back\\\\slash');
  assert.equal(visibleBytes('héllo ✓'), 'héllo ✓');
});

test('a recording keeps its steps in order, timed from its start, and only while it is on', () => {
  const r = new KeyRecorder();
  r.add('early', {}, 5);
  r.start(100);
  assert.equal(r.active, true);
  r.add('dom.capture', { key: 'Enter', ctrl: true }, 112.4);
  r.add('xterm.data', { bytes: '\\e[13;5u' }, 130);
  const done = r.stop(1100);
  assert.equal(r.active, false);
  assert.equal(done.ms, 1000);
  assert.equal(done.dropped, 0);
  assert.deepEqual(done.events, [
    { ms: 12, step: 'dom.capture', key: 'Enter', ctrl: true },
    { ms: 30, step: 'xterm.data', bytes: '\\e[13;5u' },
  ]);
  r.add('late', {}, 1200);
  assert.deepEqual(r.stop(1300).events, []);
});

test('a held key cannot grow a recording past its cap; what was left out is counted', () => {
  const r = new KeyRecorder();
  r.start(0);
  for (let i = 0; i < KEY_REPORT_MAX_EVENTS + 7; i++) r.add('dom.capture', { i }, i);
  const done = r.stop(1);
  assert.equal(done.events.length, KEY_REPORT_MAX_EVENTS);
  assert.equal(done.dropped, 7);
});

test('report files are named by when they were saved, safe on any file system', () => {
  assert.equal(keyReportName(new Date('2026-10-25T18:14:03.123Z')), 'terminal-keys-2026-10-25T18-14-03-123Z.json');
});
