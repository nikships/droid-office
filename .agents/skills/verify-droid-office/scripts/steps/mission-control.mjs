// A no-credit integrated Mission Control check: real room, controls, companion and floor continuity.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export default async ({ page, js, shot, waitFor, out, url, log }) => {
  const proof = { feature: 'mission-control', steps: [], skipped: [] };
  const record = (id, result) => proof.steps.push({ id, ...result });
  const state = () => js(() => window.office.state());
  const setToggle = async (toggle, checked) => {
    if ((await toggle.isChecked()) !== checked) {
      await toggle.focus();
      await toggle.press('Space');
    }
    assert.equal(await toggle.isChecked(), checked);
  };
  await js(() => window.office.closeAll());
  const before = await state();
  assert.ok(before.agents, 'the office sends Mission Control');
  assert.ok(!before.workers.some((w) => w.id === 'orchestrator'), 'the Orchestrator takes no floor desk');

  await js(() => window.office.goTo('orchestrator'));
  await js(() => window.office.camera('first'));
  await shot('01-mission-room');
  const entered = await js(() => window.office.interact('E'));
  assert.match(entered.modals.at(-1)?.label ?? '', /Orchestrator/);
  record('mission-entry', { via: 'room E', window: entered.modals.at(-1)?.label });
  await shot('02-orchestrator-entry');
  await js(() => window.office.closeAll());
  await page.keyboard.press('m');
  await waitFor(() => window.office.state().modals.some((m) => /Orchestrator/.test(m.label)), undefined, 5_000);
  record('mission-entry', { via: 'M' });
  await js(() => window.office.closeAll());
  const menu = await js(() => window.office.open('orchestrator'));
  assert.match(menu.modals.at(-1)?.label ?? '', /Orchestrator/);
  record('mission-entry', { via: 'menu' });
  await js(() => window.office.closeAll());

  await js(() => window.office.open('settings'));
  await page.getByRole('tab', { name: /Orchestrator/ }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const toggle = settings.getByRole('checkbox', { name: 'Orchestrator', exact: true });
  const wasOn = await toggle.isChecked();
  const companion = await page.context().newPage();
  try {
    await setToggle(toggle, true);
    await waitFor(() => window.office.state().agents?.some((a) => a.id === 'orchestrator'), undefined, 10_000);
    await shot('03-orchestrator-settings');
    await companion.goto(new URL('/dashboard', url).href);
    const row = companion.locator('button.dash-row-open[data-worker="orchestrator"]');
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await row.click();
    await companion.locator('.dash-pane').filter({ hasText: 'Orchestrator' }).first().waitFor();
    await companion.screenshot({ path: path.join(out, '04-companion.png') });
    record('mission-companion', { row: await row.getAttribute('aria-label') });

    await setToggle(toggle, false);
    await waitFor(() => !window.office.state().agents?.some((a) => a.id === 'orchestrator'), undefined, 10_000);
    await companion.locator('.dash-mission-off').waitFor({ state: 'visible' });
    await shot('05-orchestrator-off');
    record('mission-shared', { on: false, companion: 'off' });
    await setToggle(toggle, true);
    await waitFor(() => window.office.state().agents?.some((a) => a.id === 'orchestrator'), undefined, 10_000);
    await row.waitFor({ state: 'visible' });
    await js(() => window.office.closeAll());

    const other = before.floors.find((f) => !f.here);
    if (other) {
      const rode = await js((id) => window.office.ride(id), other.id);
      assert.equal(rode.floor?.id, other.id);
      assert.ok(rode.agents?.some((a) => a.id === 'orchestrator'));
      await js(() => window.office.goTo('orchestrator'));
      await shot('06-another-floor');
      record('mission-shared', { floor: other.id, agent: 'orchestrator' });
    } else proof.skipped.push('mission-shared floor ride: only one floor is open');

    const bots = before.agents.filter((a) => a.remote);
    if (!bots.length) proof.skipped.push('mission-bots: the cloned office has no external bots');
    for (const bot of bots) {
      assert.ok(!(await state()).workers.some((w) => w.id === bot.id));
      const botRow = companion.locator(`button.dash-row-open[data-worker="${bot.id}"]`);
      await botRow.click();
      await companion.getByText('Runs externally', { exact: true }).last().waitFor();
      record('mission-bots', { id: bot.id, floorDesk: false, companion: await botRow.getAttribute('aria-label') });
    }
  } finally {
    await companion.close();
    await js(() => window.office.closeAll());
    await js(() => window.office.open('settings'));
    await page.getByRole('tab', { name: /Orchestrator/ }).click();
    await setToggle(page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('checkbox', { name: 'Orchestrator', exact: true }), wasOn);
    await js(() => window.office.closeAll());
  }
  writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  log(`proof ${path.join(out, 'proof.json')}`);
};
