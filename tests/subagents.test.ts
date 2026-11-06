import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SKILL_MARK, WHITEBOARD_SKILL_MARK, Subagents, cleanSettings, removeBundledSkills } from '../src/server/subagents.js';
import { SUBAGENT_DEFAULTS, SUBAGENT_MAX_PER_LEAD, SUBAGENT_MODEL_NOTE_MAX, SUBAGENT_MODELS_MAX, type SubagentsState } from '../src/shared/protocol.js';

function rig(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-subagents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const skills = path.join(root, 'skills');
  mkdirSync(data);
  const states: SubagentsState[] = [];
  const make = () => new Subagents(data, (s) => states.push(s));
  return { data, skills, states, make };
}

test('cleanSettings keeps what is valid, clamps the team size and falls back on the rest', () => {
  assert.deepEqual(cleanSettings(undefined), SUBAGENT_DEFAULTS);
  assert.deepEqual(cleanSettings('nope'), SUBAGENT_DEFAULTS);
  const s = cleanSettings({ on: false, maxPerLead: 99, agent: { model: 'glm-5.3', effort: 'max' } });
  assert.equal(s.on, false);
  assert.equal('deskWorkers' in cleanSettings({ deskWorkers: false }), false, 'obsolete kiosk-only hiring preferences are ignored');
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

test('cleanSettings keeps the models leads may pick: valid ids once each, notes on one short line', () => {
  const s = cleanSettings({
    models: [
      { id: 'glm-5.3-flash', note: '  cheap,\n fine for tests \u0007 ' },
      'claude-opus-5-5',
      { id: 'glm-5.3-flash', note: 'duplicate' },
      { id: 'has a space' },
      { id: 'gpt-6-sol', note: 'x'.repeat(SUBAGENT_MODEL_NOTE_MAX + 50) },
      { note: 'no id' },
      null,
    ],
  });
  assert.deepEqual(s.models, [{ id: 'glm-5.3-flash', note: 'cheap, fine for tests' }, { id: 'claude-opus-5-5' }, { id: 'gpt-6-sol', note: 'x'.repeat(SUBAGENT_MODEL_NOTE_MAX) }]);
  assert.equal(cleanSettings({ models: [] }).models, undefined, 'an empty list is any model');
  assert.equal(cleanSettings({ models: Array.from({ length: SUBAGENT_MODELS_MAX + 5 }, (_, i) => `m-${i}`) }).models?.length, SUBAGENT_MODELS_MAX);
  const base = { ...SUBAGENT_DEFAULTS, models: [{ id: 'glm-5.3' }] };
  assert.deepEqual(cleanSettings({}, base).models, [{ id: 'glm-5.3' }], 'no models key keeps the base');
  assert.equal(cleanSettings({ models: null }, base).models, undefined, 'null clears it');
});

test('saved settings without models let leads pick any model again', (t) => {
  const r = rig(t);
  const s = r.make();
  s.set({ ...s.settings, models: [{ id: 'glm-5.3', note: 'cheap' }] }, 'Nik');
  assert.deepEqual(r.make().settings.models, [{ id: 'glm-5.3', note: 'cheap' }]);
  assert.deepEqual(r.states.at(-1)?.models, [{ id: 'glm-5.3', note: 'cheap' }]);
  // A malformed list keeps what was saved: it never widens what leads may pick.
  s.set({ ...s.settings, models: 'everything' }, 'Nik');
  assert.deepEqual(s.settings.models, [{ id: 'glm-5.3', note: 'cheap' }]);
  s.set({ ...s.settings, models: { id: 'x' } }, 'Nik');
  assert.deepEqual(s.settings.models, [{ id: 'glm-5.3', note: 'cheap' }]);
  s.set({ ...s.settings, models: undefined }, 'Nik');
  assert.equal(s.settings.models, undefined);
  assert.equal(r.make().settings.models, undefined);
});

test('settings persist without skill fields or filesystem writes to skills', (t) => {
  const r = rig(t);
  const s = r.make();
  assert.deepEqual(s.settings, SUBAGENT_DEFAULTS);
  assert.equal(s.set({ ...s.settings, officeMcp: false, maxPerLead: 2, agent: { model: 'glm-5.3' } }, 'Nik'), undefined);
  const last = r.states.at(-1);
  assert.equal(last?.by, 'Nik');
  for (const field of ['skill', 'skillPath', 'skillError']) assert.equal(field in last!, false);
  assert.equal(existsSync(r.skills), false);

  const again = r.make();
  assert.equal(again.settings.officeMcp, false);
  assert.equal(again.settings.maxPerLead, 2);
  assert.deepEqual(again.settings.agent, { model: 'glm-5.3' });
  assert.equal(again.state().by, 'Nik');

  // Settings without an agent go back to the office's default worker.
  again.set({ ...again.settings, agent: undefined }, 'Nik');
  assert.equal(again.settings.agent, undefined);
});

test('old saved settings and clients can carry skill fields without affecting Office MCP', (t) => {
  const r = rig(t);
  writeFileSync(path.join(r.data, 'subagents.json'), JSON.stringify({ skill: false, on: false, maxPerLead: 2, by: 'Nik', at: 123 }));
  const s = r.make();
  assert.equal(s.settings.officeMcp, true, 'missing MCP field defaults on, independent of the old skill toggle');
  assert.equal(s.settings.on, false);
  assert.equal(s.settings.maxPerLead, 2);
  assert.equal(s.state().by, 'Nik');
  assert.equal(s.state().at, 123);
  assert.equal('skill' in s.settings, false);
  assert.equal(s.set({ skill: true, officeMcp: false }, 'Nik'), undefined);
  assert.equal(s.settings.officeMcp, false);
  s.set({ skill: false }, 'old client');
  assert.equal(s.settings.officeMcp, false, 'an old client keeps the saved MCP choice');
  assert.equal('skill' in JSON.parse(readFileSync(path.join(r.data, 'subagents.json'), 'utf8')), false);
});

for (const [name, mark, otherMark] of [
  ['droid-office-subagents', SKILL_MARK, WHITEBOARD_SKILL_MARK],
  ['droid-office-whiteboard', WHITEBOARD_SKILL_MARK, SKILL_MARK],
]) {
  test(`startup removes only the office's marked ${name} skill and its empty folder`, (t) => {
    const r = rig(t);
    const dir = path.join(r.skills, name);
    const file = path.join(dir, 'SKILL.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${mark}\nan older bundled skill`);
    assert.deepEqual(removeBundledSkills(r.skills), []);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(removeBundledSkills(r.skills), [], 'repeated startups need no migration');
  });

  test(`startup preserves a user-written ${name} skill, including one with the other skill's mark`, (t) => {
    const r = rig(t);
    const dir = path.join(r.skills, name);
    const file = path.join(dir, 'SKILL.md');
    mkdirSync(dir, { recursive: true });
    for (const text of ['my own skill', `${otherMark}\nnot this bundled skill`]) {
      writeFileSync(file, text);
      assert.deepEqual(removeBundledSkills(r.skills), []);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
  });

  test(`startup removes ${name} but keeps other files in its folder`, (t) => {
    const r = rig(t);
    const dir = path.join(r.skills, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), mark);
    writeFileSync(path.join(dir, 'notes.md'), 'mine');
    assert.deepEqual(removeBundledSkills(r.skills), []);
    assert.equal(existsSync(path.join(dir, 'SKILL.md')), false);
    assert.equal(readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'mine');
  });
}

test('startup cleanup needs an explicit skills directory and reports failures without stopping other cleanup', (t) => {
  const r = rig(t);
  assert.deepEqual(removeBundledSkills(undefined), []);
  assert.equal(existsSync(r.skills), false);
  const blocked = path.join(r.skills, 'droid-office-subagents', 'SKILL.md');
  mkdirSync(blocked, { recursive: true });
  const dir = path.join(r.skills, 'droid-office-whiteboard');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'SKILL.md'), WHITEBOARD_SKILL_MARK);
  const problems = removeBundledSkills(r.skills);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(blocked));
  assert.equal(existsSync(dir), false);
});

test("a bad pick isn't saved and malformed saved settings fall back cleanly", (t) => {
  const r = rig(t);
  const s = r.make();
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
