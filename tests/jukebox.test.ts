import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Jukebox } from '../src/server/jukebox.js';
import { JUKEBOX_TUNES, STREAM } from '../src/shared/jukebox.js';

const dir = (t: { after: (fn: () => void) => void }) => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'jukebox-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

test('skip goes to the next tune in order while shuffle is off', (t) => {
  const j = new Jukebox(dir(t));
  j.play({ track: JUKEBOX_TUNES[0].id }, 'Nik');
  j.skip('Nik');
  assert.equal(j.state().track, JUKEBOX_TUNES[1].id);
  assert.equal(j.state().shuffle, undefined);
});

test('shuffle makes skip pick another tune at random', (t) => {
  const j = new Jukebox(dir(t));
  j.play({ track: JUKEBOX_TUNES[1].id }, 'Nik');
  assert.equal(j.setShuffle(true), true);
  assert.equal(j.setShuffle(true), false);
  j.skip('Nik', () => 0.99);
  assert.equal(j.state().track, JUKEBOX_TUNES[3].id);
  j.skip('Nik', () => 0);
  assert.equal(j.state().track, JUKEBOX_TUNES[0].id);
  for (let i = 0; i < 20; i++) {
    const was = j.state().track;
    j.skip('Nik');
    assert.notEqual(j.state().track, was);
    assert.ok(JUKEBOX_TUNES.some((tune) => tune.id === j.state().track));
  }
});

test('shuffle survives playing something else and a restart', (t) => {
  const d = dir(t);
  const j = new Jukebox(d);
  j.setShuffle(true);
  j.play({ url: 'https://example.com/radio.mp3' }, 'Nik');
  j.play({ track: JUKEBOX_TUNES[2].id }, 'Nik');
  j.stop('Nik');
  assert.equal(j.state().shuffle, true);
  assert.equal(JSON.parse(readFileSync(path.join(d, 'jukebox.json'), 'utf8')).shuffle, true);
  const again = new Jukebox(d);
  assert.equal(again.state().shuffle, true);
  assert.equal(again.setShuffle(false), true);
  assert.equal(new Jukebox(d).state().shuffle, undefined);
});

test('skip from a stream with shuffle on lands on a built-in tune', (t) => {
  const j = new Jukebox(dir(t));
  j.setShuffle(true);
  j.play({ url: 'https://example.com/radio.mp3' }, 'Nik');
  assert.equal(j.state().track, STREAM);
  j.skip('Nik', () => 0.5);
  assert.equal(j.state().track, JUKEBOX_TUNES[2].id);
  assert.equal(j.state().url, undefined);
});
