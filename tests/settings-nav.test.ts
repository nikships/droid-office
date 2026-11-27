import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CARDS, SETTINGS_PANES, initialSettingsPane, resolveSettingsPane, searchSettings, settingsCards, settingsPaneAfter, settingsPanes, type SettingsPane } from '../src/shared/settings-nav.js';

test('settings has the thirteen categories, grouped Personal / Workers / Office, in order', () => {
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.label),
    ['You', 'Sound & alerts', 'Display', 'Appearance', 'Thread', 'Terminal', 'Workers', 'Models', 'Subagents & visits', 'Orchestrator', 'Connections', 'Office & floors', 'Phone & web'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.id),
    ['you', 'sound', 'graphics', 'appearance', 'thread', 'terminal', 'workers', 'models', 'subagents', 'orchestrator', 'connections', 'office', 'phone'],
  );
  assert.deepEqual(
    SETTINGS_PANES.map((p) => p.section),
    ['Personal', 'Personal', 'Personal', 'Personal', 'Personal', 'Personal', 'Workers', 'Workers', 'Workers', 'Workers', 'Office', 'Office', 'Office'],
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
    ['Theme', 'appearance'],
    ['Wallpaper', 'appearance'],
    ['Glass', 'appearance'],
    ['Motion', 'appearance'],
    ['Restore Appearance defaults', 'appearance'],
    ['Text size', 'thread'],
    ['Font', 'thread'],
    ['Spacing', 'thread'],
    ['Column width', 'thread'],
    ['Work between replies', 'thread'],
    ['Tool calls', 'thread'],
    ['Thinking', 'thread'],
    ['Restore Thread defaults', 'thread'],
    ['Terminal text size', 'terminal'],
    ['Line spacing', 'terminal'],
    ['Cursor shape', 'terminal'],
    ['Cursor blink', 'terminal'],
    ['Scroll speed', 'terminal'],
    ['Option key', 'terminal'],
    ['Restore Terminal defaults', 'terminal'],
    ['Shell prompt integration', 'terminal'],
    ['Worker labels', 'workers'],
    ['Where fresh workers start', 'workers'],
    ['Prompts', 'workers'],
    ['Bundled skills', 'workers'],
    ['Worker limit', 'workers'],
    ['Workers whose pull request merged', 'workers'],
    ['Worktree setup', 'workers'],
    ['Default worker', 'models'],
    ['Remember models at desks', 'models'],
    ['Hide native Factory models', 'models'],
    ['Models shown in pickers', 'models'],
    ['Subagents', 'subagents'],
    ['Office MCP', 'subagents'],
    ['Subagent worker', 'subagents'],
    ['Models leads can pick', 'subagents'],
    ['Team size', 'subagents'],
    ['Where subagents work', 'subagents'],
    ['Waking the lead', 'subagents'],
    ['Droid’s Task tool', 'subagents'],
    ['Visits between workers', 'subagents'],
    ['Orchestrator', 'orchestrator'],
    ['Orchestrator model', 'orchestrator'],
    ['New conversation', 'orchestrator'],
    ['Orchestrator brief', 'orchestrator'],
    ['Droid', 'connections'],
    ['Factory API key', 'connections'],
    ['DroidProxy', 'connections'],
    ['Accounts', 'connections'],
    ['Models in Droid', 'connections'],
    ['Artificial Analysis', 'connections'],
    ['Gemini Decisions API', 'connections'],
    ['Linear', 'connections'],
    ["This floor's Linear team", 'connections'],
    ['Linear autopilot', 'connections'],
    ['Jira', 'connections'],
    ["This floor's Jira epic", 'connections'],
    ['Outside', 'office'],
    ['Workspace folder', 'office'],
    ['Host desktop app', 'office'],
    ['Source hot reload', 'office'],
    ['Droid Office for Android', 'phone'],
    ['Web companion', 'phone'],
    ['Share links', 'phone'],
    ['Tailscale MCP', 'phone'],
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
  assert.deepEqual(searchSettings('who can hire'), [], 'the retired dedicated-vs-ordinary hiring choice is not searchable');
  assert.deepEqual(searchSettings(''), []);
  assert.deepEqual(searchSettings('  '), []);
  assert.deepEqual(searchSettings('jira epic'), [{ pane: 'connections', title: "This floor's Jira epic" }]);
  assert.deepEqual(searchSettings('JIRA'), [
    { pane: 'connections', title: 'Jira' },
    { pane: 'connections', title: "This floor's Jira epic" },
  ]);
  assert.deepEqual(searchSettings('hide models'), [
    { pane: 'models', title: 'Hide native Factory models' },
    { pane: 'models', title: 'Models shown in pickers' },
  ]);
  assert.deepEqual(searchSettings('native factory'), [{ pane: 'models', title: 'Hide native Factory models' }]);
  assert.deepEqual(searchSettings('droidproxy models'), [
    { pane: 'models', title: 'Hide native Factory models' },
    { pane: 'connections', title: 'Models in Droid' },
  ]);
  assert.deepEqual(searchSettings('subagent prompts'), [{ pane: 'workers', title: 'Prompts' }]);
  assert.deepEqual(searchSettings('droid sign in'), [{ pane: 'connections', title: 'Droid' }]);
  assert.deepEqual(searchSettings('host update'), [{ pane: 'office', title: 'Host desktop app' }]);
  assert.deepEqual(searchSettings('prompt chips'), []);
  assert.deepEqual(searchSettings('office mcp'), [
    { pane: 'subagents', title: 'Office MCP' },
    { pane: 'phone', title: 'Tailscale MCP' },
  ]);
  assert.deepEqual(searchSettings('openclaw'), [{ pane: 'phone', title: 'Tailscale MCP' }]);
  assert.deepEqual(searchSettings('whiteboard'), [{ pane: 'subagents', title: 'Office MCP' }]);
  assert.deepEqual(searchSettings('skill'), [{ pane: 'workers', title: 'Bundled skills' }]);
  assert.deepEqual(searchSettings('mouse'), [
    { pane: 'you', title: 'Look sensitivity' },
    { pane: 'you', title: 'Raw mouse input' },
  ]);
  assert.deepEqual(searchSettings('workspace folder'), [{ pane: 'office', title: 'Workspace folder' }]);
  assert.deepEqual(searchSettings('hot reload'), [{ pane: 'office', title: 'Source hot reload' }]);
  assert.deepEqual(searchSettings('factory key'), [{ pane: 'connections', title: 'Factory API key' }]);
  assert.deepEqual(searchSettings('benchmarks'), [{ pane: 'connections', title: 'Artificial Analysis' }]);
  assert.deepEqual(searchSettings('new conversation'), [{ pane: 'orchestrator', title: 'New conversation' }]);
  assert.deepEqual(searchSettings('orchestrator model'), [{ pane: 'orchestrator', title: 'Orchestrator model' }]);
  assert.deepEqual(searchSettings('scroll speed'), [{ pane: 'terminal', title: 'Scroll speed' }]);
  assert.deepEqual(searchSettings('tty cursor'), [
    { pane: 'terminal', title: 'Cursor shape' },
    { pane: 'terminal', title: 'Cursor blink' },
    { pane: 'terminal', title: 'Restore Terminal defaults' },
  ]);
  assert.deepEqual(searchSettings('alt meta'), [{ pane: 'terminal', title: 'Option key' }]);
  assert.deepEqual(searchSettings('zsh marks'), [{ pane: 'terminal', title: 'Shell prompt integration' }]);
  assert.deepEqual(searchSettings('there is no such setting'), []);
});

