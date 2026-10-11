import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WHITEBOARD_SKILL_MARK, WHITEBOARD_SKILL_NAME, WhiteboardSkill, whiteboardSkill } from '../src/server/whiteboard-skill.js';
import type { WhiteboardSkillState } from '../src/shared/protocol.js';

function rig(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wb-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const skillsDir = path.join(root, 'skills');
  mkdirSync(dataDir);
  const states: WhiteboardSkillState[] = [];
  const file = path.join(skillsDir, WHITEBOARD_SKILL_NAME, 'SKILL.md');
  return { dataDir, skillsDir, file, states, make: (noSkills = false) => new WhiteboardSkill(dataDir, (s) => states.push(s), noSkills ? undefined : skillsDir) };
}

test('the whiteboard skill only applies inside Droid Office and points at office-whiteboard', () => {
  const text = whiteboardSkill();
  assert.match(text, new RegExp(`^---\\nname: ${WHITEBOARD_SKILL_NAME}\\ndescription: .*DROID_OFFICE_WORKER_ID.*\\n---\\n`));
  assert.ok(text.includes(WHITEBOARD_SKILL_MARK));
  assert.match(text, /office-whiteboard whoami/);
  assert.match(text, /office-whiteboard help/);
  assert.match(text, /data-wb-id/);
  assert.match(text, /Never put secrets/);
});

test('the whiteboard skill starts on, is written, kept current, removed, and the choice persists', (t) => {
  const r = rig(t);
  const s = r.make();
  assert.equal(s.state().on, true, 'on by default');
  assert.equal(existsSync(r.file), false, 'nothing is written until the office syncs');
  assert.equal(s.syncSkill(), true);
  assert.equal(readFileSync(r.file, 'utf8'), whiteboardSkill());
  assert.equal(s.state().skillPath, r.file);
  assert.equal(s.syncSkill(), false, 'a second sync changes nothing');

  writeFileSync(r.file, `${WHITEBOARD_SKILL_MARK}\nan older version`);
  s.syncSkill();
  assert.equal(readFileSync(r.file, 'utf8'), whiteboardSkill(), 'an older skill of its own is brought up to date');

  s.set(false, 'Nik');
  assert.equal(existsSync(path.dirname(r.file)), false, 'turning it off removes the skill and its folder');
  const last = r.states.at(-1);
  assert.equal(last?.on, false);
  assert.equal(last?.by, 'Nik');
  assert.equal(last?.skillPath, undefined);
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dataDir, 'whiteboard-skill.json'), 'utf8')).on, false);

  const again = r.make();
  assert.equal(again.state().on, false, 'the choice survives a restart');
  assert.equal(again.state().by, 'Nik');
  again.set(true, 'Nik');
  assert.ok(existsSync(r.file));
});

test("a SKILL.md the office didn't write is left alone, on or off", (t) => {
  const r = rig(t);
  mkdirSync(path.dirname(r.file), { recursive: true });
  writeFileSync(r.file, 'my own skill');
  const s = r.make();
  s.syncSkill();
  assert.match(s.state().skillError ?? '', /didn't write/);
  assert.equal(s.state().skillPath, undefined);
  s.set(false, 'Nik');
  assert.equal(readFileSync(r.file, 'utf8'), 'my own skill');
  assert.equal(s.state().skillError, undefined);
});

test('without a skills folder nothing is written; a bad state file starts on; a write that fails is reported', (t) => {
  const r = rig(t);
  writeFileSync(path.join(r.dataDir, 'whiteboard-skill.json'), '{not json');
  const none = r.make(true);
  assert.equal(none.state().on, true);
  assert.equal(none.syncSkill(), false);
  assert.equal(existsSync(r.skillsDir), false);

  // The skills folder is a file: the skill can't be written there.
  writeFileSync(r.skillsDir, 'not a folder');
  const s = r.make();
  s.syncSkill();
  assert.match(s.state().skillError ?? '', /Couldn't write/);
});
