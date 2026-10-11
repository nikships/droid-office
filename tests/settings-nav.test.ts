import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CARDS, SETTINGS_PANES, settingsPaneAfter, type SettingsPane } from '../src/shared/settings-nav.js';

test('settings has the nine categories, in order', () => {
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.label),
    ['You', 'Sound', 'Graphics', 'Notifications', 'Building', 'Factory', 'Workers', 'Subagents', 'Phone'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.id),
    ['you', 'sound', 'graphics', 'notify', 'building', 'factory', 'workers', 'subagents', 'phone'],
  );
});

test('every setting is in a category', () => {
  const byTitle = new Map(SETTINGS_CARDS.map((c) => [c.title, c]));
  const expect: [string, SettingsPane][] = [
    ['Your character', 'you'],
    ['What 7 puts in your hand', 'you'],
    ['Office sounds', 'sound'],
    ['Alert sounds', 'sound'],
    ['Jukebox', 'sound'],
    ['Render resolution', 'graphics'],
    ['Temporal anti-aliasing', 'graphics'],
    ['Sharpening', 'graphics'],
    ['Frame rate limit', 'graphics'],
    ['Shadows', 'graphics'],
    ['Performance overlay', 'graphics'],
    ['Desktop notifications', 'notify'],
    ['Channel notifications (Slack / Discord)', 'notify'],
    ['Outside', 'building'],
    ['Jira', 'building'],
    ["This floor's Jira epic", 'building'],
    ['Workspace folder', 'building'],
    ['Source hot reload', 'building'],
    ['Factory API key', 'factory'],
    ['Default worker', 'workers'],
    ['Where fresh workers start', 'workers'],
    ['Prompts', 'workers'],
    ['Prompt chips', 'workers'],
    ['Worker limit', 'workers'],
    ['Workers whose pull request merged', 'workers'],
    ['Worktree setup', 'workers'],
    ['Subagents', 'subagents'],
    ['Subagent worker', 'subagents'],
    ['Models leads can pick', 'subagents'],
    ['Team size', 'subagents'],
    ['Where subagents work', 'subagents'],
    ['Waking the lead', 'subagents'],
    ['Droid skill', 'subagents'],
    ['Whiteboard skill', 'subagents'],
    ['Droid Office for Android', 'phone'],
  ];
  assert.equal(byTitle.size, expect.length);
  for (const [title, pane] of expect) {
    assert.deepEqual(byTitle.get(title), { pane, title });
  }
  for (const pane of SETTINGS_PANES) assert.ok(SETTINGS_CARDS.some((c) => c.pane === pane.id));
});

test('arrow keys move between categories and wrap, Home and End jump', () => {
  assert.equal(settingsPaneAfter('you', 'ArrowDown'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowRight'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowUp'), 'phone');
  assert.equal(settingsPaneAfter('you', 'ArrowLeft'), 'phone');
  assert.equal(settingsPaneAfter('workers', 'ArrowDown'), 'subagents');
  assert.equal(settingsPaneAfter('subagents', 'ArrowDown'), 'phone');
  assert.equal(settingsPaneAfter('phone', 'ArrowDown'), 'you');
  assert.equal(settingsPaneAfter('building', 'ArrowUp'), 'notify');
  assert.equal(settingsPaneAfter('building', 'ArrowDown'), 'factory');
  assert.equal(settingsPaneAfter('factory', 'ArrowDown'), 'workers');
  assert.equal(settingsPaneAfter('sound', 'ArrowDown'), 'graphics');
  assert.equal(settingsPaneAfter('graphics', 'ArrowDown'), 'notify');
  assert.equal(settingsPaneAfter('sound', 'Home'), 'you');
  assert.equal(settingsPaneAfter('sound', 'End'), 'phone');
  assert.equal(settingsPaneAfter('you', 'Enter'), null);
  assert.equal(settingsPaneAfter('you', 'Escape'), null);
  assert.equal(settingsPaneAfter('notify', 'a'), null);
});