test('arrow keys move between categories and wrap, Home and End jump', () => {
  assert.equal(settingsPaneAfter('you', 'ArrowDown'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowRight'), 'sound');
  assert.equal(settingsPaneAfter('you', 'ArrowUp'), 'phone');
  assert.equal(settingsPaneAfter('you', 'ArrowLeft'), 'phone');
  assert.equal(settingsPaneAfter('workers', 'ArrowDown'), 'models');
  assert.equal(settingsPaneAfter('models', 'ArrowDown'), 'subagents');
  assert.equal(settingsPaneAfter('subagents', 'ArrowDown'), 'orchestrator');
  assert.equal(settingsPaneAfter('orchestrator', 'ArrowDown'), 'connections');
  assert.equal(settingsPaneAfter('phone', 'ArrowDown'), 'you');
  assert.equal(settingsPaneAfter('connections', 'ArrowDown'), 'office');
  assert.equal(settingsPaneAfter('office', 'ArrowDown'), 'phone');
  assert.equal(settingsPaneAfter('workers', 'ArrowUp'), 'terminal');
  assert.equal(settingsPaneAfter('sound', 'ArrowDown'), 'graphics');
  assert.equal(settingsPaneAfter('graphics', 'ArrowDown'), 'thread', 'the office has no Appearance pane');
  assert.equal(settingsPaneAfter('thread', 'ArrowDown'), 'terminal');
  assert.equal(settingsPaneAfter('terminal', 'ArrowDown'), 'workers');
  assert.equal(settingsPaneAfter('sound', 'Home'), 'you');
  assert.equal(settingsPaneAfter('sound', 'End'), 'phone');
  assert.equal(settingsPaneAfter('you', 'Enter'), null);
  assert.equal(settingsPaneAfter('you', 'Escape'), null);
  assert.equal(settingsPaneAfter('models', 'a'), null);
});

test('the companions leave out what only the 3D office has, and a browser’s Phone & web holds only share links', () => {
  assert.deepEqual(
    settingsPanes('office').map((p) => p.id),
    SETTINGS_PANES.map((p) => p.id).filter((id) => id !== 'appearance'),
  );
  assert.deepEqual(
    settingsPanes('companion').map((p) => p.label),
    ['Appearance', 'Thread', 'Terminal', 'Workers', 'Models', 'Subagents & visits', 'Orchestrator', 'Connections', 'Office & floors', 'Phone & web'],
  );
  assert.deepEqual(
    settingsPanes('mac-companion').map((p) => p.label),
    ['Appearance', 'Thread', 'Terminal', 'Workers', 'Models', 'Subagents & visits', 'Orchestrator', 'Connections', 'Office & floors', 'Phone & web'],
  );
  const officeOnly = [
    'Your character',
    'What 7 puts in your hand',
    'Look sensitivity',
    'Raw mouse input',
    'Office sounds',
    'Jukebox',
    'Alert sounds',
    'Desktop notifications',
    'Renderer',
    'HDR',
    'Render resolution',
    'Temporal anti-aliasing',
    'Sharpening',
    'Frame rate limit',
    'Performance overlay',
    'Overhead lights',
    'Remember models at desks',
    'Linear',
    "This floor's Linear team",
    'Linear autopilot',
    'Jira',
    "This floor's Jira epic",
    'Outside',
    'Source hot reload',
  ];
  const phone = ['Droid Office for Android', 'Web companion', 'Tailscale MCP'];
  const appearance = ['Theme', 'Wallpaper', 'Glass', 'Motion', 'Restore Appearance defaults'];
  const titles = (surface: 'office' | 'companion' | 'mac-companion') => settingsCards(surface).map((c) => c.title as string);
  assert.deepEqual(
    titles('office'),
    SETTINGS_CARDS.map((c) => c.title as string).filter((t) => !appearance.includes(t)),
  );
  assert.deepEqual(
    titles('companion'),
    SETTINGS_CARDS.map((c) => c.title as string).filter((t) => !officeOnly.includes(t) && !phone.includes(t)),
  );
  assert.deepEqual(
    titles('mac-companion'),
    SETTINGS_CARDS.map((c) => c.title as string).filter((t) => !officeOnly.includes(t)),
  );
  for (const kept of [
    ...appearance,
    'Text size',
    'Tool calls',
    'Restore Thread defaults',
    'Terminal text size',
    'Scroll speed',
    'Restore Terminal defaults',
    'Shell prompt integration',
    'Workspace folder',
    'Host desktop app',
    'Droid',
    'Factory API key',
    'Gemini Decisions API',
    'DroidProxy',
    'Worktree setup',
    'Default worker',
  ])
    assert.ok(titles('companion').includes(kept), kept);
  assert.deepEqual(
    settingsCards('companion')
      .filter((c) => c.pane === 'phone')
      .map((c) => c.title),
    ['Share links'],
  );
  for (const surface of ['office', 'mac-companion'] as const) assert.ok(titles(surface).includes('Share links'), surface);
});

test('a companion’s blurbs only promise what it shows', () => {
  for (const surface of ['companion', 'mac-companion'] as const) {
    const blurb = new Map(settingsPanes(surface).map((p) => [p.id, p.blurb]));
    assert.doesNotMatch(blurb.get('connections') ?? '', /jira/i);
    assert.doesNotMatch(blurb.get('office') ?? '', /sky|developer/i);
    assert.equal(blurb.get('workers'), SETTINGS_PANES.find((p) => p.id === 'workers')?.blurb);
  }
  const phone = (surface: 'office' | 'companion' | 'mac-companion') => settingsPanes(surface).find((p) => p.id === 'phone')?.blurb ?? '';
  assert.doesNotMatch(phone('companion'), /android|tailscale devices|bots/i);
  assert.match(phone('companion'), /share links/i);
  assert.match(phone('mac-companion'), /Android/);
  assert.match(settingsPanes('office').find((p) => p.id === 'connections')?.blurb ?? '', /Jira/);
});

test('a companion’s search and arrow keys stay among its own settings', () => {
  assert.deepEqual(searchSettings('jira', 'companion'), []);
  assert.deepEqual(searchSettings('volume', 'companion'), []);
  assert.deepEqual(searchSettings('outside', 'companion'), []);
  assert.deepEqual(searchSettings('hot reload', 'companion'), []);
  assert.deepEqual(searchSettings('hide models', 'companion'), [
    { pane: 'models', title: 'Hide native Factory models' },
    { pane: 'models', title: 'Models shown in pickers' },
  ]);
  assert.deepEqual(searchSettings('host update', 'companion'), [{ pane: 'office', title: 'Host desktop app' }]);
  assert.deepEqual(searchSettings('openclaw', 'companion'), []);
  assert.deepEqual(searchSettings('guest link', 'companion'), [{ pane: 'phone', title: 'Share links' }]);
  assert.deepEqual(searchSettings('revoke share'), [{ pane: 'phone', title: 'Share links' }]);
  assert.deepEqual(searchSettings('wallpaper', 'companion'), [
    { pane: 'appearance', title: 'Wallpaper' },
    { pane: 'appearance', title: 'Restore Appearance defaults' },
  ]);
  assert.deepEqual(searchSettings('wallpaper'), [], 'the 3D office draws its own world');
  assert.deepEqual(searchSettings('upload picture', 'mac-companion'), [{ pane: 'appearance', title: 'Wallpaper' }]);
  assert.deepEqual(searchSettings('openclaw', 'mac-companion'), [{ pane: 'phone', title: 'Tailscale MCP' }]);
  assert.deepEqual(searchSettings('office mcp', 'companion'), [{ pane: 'subagents', title: 'Office MCP' }]);

  assert.equal(settingsPaneAfter('workers', 'ArrowUp', 'companion'), 'terminal');
  assert.equal(settingsPaneAfter('thread', 'ArrowUp', 'companion'), 'appearance');
  assert.equal(settingsPaneAfter('appearance', 'ArrowUp', 'companion'), 'phone');
  assert.equal(settingsPaneAfter('office', 'ArrowDown', 'companion'), 'phone');
  assert.equal(settingsPaneAfter('phone', 'ArrowDown', 'companion'), 'appearance');
  assert.equal(settingsPaneAfter('office', 'ArrowDown', 'mac-companion'), 'phone');
  assert.equal(settingsPaneAfter('phone', 'ArrowDown', 'mac-companion'), 'appearance');
  assert.equal(settingsPaneAfter('models', 'Home', 'companion'), 'appearance');
  assert.equal(settingsPaneAfter('models', 'End', 'companion'), 'phone');
  assert.equal(settingsPaneAfter('models', 'End', 'mac-companion'), 'phone');
  assert.equal(settingsPaneAfter('you', 'ArrowDown', 'companion'), null, 'a pane the surface lacks moves nowhere');
  assert.equal(settingsPaneAfter('you', 'ArrowUp', 'companion'), null);
});

test('initialSettingsPane selects focusCard’s registered pane before first or remembered panes, respecting surface', () => {
  // Without first, focusCard opens its own registered pane rather than the remembered pane.
  assert.equal(initialSettingsPane({ surface: 'office', focusCard: 'Gemini Decisions API', remembered: 'you' }), 'connections');
  // Even when first names a different pane, focusCard wins so its row is never left in a hidden pane.
  assert.equal(initialSettingsPane({ surface: 'office', first: 'you', focusCard: 'Gemini Decisions API', remembered: 'sound' }), 'connections');
  assert.equal(initialSettingsPane({ surface: 'companion', first: 'workers', focusCard: 'Gemini Decisions API', remembered: 'models' }), 'connections');

  // When focusCard is not offered on the surface (e.g. Linear on web companion), falls back cleanly to first -> remembered -> first pane.
  assert.equal(initialSettingsPane({ surface: 'companion', first: 'models', focusCard: 'Linear', remembered: 'office' }), 'models');
  assert.equal(initialSettingsPane({ surface: 'companion', focusCard: 'Linear', remembered: 'office' }), 'office');
  assert.equal(initialSettingsPane({ surface: 'companion', focusCard: 'Linear', remembered: 'you' }), 'appearance');
  assert.equal(initialSettingsPane({ surface: 'office', first: 'appearance' }), 'you', 'the office has no Appearance pane');

  // Without focusCard, preserves first -> remembered -> surface's first pane.
  assert.equal(initialSettingsPane({ surface: 'office', first: 'graphics', remembered: 'you' }), 'graphics');
  assert.equal(initialSettingsPane({ surface: 'office', remembered: 'sound' }), 'sound');
  assert.equal(initialSettingsPane({ surface: 'office' }), 'you');
});
