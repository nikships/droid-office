import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tutorial, freshTutorial, parseTutorial, tutorialActionDone, type TutorialObservation, type TutorialCheck } from '../src/client/tutorial.js';
import { TUTORIAL_SECTIONS } from '../src/client/tutorial-sections.js';

const sections = TUTORIAL_SECTIONS;
const make = () => {
  const saves: string[] = [];
  const tutorial = new Tutorial(sections, freshTutorial(sections), (p) => saves.push(JSON.stringify(p)));
  return { tutorial, saves };
};
const observation: TutorialObservation = {
  x: 0,
  y: 0,
  z: 0,
  facing: 0,
  pitch: 0,
  floor: 'project',
  grounded: true,
  controls: true,
  riding: false,
  near: false,
  workers: ['one'],
  screens: [],
  terminal: false,
  carrying: false,
  wand: false,
  armed: true,
  lumos: false,
  wheel: false,
  hanging: false,
};

test('all eleven sections have stable unique steps and at least one real action', () => {
  assert.equal(sections.length, 11);
  assert.equal(new Set(sections.map((s) => s.id)).size, sections.length);
  for (const section of sections) {
    assert.ok(section.steps.length);
    assert.equal(new Set(section.steps.map((s) => s.id)).size, section.steps.length);
    assert.ok(section.steps.some((s) => s.check || s.selector || s.event));
    for (const step of section.steps) {
      assert.ok(step.id && step.title && step.text);
      assert.ok([step.check, step.selector, step.event].filter(Boolean).length <= 1);
    }
  }
});

test('section choice skips unticked sections and saves the exact active step', () => {
  const { tutorial: t, saves } = make();
  t.start(['around', 'books', 'not-a-section']);
  assert.equal(t.progress.offered, true);
  assert.equal(t.section?.id, 'around');
  assert.equal(t.step?.id, 'walk');
  assert.equal(t.progress.sections.hire.status, 'skipped');
  assert.deepEqual(t.progress.queue, ['books']);
  assert.equal(t.explanation, false);
  t.advance();
  assert.equal(t.step?.id, 'look');
  const resumed = parseTutorial(saves.at(-1)!, sections);
  assert.equal(resumed.active, 'around');
  assert.equal(resumed.sections.around.step, 'look');
});

test('completed sections stay done after reload; skipping a step never claims completion', () => {
  const { tutorial: t } = make();
  t.start(['around', 'floors']);
  while (t.section?.id === 'around') t.advance();
  assert.equal(t.progress.sections.around.status, 'done');
  t.advance(true);
  assert.deepEqual(t.progress.sections.floors.skipped, ['find']);
  while (t.section) t.advance();
  assert.equal(t.progress.sections.floors.status, 'skipped');
  assert.equal(t.progress.active, null);
  const resumed = parseTutorial(JSON.stringify(t.progress), sections);
  assert.equal(resumed.sections.around.status, 'done');
  assert.equal(resumed.active, null);
  assert.equal(resumed.offered, true);
});

test('skip section, end and replay never require an earlier section', () => {
  const { tutorial: t } = make();
  t.start(['around', 'floors', 'hire']);
  t.skipSection();
  assert.equal(t.section?.id, 'floors');
  assert.equal(t.progress.sections.around.status, 'skipped');
  t.end();
  assert.equal(t.progress.active, null);
  assert.deepEqual(t.progress.queue, []);
  assert.equal(t.progress.sections.floors.status, 'skipped');
  assert.equal(t.progress.sections.hire.status, 'skipped');
  t.replay('wand');
  assert.equal(t.section?.id, 'wand');
  assert.equal(t.step?.id, 'draw');
  assert.deepEqual(t.progress.queue, []);
  t.advance(true);
  t.replay('wand');
  assert.equal(t.step?.id, 'draw');
  assert.deepEqual(t.progress.sections.wand.skipped, []);
  t.replay('does-not-exist');
  assert.equal(t.section?.id, 'wand');
});

test('declining or selecting nothing suppresses future automatic offers', () => {
  const { tutorial: t } = make();
  t.end();
  assert.equal(t.progress.offered, true);
  assert.equal(t.section, undefined);
  t.start([]);
  assert.equal(t.step, undefined);
  assert.ok(Object.values(t.progress.sections).every((p) => p.status === 'skipped'));
  t.advance();
  t.skipSection();
  assert.equal(t.explanation, false);
});

