// Hires a Shell worker at a free desk with B, runs a command in it through its P window, reads the
// result in its terminal (E) and in the web companion, then sends it home with X.
//   .agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/hire-shell.mjs hire-shell
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export default async ({ page, js, shot, waitFor, sleep, log, out, url }) => {
  const marker = `verify-${Date.now().toString(36)}`;
  const sideEffect = path.join(out, 'shell-wrote.txt');
  const proof = { marker, steps: [] };
  const step = (what, value) => {
    proof.steps.push({ what, ...value });
    log(`step ${what} ${JSON.stringify(value)}`);
  };
  const state = () => js(() => window.office.state());

  await js(() => window.office.closeAll());
  const desk = await js(() => {
    const taken = new Set(window.office.state().workers.map((w) => w.deskId));
    return window.office.list().find((t) => t.kind === 'desk' && !t.worker && !taken.has(t.id))?.id;
  });
  if (!desk) throw new Error('no free desk on this floor: send a worker home or ride to another floor');
  const before = await state();
  step('free desk', { desk, floor: before.floor, workers: before.workers.length });
  await js((d) => window.office.goTo(d), desk);
  await js(() => window.office.camera('first'));
  await shot('01-free-desk');

  await js(() => window.office.interact('B'));
  await waitFor((d) => window.office.state().workers.some((w) => w.deskId === d && w.kind === 'shell'), desk, 30_000);
  const worker = (await state()).workers.find((w) => w.deskId === desk);
  step('hired shell', worker);
  await shot('02-shell-hired');

  await js(() => window.office.interact('P'));
  const runWindow = page.locator(`[role=dialog][aria-label="🐚 Run in ${worker.name}"]`);
  await runWindow.waitFor({ timeout: 10_000 });
  await runWindow.locator('textarea[aria-label=Prompt]').fill(`echo ${marker} | tee ${sideEffect}`);
  await shot('03-run-window');
  await runWindow.locator('button[type=submit]').click();
  await waitFor(() => !document.querySelector(`[role=dialog][aria-label^="🐚 Run in"]`), undefined, 5_000);

  const t0 = Date.now();
  while (!existsSync(sideEffect) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 250));
  const wrote = existsSync(sideEffect) ? readFileSync(sideEffect, 'utf8').trim() : null;
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
    const row = companion.locator(`button.dash-row-open[data-worker="${worker.id}"]`);
    await row.waitFor({ timeout: 30_000 });
    step('web companion lists worker', { label: await row.getAttribute('aria-label') });
    await companion.screenshot({ path: path.join(out, '05-web-companion.png') });
    log(`shot ${path.join(out, '05-web-companion.png')}`);
  } finally {
    await companion.close();
  }

  await js((d) => window.office.goTo(d), desk);
  await js(() => window.office.interact('X'));
  const confirm = page.locator(`[role=alertdialog][aria-label="Send ${worker.name} home?"]`);
  await confirm.waitFor({ timeout: 10_000 });
  await sleep(500);
  await shot('06-send-home');
  await confirm.locator('button', { hasText: 'Send home' }).click();
  await waitFor((id) => !window.office.state().workers.some((w) => w.id === id), worker.id, 30_000);
  const after = await state();
  step('sent home', { workers: after.workers.length, deskFree: !after.workers.some((w) => w.deskId === desk) });
  await shot('07-desk-free');

  writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  log(`proof ${path.join(out, 'proof.json')}`);
};
