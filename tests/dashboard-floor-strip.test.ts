import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { ClientMsg, FloorInfo, ServerMsg } from '../src/shared/protocol.js';

const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];

async function startOffice(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'companion-floor-strip-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'glab'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath ?? ''}`;
  const home = path.join(root, 'home');
  const office = path.join(home, 'office');
  mkdirSync(office, { recursive: true });
  const folders = GREEK.map((g) => {
    const dir = path.join(home, 'Projects', `${g}-customer-onboarding-runbooks`);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  const cfg = loadConfig(['--home', home, '--projects', path.join(home, 'Projects'), office, '--weather', 'clear', '--host', '127.0.0.1', '--agent', path.join(root, 'no-droid-agent')]);
  cfg.port = 0;
  cfg.homeFloor = home;
  cfg.remoteMcp = false;
  const server = await startServer(cfg);
  const port = (server.server.address() as AddressInfo).port;
  t.after(async () => {
    process.env.PATH = prevPath;
    const closing = once(server.server, 'close');
    await server.shutdown();
    server.server.closeAllConnections();
    await closing;
    rmSync(root, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, folders };
}

function connect(t: TestContext, base: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Desktop`, { origin: base });
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    for (const fn of listeners) fn();
  });
  function wait<T extends ServerMsg['t']>(type: T, predicate: (msg: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.findLast((m): m is Extract<ServerMsg, { t: T }> => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>));
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 8000);
      listeners.add(check);
      check();
    });
  }
  return { wait, send: (msg: ClientMsg) => ws.send(JSON.stringify(msg)) };
}

/** What the companion's floor strip shows: the tabs on screen, the "+N more" label, and whether anything is cut off or scrolls. */
function floorStrip(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('.dash-floor-bays');
    const deck = document.querySelector<HTMLElement>('.dash-top-lower');
    const more = document.querySelector<HTMLElement>('.dash-quiet-bay');
    if (!nav || !deck || !more) throw new Error('no floor strip');
    const shown = [...nav.querySelectorAll<HTMLElement>('.dash-floor-chip:not([hidden])')];
    const navRight = nav.getBoundingClientRect().right;
    const deckRight = deck.getBoundingClientRect().right;
    // No named helpers in here: tsx wraps them in a __name the page doesn't have.
    return {
      shown: shown.map((c) => c.querySelector('.dash-floor-name')?.textContent ?? ''),
      more: more.hidden ? '' : (more.querySelector('.dash-quiet-label')?.textContent ?? ''),
      clipped: shown.some((c) => c.getBoundingClientRect().right > navRight + 0.5 || [c, ...c.querySelectorAll<HTMLElement>('.dash-floor-name')].some((el) => el.scrollWidth > el.clientWidth + 0.5)),
      scrolls: nav.scrollWidth > nav.clientWidth + 0.5 || deck.scrollWidth > deck.clientWidth + 0.5,
      offscreen: [...deck.children].some((el) => !(el as HTMLElement).hidden && !el.classList.contains('dash-quiet-pop') && el.getBoundingClientRect().right > deckRight + 0.5),
    };
  });
}

/** The strip refits from a ResizeObserver, which runs on the frame after a resize. */
function settled(page: Page) {
  return page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const chromium = browserStatus();

test('the web companion fills its floor strip with the most relevant full tabs that fit, refitting live as the window resizes', { skip: chromium.installed ? false : `Chromium is not installed in ${chromium.path}` }, async (t) => {
  const fx = await startOffice(t);
  const desktop = connect(t, fx.base);
  await desktop.wait('welcome');
  const ids = new Map<string, string>();
  for (const dir of fx.folders) {
    desktop.send({ t: 'floor.add', dir });
    const added = await desktop.wait('floor.added', (m) => m.dir === dir);
    assert.ok(added.floor, added.error);
    ids.set(path.basename(dir), added.floor);
  }
  // Visit the last floor, then one in the middle: both now outrank the unvisited floors between them.
  const last = 'kappa-customer-onboarding-runbooks';
  const middle = 'eta-customer-onboarding-runbooks';
  for (const name of [last, middle]) {
    desktop.send({ t: 'floor.go', floor: ids.get(name) ?? '' });
    await desktop.wait('floor.enter', (m) => m.arrival.floor === ids.get(name));
  }
  const floors = (await desktop.wait('floors', (m) => m.floors.some((f) => f.id === ids.get(middle) && !!f.lastVisitedAt))).floors;
  const info = (name: string) => floors.find((f) => f.id === ids.get(name)) as FloorInfo;
  assert.ok((info(middle).lastVisitedAt ?? 0) >= (info(last).lastVisitedAt ?? 0), 'the office records each visit for ranking');
  assert.equal(info('alpha-customer-onboarding-runbooks').lastVisitedAt, undefined);
  const all = floors.map((f) => f.name);

  const browser = await launchBrowser();
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    page.setDefaultTimeout(6000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${fx.base}/dashboard`);
    await page.locator('.dash-floor-chip.on').waitFor();
    const current = (await page.locator('.dash-floor-chip.on .dash-floor-name').textContent()) ?? '';

    const counts: number[] = [];
    for (const width of [960, 1280, 1600, 2400, 3600]) {
      await page.setViewportSize({ width, height: 800 });
      await settled(page);
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('.dash-floor-chip:not([hidden])').length + Number(document.querySelector('.dash-quiet-bay:not([hidden]) .dash-quiet-label')?.textContent?.match(/\d+/)?.[0] ?? 0) === n &&
          Math.round(document.querySelector('.dash-top-lower')?.getBoundingClientRect().width ?? 0) === innerWidth,
        all.length,
      );
      const strip = await floorStrip(page);
      assert.equal(strip.clipped, false, `no tab is cut off at ${width}px`);
      assert.equal(strip.scrolls, false, `nothing scrolls at ${width}px`);
      assert.equal(strip.offscreen, false, `the strip's buttons stay on screen at ${width}px`);
      assert.ok(strip.shown.includes(current), `the current floor keeps its tab at ${width}px`);
      assert.deepEqual(
        strip.shown,
        all.filter((n) => strip.shown.includes(n)),
        `tabs stay in building order at ${width}px`,
      );
      assert.equal(strip.more, strip.shown.length === all.length ? '' : `+${all.length - strip.shown.length} more`);
      if (strip.shown.length < all.length) {
        assert.ok(strip.shown.includes(middle) && strip.shown.includes(last), `visited floors win tabs over unvisited ones at ${width}px`);
        // Filling stops at the first tab that doesn't fit: the space left is narrower than the next floor's tab.
        const room = await page.evaluate(() => {
          const deck = document.querySelector<HTMLElement>('.dash-top-lower')?.getBoundingClientRect().width ?? 0;
          const used = [...document.querySelectorAll<HTMLElement>('.dash-top-lower > :not(.dash-quiet-pop):not([hidden]):not(.dash-floor-track)')].reduce((s, el) => s + el.getBoundingClientRect().width, 0);
          return deck - used;
        });
        assert.ok(room >= 0 && room < 400, `at most one tab's width is left unused at ${width}px (left ${room}px)`);
      }
      counts.push(strip.shown.length);
    }
    assert.ok(counts[0] !== undefined && counts[0] < all.length, 'the narrowest window folds floors into +N more');
    assert.deepEqual(
      [...counts].sort((a, b) => a - b),
      counts,
      'a wider window never shows fewer tabs',
    );
    assert.equal(counts.at(-1), all.length, 'a wide enough window shows every floor');

    // "+N more" lists every floor without a tab, most relevant first.
    await page.setViewportSize({ width: 960, height: 800 });
    await settled(page);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.dash-quiet-bay')?.hidden);
    const shown = (await floorStrip(page)).shown;
    await page.locator('.dash-quiet-bay').click();
    const pop = page.getByRole('dialog', { name: 'Switch floor' });
    await pop.waitFor();
    const rows = await pop.locator('.dash-quiet-repo').allInnerTexts();
    assert.deepEqual([...rows].sort(), all.filter((n) => !shown.includes(n)).sort());
    assert.deepEqual(
      rows,
      all.filter((n) => rows.includes(n)),
      'unvisited, workerless floors tie, so they keep building order',
    );
    assert.match(await pop.locator('.dash-quiet-section').innerText(), new RegExp(`More floors \\(${rows.length} of ${all.length}\\)`, 'i'));
    await pop.locator('.dash-quiet-row').first().click();
    await page.waitForFunction((name) => document.querySelector('.dash-floor-chip.on .dash-floor-name')?.textContent === name, rows[0]);
    assert.ok((await floorStrip(page)).shown.includes(rows[0] ?? ''), 'the floor picked from +N more gets a tab');
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await closeBrowser();
  }
});
