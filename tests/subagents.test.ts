import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SKILL_MARK, SKILL_NAME, Subagents, cleanSettings, subagentSkill } from '../src/server/subagents.js';
import { SUBAGENT_DEFAULTS, SUBAGENT_MAX_PER_LEAD, type SubagentsState } from '../src/shared/protocol.js';

function rig(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-subagents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const skills = path.join(root, 'skills');
  mkdirSync(data);
  const states: SubagentsState[] = [];
  const make = () => new Subagents(data, (s) => states.push(s), skills);
  return { data, skills, file: path.join(skills, SKILL_NAME, 'SKILL.md'), states, make };
}

test('cleanSettings keeps what is valid, clamps the team size and falls back on the rest', () => {
  assert.deepEqual(cleanSettings(undefined), SUBAGENT_DEFAULTS);
  assert.deepEqual(cleanSettings('nope'), SUBAGENT_DEFAULTS);
  const s = cleanSettings({ on: false, deskWorkers: 'yes', maxPerLead: 99, agent: { model: 'glm-5.3', effort: 'max' } });
  assert.equal(s.on, false);
  assert.equal(s.deskWorkers, true, 'a non-boolean is the default');
  assert.equal(s.maxPerLead, SUBAGENT_MAX_PER_LEAD);
  assert.deepEqual(s.agent, { model: 'glm-5.3', effort: 'max' });
  assert.equal(cleanSettings({ maxPerLead: 0 }).maxPerLead, 1);
  assert.equal(cleanSettings({ maxPerLead: 2.5 }).maxPerLead, SUBAGENT_DEFAULTS.maxPerLead);
  assert.equal(cleanSettings({ agent: { model: '', effort: 'loud' } }).agent, undefined, 'nothing valid picked is the office default');
  assert.deepEqual(cleanSettings({ agent: { model: 'glm-5.3', effort: 'loud' } }).agent, { model: 'glm-5.3' });
  const base = { ...SUBAGENT_DEFAULTS, agent: { effort: 'high' as const } };
  assert.deepEqual(cleanSettings({}, base).agent, { effort: 'high' }, 'no agent key keeps the base');
  assert.equal(cleanSettings({ agent: null }, base).agent, undefined, 'null clears it');
});

test('the skill only applies inside Droid Office and points at office-workers', () => {
  const text = subagentSkill();
  assert.match(text, new RegExp(`^---\\nname: ${SKILL_NAME}\\ndescription: .*DROID_OFFICE_WORKER_ID.*\\n---\\n`));
  assert.ok(text.includes(SKILL_MARK));
  assert.match(text, /office-workers whoami/);
  assert.match(text, /office-workers help/);
  assert.match(text, /Outside Droid Office this skill does not apply/);
});

test('settings persist; the skill is written, kept current and removed with them', (t) => {
  const r = rig(t);
  const s = r.make();
  assert.deepEqual(s.settings, SUBAGENT_DEFAULTS);
  assert.equal(existsSync(r.file), false, 'nothing is written until the office syncs');
  assert.equal(s.syncSkill(), true);
  assert.equal(readFileSync(r.file, 'utf8'), subagentSkill());
  assert.equal(s.state().skillPath, r.file);
  assert.equal(s.syncSkill(), false, 'a second sync changes nothing');

  writeFileSync(r.file, `${SKILL_MARK}\nan older version`);
  s.syncSkill();
  assert.equal(readFileSync(r.file, 'utf8'), subagentSkill(), 'an older skill of its own is brought up to date');

  assert.equal(s.set({ ...s.settings, skill: false, maxPerLead: 2, agent: { model: 'glm-5.3' } }, 'Nik'), undefined);
  assert.equal(existsSync(path.dirname(r.file)), false, 'turning the skill off removes it and its folder');
  const last = r.states.at(-1);
  assert.equal(last?.by, 'Nik');
  assert.equal(last?.skill, false);
  assert.equal(last?.skillPath, undefined);

  const again = r.make();
  assert.equal(again.settings.maxPerLead, 2);
  assert.deepEqual(again.settings.agent, { model: 'glm-5.3' });
  assert.equal(again.state().by, 'Nik');

  // Settings without an agent go back to the office's default droid.
  again.set({ ...again.settings, agent: undefined, skill: true }, 'Nik');
  assert.equal(again.settings.agent, undefined);
  assert.ok(existsSync(r.file));
  // Subagents off takes the skill away too.
  again.set({ ...again.settings, on: false }, 'Nik');
  assert.equal(existsSync(r.file), false);
});

test("a skill of the same name the office didn't write is left alone", (t) => {
  const r = rig(t);
  mkdirSync(path.dirname(r.file), { recursive: true });
  writeFileSync(r.file, 'my own skill');
  const s = r.make();
  s.syncSkill();
  assert.equal(readFileSync(r.file, 'utf8'), 'my own skill');
  assert.match(s.state().skillError ?? '', /didn't write/);
  s.set({ ...s.settings, skill: false }, 'Nik');
  assert.equal(readFileSync(r.file, 'utf8'), 'my own skill', 'turning it off does not delete it either');
  assert.equal(s.state().skillError, undefined);
});

test("removing the skill keeps a folder someone put more in, and a bad pick isn't saved", (t) => {
  const r = rig(t);
  const s = r.make();
  s.syncSkill();
  writeFileSync(path.join(path.dirname(r.file), 'notes.md'), 'mine');
  s.set({ ...s.settings, skill: false }, 'Nik');
  assert.equal(existsSync(r.file), false);
  assert.ok(existsSync(path.join(path.dirname(r.file), 'notes.md')));

  const before = r.states.length;
  assert.equal(s.set({ ...s.settings, agent: { model: 'two words' } }, 'Nik'), 'Invalid Droid model (expected a model id without whitespace)');
  assert.equal(r.states.length, before, 'a refused change says nothing');
  assert.equal(s.settings.agent, undefined);

  // A saved pick the office can no longer start is forgotten on the next start.
  writeFileSync(path.join(r.data, 'subagents.json'), JSON.stringify({ ...SUBAGENT_DEFAULTS, agent: { model: 'two words' } }));
  assert.equal(r.make().settings.agent, undefined);
  writeFileSync(path.join(r.data, 'subagents.json'), '{not json');
  assert.deepEqual(r.make().settings, SUBAGENT_DEFAULTS);
});
