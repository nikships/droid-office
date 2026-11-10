import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('Mission Control pins the building’s agents in the sidebar and opens the Orchestrator and bots in panes', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: "export { createMissionRoster } from './dashboard-mission'; export { createPane } from './dashboard-pane'; export { orchestratorWorker, missionWorker, ORCHESTRATOR_EXAMPLES } from './mission';",
      resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'MissionUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><nav id="mission"></nav><div id="panes"></div><div id="modal-root"></div>');
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.calls = [];
    const agent = (over: any) => ({ kind: 'agent', color: '#ee6018', deskId: '', status: 'idle', acked: true, createdBy: '', createdAt: 0, cols: 120, rows: 40, open: true, ...over });
    w.mission = {
      orchestrator: {
        settings: { on: true, model: 'custom:droidproxy:opus-5-5', effort: 'high' },
        agent: {
          worker: agent({ id: 'orchestrator', name: 'Orchestrator', status: 'working', sessionId: 's-1', task: { name: 'Get CI green on every floor' } }),
          team: [
            { id: 'w-byte', name: 'Byte', floor: 'f-web', floorName: 'web-app', status: 'working', activity: 'Fixing the flaky test' },
            { id: 'w-dot', name: 'Dot', floor: 'f-api', floorName: 'api', status: 'needs_input', activity: 'Which branch?' },
          ],
        },
      },
      bots: [
        {
          worker: agent({ id: 'bot-claw', name: 'OpenClaw', remote: true, status: 'working', activity: 'Reading its inbox', color: '#4dbed4' }),
          team: [{ id: 'w-nib', name: 'Nibble', floor: 'f-api', floorName: 'api', status: 'working' }],
          lastUsedAt: Date.now() - 120_000,
        },
      ],
    };
    w.roster = w.MissionUI.createMissionRoster(document.querySelector('#mission'), {
      open: (id: string) => w.calls.push(['open', id]),
      split: (id: string) => w.calls.push(['split', id]),
      member: (m: any) => w.calls.push(['member', m.id, m.floor]),
      settings: () => w.calls.push(['settings']),
    });
    w.paintRoster = () => w.roster.update({ mission: w.mission, floor: 'f-web', focused: '', live: true, pane: () => -1, here: () => undefined, shortcut: '⌘ O' });
    w.paintRoster();
  });
  const roster = page.locator('#mission');
  const text = await roster.innerText();
  assert.match(text, /Mission Control/);
  assert.match(text, /1 needs you/, 'a subagent’s question counts');
  assert.match(text, /Orchestrator[\s\S]*Get CI green on every floor/);
  assert.match(text, /OpenClaw[\s\S]*Runs externally[\s\S]*used 2m ago/);
  assert.match(text, /2 subagents · 2 floors/);
  assert.equal(await roster.locator('.dash-mission-member.elsewhere').count(), 2, 'Dot and Nibble sit on another floor');
  assert.deepEqual(await roster.locator('.dash-mission-member .dash-row-floor').allInnerTexts(), ['web-app', 'api', 'api']);
  await roster.locator('[data-member=w-dot]').click();
  await roster.locator('[data-worker=orchestrator]').click();
  await roster.locator('[data-worker=bot-claw]').click();
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [
    ['member', 'w-dot', 'f-api'],
    ['open', 'orchestrator'],
    ['open', 'bot-claw'],
  ]);
  assert.deepEqual(await page.evaluate(() => (window as any).roster.visible()), ['orchestrator', 'w-byte', 'w-dot', 'bot-claw', 'w-nib']);
  await roster.locator('.dash-team-toggle').first().click();
  assert.deepEqual(await page.evaluate(() => (window as any).roster.visible()), ['orchestrator', 'bot-claw', 'w-nib']);
  await roster.locator('.dash-team-toggle').first().click();
  await page.evaluate(() => {
    const w = window as any;
    w.calls = [];
    w.mission.orchestrator.agent.team[1].activity = 'Still waiting';
    w.paintRoster();
  });
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [], 'status updates never replay member navigation');
  await page.evaluate(() => (window as any).roster.button('w-dot').click());
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [['member', 'w-dot', 'f-api']], 'keyboard activation uses the member’s own floor');

  // Off: one row that points to Settings, and its team is nobody's.
  await page.evaluate(() => {
    const w = window as any;
    w.calls = [];
    w.mission = { ...w.mission, orchestrator: { ...w.mission.orchestrator, settings: { on: false } } };
    w.paintRoster();
  });
  assert.equal(await roster.locator('[data-worker=orchestrator]').count(), 0);
  await roster.locator('.dash-mission-off').click();
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [['settings']]);

  // The Orchestrator's pane before its first prompt: what it's for, examples that fill the composer, a prompt that is its own message.
  await page.evaluate(() => {
    const w = window as any;
    w.calls = [];
    w.mission = { orchestrator: { settings: { on: true } }, bots: w.mission.bots };
    const net = {
      send: (msg: any) => (w.calls.push(['send', msg.t]), true),
      onMessage: () => () => {},
      request: async (msg: any) => (w.calls.push(['request', msg.t]), { ok: true }),
    };
    const host = {
      net,
      live: () => true,
      floor: () => 'f-web',
      busy: () => false,
      read: () => '',
      remember() {},
      focus() {},
      usable: () => true,
      action: async (msg: any) => {
        w.calls.push(['action', msg]);
      },
      worker: (id: string) => w.MissionUI.missionWorker(w.mission, id),
      mission: () => w.mission,
      openAcross: (id: string, floor: string) => w.calls.push(['across', id, floor]),
      resetOrchestrator: () => w.calls.push(['reset']),
      settings: (pane: string) => w.calls.push(['settings', pane]),
      setView: (id: string, view: string) => w.calls.push(['view', id, view]),
      terminal: async () => ({ openTerminal: () => ({ close() {}, attach() {}, focus() {} }) }),
    };
    w.pane = w.MissionUI.createPane(host, 0);
    document.querySelector('#panes')!.append(w.pane.el);
    w.paintPane = (id: string, view = 'thread') =>
      w.pane.update({ worker: w.MissionUI.missionWorker(w.mission, id), view, focused: true, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false });
    w.paintPane('orchestrator');
  });
  const pane = page.locator('.dash-pane');
  assert.equal(await pane.getAttribute('data-mode'), 'thread');
  assert.equal(await pane.locator('.orc-intro').count(), 1);
  assert.equal(await pane.locator('.orc-example').count(), 3);
  assert.equal(await pane.locator('.dash-pane-views').isHidden(), true, 'no TTY before there is a session');
  assert.equal(await pane.locator('.dash-home').count(), 0, 'nothing to send home');
  assert.equal(await pane.locator('.dash-orc-reset').isDisabled(), true, 'no conversation to start over yet');
  assert.equal(await pane.locator('.dash-pane-task').innerText(), 'Ready for a task anywhere in the building');
  const example = await page.evaluate(() => (window as any).MissionUI.ORCHESTRATOR_EXAMPLES[2]);
  await pane.locator('.orc-example').nth(2).click();
  assert.equal(await pane.locator('textarea.wt-input').inputValue(), example);
  await pane.locator('textarea.wt-input').press('Enter');
  await page.waitForFunction(() => (window as any).calls.some((c: any) => c[0] === 'action'));
  const sent = await page.evaluate(() => (window as any).calls.find((c: any) => c[0] === 'action')[1]);
  assert.deepEqual(sent, { t: 'orchestrator.prompt', prompt: example });
  await pane.locator('.dash-orc-settings').click();
  assert.ok((await page.evaluate(() => (window as any).calls)).some((c: any) => c[0] === 'settings' && c[1] === 'orchestrator'));

  // Blocked: why, in place of the composer, with the way to fix it beside it.
  await page.evaluate(() => {
    const w = window as any;
    w.mission = { ...w.mission, orchestrator: { ...w.mission.orchestrator, blocked: 'Droid is signed out. Sign in from Settings → Connections.' } };
    w.paintPane('orchestrator');
  });
  assert.equal(await pane.locator('.wt-blocked').isVisible(), true);
  assert.match(await pane.locator('.wt-blocked').innerText(), /Droid is signed out/);
  assert.equal(await pane.locator('form').first().isHidden(), true);
  assert.equal(await pane.locator('.dash-pane-head .pill').innerText(), 'blocked');
  assert.equal(await pane.locator('.dash-pane-task').innerText(), 'Can’t start yet', 'the reason is said once, in place of the composer');
  assert.equal(await pane.locator('.orc-example:disabled').count(), 3, 'no composer to fill');

  // A bot: what it is and its team, no terminal; a subagent opens on its own floor.
  await page.evaluate(() => (window as any).paintPane('bot-claw', 'terminal'));
  assert.equal(await pane.getAttribute('data-mode'), 'info');
  assert.match(await pane.locator('.dash-bot').innerText(), /runs externally[\s\S]*Last used[\s\S]*2m ago[\s\S]*Nibble/);
  assert.equal(await pane.locator('.xterm').count(), 0);
  await pane.locator('.dash-bot-member').click();
  assert.ok((await page.evaluate(() => (window as any).calls)).some((c: any) => c[0] === 'across' && c[1] === 'w-nib' && c[2] === 'f-api'));
  assert.deepEqual(errors, []);
});