test('restart replaces progress and explanation steps alone expose Next', () => {
  const { tutorial: t } = make();
  t.start(['around']);
  for (let i = 0; i < 4; i++) t.advance();
  assert.equal(t.step?.id, 'topbar');
  assert.equal(t.explanation, true);
  t.advance();
  assert.equal(t.explanation, false);
  t.start(sections.map((s) => s.id));
  assert.equal(t.step?.id, 'walk');
  assert.equal(t.progress.sections.floors.status, 'not-started');
});

test('malformed and future saves cannot break onboarding', () => {
  for (const json of [null, '', '{broken', 'null', '7', '[]', '{"version":2}', '{"version":1,"sections":false,"active":5,"queue":false}']) {
    assert.deepEqual(parseTutorial(json, sections), freshTutorial(sections));
  }
  const p = parseTutorial(
    JSON.stringify({
      version: 1,
      offered: true,
      active: 'around',
      queue: ['missing', 'books', 'books', 'around'],
      sections: {
        around: { status: 'in-progress', step: 'removed-step', skipped: ['walk', 'walk', 'missing'] },
        hire: { status: 'bogus', step: 'hire' },
      },
    }),
    sections,
  );
  assert.equal(p.active, 'around');
  assert.equal(p.sections.around.step, 'walk');
  assert.deepEqual(p.sections.around.skipped, ['walk']);
  assert.deepEqual(p.queue, ['books']);
  assert.equal(p.sections.hire.status, 'not-started');
  assert.equal(parseTutorial('{"version":1,"active":"__proto__"}', sections).active, null);
});

test('server restart/reload round trip retains every skipped step and queued section', () => {
  const { tutorial: t } = make();
  t.start(sections.map((s) => s.id));
  t.advance(true);
  t.advance();
  const p = parseTutorial(JSON.stringify(t.progress), sections);
  assert.deepEqual(p, t.progress);
  const restored = new Tutorial(sections, p, () => {});
  assert.equal(restored.step?.id, 'jump');
});

test('actions complete from observed state, not merely pressing keys', () => {
  const cases: [TutorialCheck, Partial<TutorialObservation>][] = [
    ['walk', { x: 1.6 }],
    ['look', { facing: 0.4 }],
    ['jump', { y: 0.6, grounded: false }],
    ['near', { near: true }],
    ['floor', { floor: 'another' }],
    ['hire', { workers: ['one', 'two'] }],
    ['screen', { screens: ['one'] }],
    ['terminal', { terminal: true }],
    ['carry', { carrying: true }],
    ['wand', { wand: true }],
    ['holster', { armed: false }],
    ['lumos', { wand: true, lumos: true }],
    ['wheel', { wand: true, wheel: true }],
    ['hanging', { hanging: true }],
  ];
  for (const [check, change] of cases) {
    assert.equal(tutorialActionDone(check, observation, observation), false, check);
    assert.equal(tutorialActionDone(check, { ...observation, ...change }, observation), true, check);
  }
});

test('navigation, blocked controls and unrelated workers do not satisfy exercises', () => {
  assert.equal(tutorialActionDone('walk', { ...observation, x: 2, controls: false }, observation), false);
  assert.equal(tutorialActionDone('walk', { ...observation, x: 2, floor: 'elsewhere' }, observation), false);
  assert.equal(tutorialActionDone('look', { ...observation, facing: Math.PI * 2 - 0.1 }, observation), false);
  assert.equal(tutorialActionDone('look', { ...observation, pitch: 0.25 }, observation), true);
  assert.equal(tutorialActionDone('jump', { ...observation, y: 1, grounded: true }, observation), false);
  assert.equal(tutorialActionDone('floor', { ...observation, floor: null }, observation), false);
  assert.equal(tutorialActionDone('floor', { ...observation, floor: 'next', riding: true }, observation), false);
  assert.equal(tutorialActionDone('hire', { ...observation, floor: 'next', workers: ['two'] }, observation), false);
  assert.equal(tutorialActionDone('lumos', { ...observation, lumos: true }, observation), false);
  assert.equal(tutorialActionDone('wheel', { ...observation, wheel: true }, observation), false);
});

test('destructive exercises are explanations and credit-spending hire is clearly warned', () => {
  const charged = sections.find((s) => s.id === 'wand')!.steps.find((s) => s.id === 'charged')!;
  const home = sections.find((s) => s.id === 'changes')!.steps.find((s) => s.id === 'home')!;
  for (const step of [charged, home]) {
    assert.equal(step.check, undefined);
    assert.equal(step.event, undefined);
    assert.equal(step.selector, undefined);
    assert.ok(step.warning);
    assert.match(step.text, /worktree/);
  }
  assert.match(sections.find((s) => s.id === 'hire')!.steps.find((s) => s.id === 'hire')!.warning!, /credits/);
});
