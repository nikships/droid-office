import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CARDS, SETTINGS_PANES, resolveSettingsPane, searchSettings, settingsPaneAfter, type SettingsPane } from '../src/shared/settings-nav.js';

test('settings has the nine categories, grouped Personal / Workers / Office, in order', () => {
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.label),
    ['You', 'Sound & alerts', 'Display', 'Workers', 'Models', 'Subagents & visits', 'Connections', 'Office & floors', 'Phone & web'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.id),
    ['you', 'sound', 'graphics', 'workers', 'models', 'subagents', 'connections', 'office', 'phone'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.section),
    ['Personal', 'Personal', 'Personal', 'Workers', 'Workers', 'Workers', 'Office', 'Office', 'Office'],
  );
  for (const pane of SETTINGS_PANES) {
    assert.ok(pane.scope, `${pane.id} says who it applies to`);
    assert.ok(pane.blurb, `${pane.id} says what it holds`);
  }
});

test('every setting is in a category', () => {
  const byTitle = new Map(SETTINGS_CARDS.map((c) => [c.title, c]));
  const expect: [string, SettingsPane][] = [
    ['Your character', 'you'],
    ['What 7 puts in your hand', 'you'],
    ['Raw mouse input', 'you'],
    ['Look sensitivity', 'you'],
    ['Office sounds', 'sound'],
    ['Alert sounds', 'sound'],
    ['Jukebox', 'sound'],
    ['Desktop notifications', 'sound'],
    ['Renderer', 'graphics'],
    ['HDR', 'graphics'],
    ['Render resolution', 'graphics'],
    ['Temporal anti-aliasing', 'graphics'],
    ['Sharpening', 'graphics'],
    ['Frame rate limit', 'graphics'],
    ['Overhead lights', 'graphics'],
    ['Performance overlay', 'graphics'],
    ['Worker labels', 'workers'],
    ['Where fresh workers start', 'workers'],
    ['Prompts', 'workers'],
    ['Worker limit', 'workers'],
    ['Workers whose pull request merged', 'workers'],
    ['Worktree setup', 'workers'],
    ['Whiteboard skill', 'workers'],
    ['Default worker', 'models'],
    ['Models shown in pickers', 'models'],
    ['Subagents', 'subagents'],
    ['Who can hire', 'subagents'],
    ['Subagent worker', 'subagents'],
    ['Models leads can pick', 'subagents'],
    ['Team size', 'subagents'],
    ['Where subagents work', 'subagents'],
    ['Waking the lead', 'subagents'],
    ['Subagents skill', 'subagents'],
    ['Visits between workers', 'subagents'],
    ['Droid', 'connections'],
    ['Factory API key', 'connections'],
    ['DroidProxy', 'connections'],
    ['Accounts', 'connections'],
    ['Models in Droid', 'connections'],
    ['Jira', 'connections'],
    ["This floor's Jira epic", 'connections'],
    ['Outside', 'office'],
    ['Workspace folder', 'office'],
    ['Host desktop app', 'office'],
    ['Source hot reload', 'office'],
    ['Droid Office for Android', 'phone'],
    ['Web companion', 'phone'],
  ];
  assert.equal(byTitle.size, expect.length);
  for (const [title, pane] of expect) {
    assert.equal(byTitle.get(title)?.pane, pane, title);
  }
  for (const pane of SETTINGS_PANES) assert.ok(SETTINGS_CARDS.some((c) => c.pane === pane.id));
});

test('pane ids from before the reorganization still resolve', () => {
  assert.equal(resolveSettingsPane('factory'), 'connections');
  assert.equal(resolveSettingsPane('subscriptions'), 'connections');
  assert.equal(resolveSettingsPane('building'), 'office');
  assert.equal(resolveSettingsPane('notify'), 'sound');
  assert.equal(resolveSettingsPane('models'), 'models');
  assert.equal(resolveSettingsPane('workers'), 'workers');
  assert.equal(resolveSettingsPane('you'), 'you');
  assert.equal(resolveSettingsPane('nope'), undefined);
  assert.equal(resolveSettingsPane(undefined), undefined);
});

