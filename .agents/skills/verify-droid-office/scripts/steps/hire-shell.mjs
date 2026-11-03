// Hires a Shell worker at a free desk with B, runs a command in it through its P window, reads the
// result in its terminal (E) and in the web companion, then sends it home with X.
//   .agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/hire-shell.mjs hire-shell
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { freeShellDesk, hireShell, openShellRun, sendShellHome } from './shell-journey.mjs';
import { resetProbe, shellQuote, waitForProbe } from './shell-probe.mjs';

export default async (helpers) => {
  const { page, js, shot, waitFor, sleep, log, out, url } = helpers;
  const marker = `verify-${Date.now().toString(36)}`;
  const sideEffect = path.join(out, 'shell-wrote.txt');
  const proof = { marker, steps: [] };
  const step = (what, value) => {
    proof.steps.push({ what, ...value });
    log(`step ${what} ${JSON.stringify(value)}`);
  };
  const state = () => js(() => window.office.state());

  const desk = await freeShellDesk(js);
  const before = await state();
  step('free desk', { desk, floor: before.floor, workers: before.workers.length });
  await js(() => window.office.camera('first'));
  await shot('01-free-desk');

  const worker = await hireShell(helpers, desk);
  step('hired shell', worker);
  await shot('02-shell-hired');

  const runWindow = await openShellRun(helpers, worker);
  resetProbe(sideEffect);
  await runWindow.locator('textarea[aria-label=Prompt]').fill(`echo ${marker} | tee ${shellQuote(sideEffect)}`);
  await shot('03-run-window');
  await runWindow.locator('button[type=submit]').click();
  await waitFor(() => !document.querySelector(`[role=dialog][aria-label^="🐚 Run in"]`), undefined, 5_000);

  const wrote = await waitForProbe(sideEffect, (value) => value === marker);
  if (wrote !== marker) throw new Error(`the shell did not write ${marker} to ${sideEffect} (got ${JSON.stringify(wrote)})`);
  step('shell side effect', { file: sideEffect, content: wrote });

  const opened = await js(() => window.office.interact('E'));
  if (opened.terminal?.workerId !== worker.id) throw new Error(`E opened ${JSON.stringify(opened.terminal)}, not ${worker.name}'s terminal`);
  await waitFor((m) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(m), marker, 15_000);
  step('terminal shows output', { terminal: opened.terminal, modals: opened.modals });
  await shot('04-terminal');
  await js(() => window.office.closeAll());

  const companion = await page.context().newPage();
  try {
    await companion.goto(new URL('/dashboard', url).href);
    await companion.locator(`button.dash-floor-chip[data-floor="${before.floor.id}"]`).click({ timeout: 30_000 });
    const row = companion.locator(`button.dash-row-open[data-worker="${worker.id}"]`);
    await row.waitFor({ timeout: 30_000 });
    step('web companion lists worker', { label: await row.getAttribute('aria-label') });
    await companion.screenshot({ path: path.join(out, '05-web-companion.png') });
    log(`shot ${path.join(out, '05-web-companion.png')}`);
  } finally {
    await companion.close();
  }

  await sendShellHome(helpers, worker, async () => {
    await sleep(500);
    await shot('06-send-home');
  });
  const after = await state();
  step('sent home', { workers: after.workers.length, deskFree: !after.workers.some((w) => w.deskId === desk) });
  await shot('07-desk-free');

  writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  log(`proof ${path.join(out, 'proof.json')}`);
};
