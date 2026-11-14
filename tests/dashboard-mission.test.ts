import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  await page.setContent('<!doctype html><nav id="mission" class="dash-mission"></nav><div id="panes"></div><div id="modal-root"></div>');
  const styles = await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
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
    w.mission.orchestrator.team = w.mission.orchestrator.agent.team;
    w.roster = w.MissionUI.createMissionRoster(document.querySelector('#mission'), {
      open: (id: string) => w.calls.push(['open', id]),
      split: (id: string) => w.calls.push(['split', id]),
      member: (m: any) => w.calls.push(['member', m.id, m.floor]),
      settings: () => w.calls.push(['settings']),
    });
    w.repaintKeeps = (selector: string, repaint: () => void) => {
      const nodes = [...document.querySelectorAll(selector)];
      repaint();
      return nodes.length > 0 && nodes.every((n) => n.isConnected);
    };
    w.paintRoster = () => w.roster.update({ mission: w.mission, floor: 'f-web', focused: '', live: true, pane: () => -1, here: () => undefined, shortcut: '⌘ O' });
    w.paintRoster();
  });
  const roster = page.locator('#mission');
  const text = await roster.innerText();
  assert.match(text, /Mission Control/i);
  assert.match(text, /1 needs you/, 'a subagent’s question counts');
  assert.match(text, /Orchestrator[\s\S]*Get CI green on every floor/);
  assert.match(text, /OpenClaw[\s\S]*Runs externally[\s\S]*used 2m ago/i);
  assert.match(text, /2 subagents · 2 floors/);
  assert.equal(await roster.locator('.dash-mission-member.elsewhere').count(), 2, 'Dot and Nibble sit on another floor');
  assert.deepEqual(await roster.locator('.dash-mission-member .dash-row-floor').allInnerTexts(), ['web-app', 'api', 'api']);
  assert.equal(
    await page.evaluate(() => (window as any).repaintKeeps('#mission .dash-mission-caption, #mission .dash-team-toggle > span, #mission .dash-row-name', () => (window as any).paintRoster())),
    true,
    'a repaint with nothing new rebuilds nothing',
  );
  await roster.locator('[data-member=w-dot]').click();
  await roster.locator('[data-worker=orchestrator]').click();
  await roster.locator('[data-worker=bot-claw]').click();
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [
    ['member', 'w-dot', 'f-api'],
    ['open', 'orchestrator'],
    ['open', 'bot-claw'],
  ]);
  // The arrow keys walk each agent and its expanded team; only this floor's subagents open as they go.
  const walked = () => page.evaluate(() => (window as any).roster.visible().map((r: any) => [r.id, r.opens, r.button === (window as any).roster.button(r.id)]));
  assert.deepEqual(await walked(), [
    ['orchestrator', true, true],
    ['w-byte', true, true],
    ['w-dot', false, true],
    ['bot-claw', true, true],
    ['w-nib', false, true],
  ]);
  await roster.locator('.dash-team-toggle').first().click();
  assert.deepEqual(
    (await walked()).map(([id]) => id),
    ['orchestrator', 'bot-claw', 'w-nib'],
  );
  await roster.locator('.dash-team-toggle').first().click();

  // The section collapses without rebuilding rows or losing its live activity count.
  const toggle = roster.locator('.dash-mission-head');
  assert.equal(await toggle.getAttribute('aria-label'), 'Collapse Mission Control');
  const body = roster.locator('.dash-mission-body');
  const height = () => body.evaluate((el) => el.getBoundingClientRect().height);
  const expandedHeight = await height();
  assert.ok(expandedHeight > 0);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.getAttribute('aria-label'), 'Expand Mission Control');
  assert.equal(await body.evaluate((el) => (el as HTMLElement).inert), true);
  assert.deepEqual(await walked(), [], 'arrow navigation skips the collapsed section');
  assert.equal(await page.evaluate(() => (window as any).roster.button('orchestrator') === document.activeElement), true, 'sidebar focus returns to the heading while collapsed');
  await body.evaluate((el) => {
    for (const animation of el.getAnimations()) {
      animation.pause();
      animation.currentTime = 110;
    }
  });
  const middle = await height();
  assert.ok(middle > 0 && middle < expandedHeight, `height animates between endpoints: ${middle} / ${expandedHeight}`);
  await body.evaluate((el) => el.getAnimations().forEach((animation) => animation.finish()));
  assert.equal(await height(), 0);
  await page.evaluate(() => {
    const w = window as any;
    w.mission.orchestrator.agent.team[0].status = 'needs_input';
    w.paintRoster();
  });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'status ticks keep the collapsed state');
  assert.match(await roster.locator('.dash-mission-caption').innerText(), /2 needs? you/);
  await toggle.press('Enter');
  await page.waitForFunction(() => document.querySelector('.dash-mission-body')!.getAnimations().length === 0);
  assert.equal(await body.evaluate((el) => (el as HTMLElement).inert), false);
  assert.equal(await height(), expandedHeight);
  assert.equal((await walked()).length, 5);
  // Reverse an in-flight transition, then respect reduced motion.
  await toggle.evaluate((el: HTMLButtonElement) => {
    el.click();
    el.click();
  });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  assert.equal(await height(), 0);
  assert.equal(await body.evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
  await toggle.press('Space');
  assert.equal(await body.evaluate((el) => (el as HTMLElement).inert), false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await styles.evaluate((el) => el.remove());

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

  // After a new conversation there is no session, and its team is still its own.
  await page.evaluate(() => {
    const w = window as any;
    const { agent, ...rest } = w.mission.orchestrator;
    w.mission = { ...w.mission, orchestrator: { ...rest, settings: { on: true }, team: agent.team } };
    w.paintRoster();
  });
  assert.match(await roster.locator('[data-worker=orchestrator]').innerText(), /Ready for a task/);
  assert.match(await roster.locator('.dash-team-toggle').first().innerText(), /2 subagents · 2 floors/);
  assert.equal(await roster.locator('.dash-mission-agent').first().locator('.dash-mission-member').count(), 2, 'Byte and Dot are listed under it');

  // The Orchestrator's pane before its first prompt: what it's for, examples that fill the composer, a prompt that is its own message.
  await page.evaluate(() => {
    const w = window as any;
    w.calls = [];
    w.mission = { orchestrator: { settings: { on: true }, team: [] }, bots: w.mission.bots };
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

  // A session already running when something blocks a new start keeps its status, its composer and Stop.
  await page.evaluate(() => {
    const w = window as any;
    const worker = { ...w.MissionUI.orchestratorWorker({ orchestrator: { settings: { on: true } }, bots: [] }), status: 'working', sessionId: 's-1', task: { name: 'Get CI green on every floor' } };
    w.mission = { ...w.mission, orchestrator: { ...w.mission.orchestrator, agent: { worker, team: [] }, team: [] } };
    w.paintPane('orchestrator');
  });
  assert.equal(await pane.locator('.wt-blocked').isHidden(), true);
  assert.equal(await pane.locator('.wt-stop').isVisible(), true, 'Stop is reachable');
  assert.equal(await pane.locator('.dash-pane-head .pill').innerText(), 'working');
  assert.equal(await pane.locator('.dash-pane-task').innerText(), 'Get CI green on every floor');
  await page.evaluate(() => (window as any).paintRoster());
  assert.equal(await roster.locator('[data-worker=orchestrator] .dash-mission-mark').getAttribute('data-status'), 'working');
  assert.match(await roster.locator('[data-worker=orchestrator]').innerText(), /Get CI green on every floor/);

  // A bot: what it is and its team, no terminal; a subagent opens on its own floor.
  await page.evaluate(() => (window as any).paintPane('bot-claw', 'terminal'));
  assert.equal(await pane.getAttribute('data-mode'), 'info');
  assert.match(await pane.locator('.dash-bot').innerText(), /runs externally[\s\S]*Last used[\s\S]*2m ago[\s\S]*Nibble/);
  assert.equal(await pane.locator('.xterm').count(), 0);
  await pane.locator('.dash-bot-member').click();
  assert.ok((await page.evaluate(() => (window as any).calls)).some((c: any) => c[0] === 'across' && c[1] === 'w-nib' && c[2] === 'f-api'));
  assert.equal(
    await page.evaluate(() => (window as any).repaintKeeps('.dash-bot .dash-info-who > *, .dash-bot dd, .dash-bot-member', () => (window as any).paintPane('bot-claw', 'terminal'))),
    true,
    'a repaint with nothing new rebuilds nothing',
  );
  await page.evaluate(() => {
    const w = window as any;
    w.mission.bots[0].worker = { ...w.mission.bots[0].worker, activity: 'Planning the release' };
    w.paintPane('bot-claw', 'terminal');
  });
  assert.equal(await pane.locator('.dash-info-activity').innerText(), 'Planning the release');

  // Asleep, its session has no terminal to show: Thread stands in, and a prompt wakes it.
  await page.evaluate(() => {
    const w = window as any;
    w.mission = { orchestrator: { settings: { on: true }, agent: { worker: { ...w.mission.orchestrator.agent.worker, status: 'exited' }, team: [] }, team: [] }, bots: w.mission.bots };
    w.paintPane('orchestrator', 'terminal');
  });
  assert.equal(await pane.getAttribute('data-mode'), 'thread');
  assert.equal(await pane.locator('.dash-pane-views').isHidden(), true, 'no TTY to switch to');
  assert.equal(await pane.locator('textarea.wt-input').isDisabled(), false, 'a prompt wakes it');
  await page.evaluate(() => {
    const w = window as any;
    w.mission.orchestrator.agent.worker = { ...w.mission.orchestrator.agent.worker, status: 'idle' };
    w.paintPane('orchestrator', 'terminal');
  });
  assert.equal(await pane.getAttribute('data-mode'), 'terminal', 'awake, its terminal opens');

  // A subagent's pane: the strip across the top is its lead's team across floors.
  await page.evaluate(() => {
    const w = window as any;
    const team = [
      { id: 'w-byte', name: 'Byte', floor: 'f-web', floorName: 'web-app', status: 'working', activity: 'Fixing the flaky test' },
      { id: 'w-dot', name: 'Dot', floor: 'f-api', floorName: 'api', status: 'working' },
    ];
    w.mission.orchestrator.agent = { ...w.mission.orchestrator.agent, team };
    w.byte = { id: 'w-byte', name: 'Byte', kind: 'agent', color: '#4dbed4', deskId: 'd-1', status: 'working', acked: true, lead: 'orchestrator', createdBy: '', createdAt: 0, cols: 120, rows: 40, open: true };
    w.paintByte = () => w.pane.update({ worker: w.byte, view: 'thread', focused: true, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false });
    w.paintByte();
  });
  assert.deepEqual(await pane.locator('.dash-team-nav .dash-team-chip-name').allInnerTexts(), ['Orchestrator', 'Byte', 'Dot']);
  assert.deepEqual(await pane.locator('.dash-team-nav .dash-team-chip-floor').allInnerTexts(), ['api'], 'only the subagent elsewhere is tagged');
  const keeps = await page.evaluate(() => {
    const w = window as any;
    return w.repaintKeeps('.dash-team-nav .dash-team-chip', () => {
      w.mission.orchestrator.agent.team[0].activity = 'Running the tests';
      w.paintByte();
    });
  });
  assert.equal(keeps, true, 'activity the strip doesn’t show rebuilds nothing');
  await pane.locator('.dash-team-nav [data-member=w-dot]').click();
  assert.ok((await page.evaluate(() => (window as any).calls)).some((c: any) => c[0] === 'across' && c[1] === 'w-dot' && c[2] === 'f-api'));
  assert.deepEqual(errors, []);
});