test('notifications sit with sound, are personal and only offer desktop notifications', () => {
  assert.equal(SETTINGS_PANES.find((p) => p.id === 'sound')?.scope, 'Just you');
  assert.deepEqual(
    SETTINGS_CARDS.filter((c) => c.pane === 'sound').map((c) => c.title),
    ['Office sounds', 'Jukebox', 'Alert sounds', 'Desktop notifications'],
  );
  for (const query of ['slack', 'discord', 'webhook', 'channel notifications']) assert.deepEqual(searchSettings(query), []);
});

test('search finds a setting by name, pane or keyword, every word required', () => {
  assert.deepEqual(searchSettings(''), []);
  assert.deepEqual(searchSettings('  '), []);
  assert.deepEqual(searchSettings('jira epic'), [{ pane: 'connections', title: "This floor's Jira epic" }]);
  assert.deepEqual(searchSettings('JIRA'), [
    { pane: 'connections', title: 'Jira' },
    { pane: 'connections', title: "This floor's Jira epic" },
  ]);
  assert.deepEqual(searchSettings('hide models'), [{ pane: 'models', title: 'Models shown in pickers' }]);
  assert.deepEqual(searchSettings('subagent prompts'), [{ pane: 'workers', title: 'Prompts' }]);
  assert.deepEqual(searchSettings('droid sign in'), [{ pane: 'connections', title: 'Droid' }]);
  assert.deepEqual(searchSettings('host update'), [{ pane: 'office', title: 'Host desktop app' }]);
  assert.deepEqual(searchSettings('prompt chips'), []);
  assert.deepEqual(searchSettings('mouse'), [
    { pane: 'you', title: 'Look sensitivity' },
    { pane: 'you', title: 'Raw mouse input' },
  ]);
  assert.deepEqual(searchSettings('workspace folder'), [{ pane: 'office', title: 'Workspace folder' }]);
  assert.deepEqual(searchSettings('hot reload'), [{ pane: 'office', title: 'Source hot reload' }]);
  assert.deepEqual(searchSettings('factory key'), [{ pane: 'connections', title: 'Factory API key' }]);
  assert.deepEqual(searchSettings('there is no such setting'), []);
});

test('arrow keys move between categories and wrap, Home and End jump', () => {
  assert.equal(settingsPaneAfter('you', 'ArrowDown'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowRight'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowUp'), 'phone');
  assert.equal(settingsPaneAfter('you', 'ArrowLeft'), 'phone');
  assert.equal(settingsPaneAfter('workers', 'ArrowDown'), 'models');
  assert.equal(settingsPaneAfter('models', 'ArrowDown'), 'subagents');
  assert.equal(settingsPaneAfter('subagents', 'ArrowDown'), 'connections');
  assert.equal(settingsPaneAfter('phone', 'ArrowDown'), 'you');
  assert.equal(settingsPaneAfter('connections', 'ArrowDown'), 'office');
  assert.equal(settingsPaneAfter('office', 'ArrowDown'), 'phone');
  assert.equal(settingsPaneAfter('workers', 'ArrowUp'), 'graphics');
  assert.equal(settingsPaneAfter('sound', 'ArrowDown'), 'graphics');
  assert.equal(settingsPaneAfter('graphics', 'ArrowDown'), 'workers');
  assert.equal(settingsPaneAfter('sound', 'Home'), 'you');
  assert.equal(settingsPaneAfter('sound', 'End'), 'phone');
  assert.equal(settingsPaneAfter('you', 'Enter'), null);
  assert.equal(settingsPaneAfter('you', 'Escape'), null);
  assert.equal(settingsPaneAfter('models', 'a'), null);
});
