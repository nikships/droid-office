import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CARDS, SETTINGS_PANES, SETTINGS_SCOPE, settingsPaneAfter, type SettingsPane } from '../src/shared/settings-nav.js';

test('settings has the six categories, in order', () => {
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.label),
    ['You', 'Sound', 'Notifications', 'Building', 'Workers', 'Subagents'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.id),
    ['you', 'sound', 'notify', 'building', 'workers', 'subagents'],
  );
});

test('every fork setting is in a category, with who it is for', () => {
  const byTitle = new Map(SETTINGS_CARDS.map((c) => [c.title, c]));
  const expect: [string, SettingsPane, 'you' | 'floor' | 'office' | null][] = [
    ['Your character', 'you', null],
    ['Camera view', 'you', 'you'],
    ['Office sounds', 'sound', 'you'],
    ['Jukebox', 'sound', 'you'],
    ['Desktop notifications', 'notify', 'you'],
    ['Channel notifications (Slack / Discord)', 'notify', 'office'],
    ['Holiday theme', 'building', 'office'],
    ['Outside', 'building', 'office'],
    ['Jira', 'building', 'office'],
    ["This floor's Jira epic", 'building', 'floor'],
    ['Workspace folder', 'building', 'office'],
    ['Source hot reload', 'building', 'office'],
    ['Default worker', 'workers', 'office'],
    ['Prompts', 'workers', 'office'],
    ['Worker limit', 'workers', 'office'],
    ['Workers whose pull request merged', 'workers', 'office'],
    ['Subagents', 'subagents', 'office'],
    ['Subagent worker', 'subagents', 'office'],
    ['Team size', 'subagents', 'office'],
    ['Where subagents work', 'subagents', 'office'],
    ['Waking the lead', 'subagents', 'office'],
    ['Droid skill', 'subagents', 'office'],
  ];
  assert.equal(byTitle.size, expect.length);
  for (const [title, pane, scope] of expect) {
    assert.deepEqual(byTitle.get(title), { pane, title, scope });
  }
  for (const pane of SETTINGS_PANES) assert.ok(SETTINGS_CARDS.some((c) => c.pane === pane.id));
  assert.deepEqual(SETTINGS_SCOPE.you, ['Just you', 'Only for you, kept in this browser']);
  assert.equal(SETTINGS_SCOPE.floor[0], 'This floor');
  assert.equal(SETTINGS_SCOPE.office[0], 'Everyone');
});

test('arrow keys move between categories and wrap, Home and End jump', () => {
  assert.equal(settingsPaneAfter('you', 'ArrowDown'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowRight'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowUp'), 'subagents');
  assert.equal(settingsPaneAfter('you', 'ArrowLeft'), 'subagents');
  assert.equal(settingsPaneAfter('workers', 'ArrowDown'), 'subagents');
  assert.equal(settingsPaneAfter('subagents', 'ArrowDown'), 'you');
  assert.equal(settingsPaneAfter('building', 'ArrowUp'), 'notify');
  assert.equal(settingsPaneAfter('sound', 'Home'), 'you');
  assert.equal(settingsPaneAfter('sound', 'End'), 'subagents');
  assert.equal(settingsPaneAfter('you', 'Enter'), null);
  assert.equal(settingsPaneAfter('you', 'Escape'), null);
  assert.equal(settingsPaneAfter('notify', 'a'), null);
});
