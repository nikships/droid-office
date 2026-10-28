import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CARDS, SETTINGS_PANES, resolveSettingsPane, searchSettings, settingsPaneAfter, type SettingsPane } from '../src/shared/settings-nav.js';

test('settings has the nine categories, grouped Personal / Workers / Office, in order', () => {
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.label),
    ['You', 'Sound', 'Display', 'Notifications', 'Workers', 'Subagents & visits', 'Connections', 'Office & floors', 'Phone & web'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.id),
    ['you', 'sound', 'graphics', 'notify', 'workers', 'subagents', 'connections', 'office', 'phone'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.section),
    ['Personal', 'Personal', 'Personal', 'Personal', 'Workers', 'Workers', 'Office', 'Office', 'Office'],
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
    ['Prompt chips', 'you'],
    ['Office sounds', 'sound'],
    ['Alert sounds', 'sound'],
    ['Jukebox', 'sound'],
    ['Renderer', 'graphics'],
    ['HDR', 'graphics'],
    ['Render resolution', 'graphics'],
    ['Temporal anti-aliasing', 'graphics'],
    ['Sharpening', 'graphics'],
    ['Frame rate limit', 'graphics'],
    ['Overhead lights', 'graphics'],
    ['Performance overlay', 'graphics'],
    ['Desktop notifications', 'notify'],
    ['Droid', 'workers'],
    ['Default worker', 'workers'],
    ['Models shown in pickers', 'workers'],
    ['Where fresh workers start', 'workers'],
    ['Prompts', 'workers'],
    ['Worker limit', 'workers'],
    ['Workers whose pull request merged', 'workers'],
    ['Worktree setup', 'workers'],
    ['Subagents', 'subagents'],
    ['Subagent worker', 'subagents'],
    ['Models leads can pick', 'subagents'],
    ['Team size', 'subagents'],
    ['Where subagents work', 'subagents'],
    ['Waking the lead', 'subagents'],
    ['Visits between workers', 'subagents'],
    ['Droid skill', 'subagents'],
    ['Whiteboard skill', 'subagents'],
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
  assert.equal(resolveSettingsPane('workers'), 'workers');
  assert.equal(resolveSettingsPane('you'), 'you');
  assert.equal(resolveSettingsPane('nope'), undefined);
  assert.equal(resolveSettingsPane(undefined), undefined);
});

test('notifications settings are personal and only offer desktop notifications', () => {
  assert.equal(SETTINGS_PANES.find((p) => p.id === 'notify')?.scope, 'Just you');
  assert.deepEqual(
    SETTINGS_CARDS.filter((c) => c.pane === 'notify').map((c) => c.title),
    ['Desktop notifications'],
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
  assert.deepEqual(searchSettings('hide models'), [{ pane: 'workers', title: 'Models shown in pickers' }]);
  assert.deepEqual(searchSettings('host update'), [{ pane: 'office', title: 'Host desktop app' }]);
  assert.deepEqual(searchSettings('prompt chips'), [{ pane: 'you', title: 'Prompt chips' }]);
  assert.deepEqual(searchSettings('mouse'), [
    { pane: 'you', title: 'Raw mouse input' },
    { pane: 'you', title: 'Look sensitivity' },
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
  assert.equal(settingsPaneAfter('workers', 'ArrowDown'), 'subagents');
  assert.equal(settingsPaneAfter('subagents', 'ArrowDown'), 'connections');
  assert.equal(settingsPaneAfter('phone', 'ArrowDown'), 'you');
  assert.equal(settingsPaneAfter('notify', 'ArrowDown'), 'workers');
  assert.equal(settingsPaneAfter('connections', 'ArrowDown'), 'office');
  assert.equal(settingsPaneAfter('office', 'ArrowDown'), 'phone');
  assert.equal(settingsPaneAfter('workers', 'ArrowUp'), 'notify');
  assert.equal(settingsPaneAfter('sound', 'ArrowDown'), 'graphics');
  assert.equal(settingsPaneAfter('graphics', 'ArrowDown'), 'notify');
  assert.equal(settingsPaneAfter('sound', 'Home'), 'you');
  assert.equal(settingsPaneAfter('sound', 'End'), 'phone');
  assert.equal(settingsPaneAfter('you', 'Enter'), null);
  assert.equal(settingsPaneAfter('you', 'Escape'), null);
  assert.equal(settingsPaneAfter('notify', 'a'), null);
});
