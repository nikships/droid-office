import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { FIXTURE } from '../tools/thread-fixture.mjs';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { snapshotScreen } from '../src/server/screen-frame.js';

const status = browserStatus();

async function previewFixture(t: TestContext, data: string) {
  const term = new headless.Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  t.after(() => term.dispose());
  term.loadAddon(new unicode11.Unicode11Addon());
  term.unicode.activeVersion = '11';
  await new Promise<void>((done) => term.write(data, done));
  const frame = snapshotScreen(term, [])!;
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({
    content: buildSync({
      stdin: { contents: "export { createPane } from './dashboard-pane'; export { store } from './state';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
      bundle: true,
      format: 'iife',
      globalName: 'PaneUI',
      write: false,
      target: 'es2022',
    }).outputFiles[0].text,
  });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((frame) => {
    const { createPane, store } = (window as any).PaneUI;
    const worker = { id: 'shell', name: 'Shell', kind: 'shell', color: '#89d9ed', status: 'exited' };
    store.apply({ ...frame, t: 'screen', workerId: worker.id });
    const pane = createPane({ live: () => true, busy: () => false, worker: () => worker, mission: () => undefined, read: () => '', floor: () => '' }, 0);
    pane.update({ worker, view: 'terminal', focused: true, candidates: [] });
    document.body.append(pane.el.querySelector('.dash-preview'));
  }, frame);
  const rows = page.locator('.dash-preview-row');
  async function pixels(index: number, hide = false) {
    const row = rows.nth(index);
    if (hide) await row.locator('span').evaluate((el) => ((el as HTMLElement).style.visibility = 'hidden'));
    const png = await row.screenshot();
    return page.evaluate(async (base64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(0, 0, 100, img.height).data);
    }, png.toString('base64'));
  }
  return { rows, pixels };
}

test('compact preview clips one-column ink at the baseline and decorates whole cell boxes', { skip: !status.installed }, async (t) => {
  const { rows, pixels } = await previewFixture(t, 'Screen\r\n\r\n\r\nA🖥️Z\r\nA Z\r\n\x1b[38;2;0;255;0;4m   \r\n👩‍💻\x1b[0m\r\n\x1b[38;2;0;255;0;9;53m   \x1b[0m\r\nxx\x1b[3;4mf\x1b[0mZ');
  const box = await rows.nth(3).evaluate((el) => {
    const bounds = el.getBoundingClientRect(),
      cell = el.querySelector('span')!.getBoundingClientRect();
    return { left: cell.left - bounds.left, right: cell.right - bounds.left, width: cell.width };
  });
  const ink = await pixels(3),
    off = await pixels(3, true),
    plain = await pixels(4);
  const changed = Array.from({ length: ink.length / 4 }, (_, i) => i).filter((i) => ink.slice(4 * i, 4 * i + 3).some((v, k) => Math.abs(v - off[4 * i + k]) > 10));
  const right = Math.max(...changed.map((i) => i % 100)) + 1;
  const baseline = (p: number[]) => {
    let bottom = -1;
    for (let i = 0; i < p.length; i += 4) if ((i / 4) % 100 < box.left && p[i] > 100) bottom = Math.floor(i / 400);
    return bottom;
  };
  const strokes = async (i: number) => {
    const p = await pixels(i);
    const widths: number[] = [];
    for (let row = 0; row < p.length; row += 400) {
      let n = 0;
      for (let j = row; j < row + 400; j += 4) if (p[j + 1] > 100 && p[j + 1] > p[j] + 50 && p[j + 1] > p[j + 2] + 50) n++;
      widths.push(n);
    }
    return widths.filter((n) => n > 0);
  };
  const spaces = await strokes(5),
    emoji = await strokes(6),
    both = await strokes(7);
  t.diagnostic(JSON.stringify({ box, right, baseline: [baseline(off), baseline(plain)], spaces, emoji, both }));
  assert.ok(changed.length > 0 && right <= Math.ceil(box.right), 'the emoji must not paint into Z');
  assert.ok(baseline(off) >= 0 && baseline(off) === baseline(plain), 'neighbouring text must not move vertically');
  assert.ok(
    spaces.some((n) => Math.abs(n - 3 * box.width) <= 1),
    'underline spans three spaces',
  );
  assert.ok(
    emoji.some((n) => Math.abs(n - 4 * box.width) <= 1),
    'underline spans a four-column ZWJ',
  );
  assert.ok(both.filter((n) => Math.abs(n - 3 * box.width) <= 1).length >= 2, 'strike and overline span the blank run');

  // Use the shipped font: a fallback monospace font need not have the same italic overhang.
  const f = rows.nth(8).locator('span');
  const font = readFileSync(new URL('../src/client/public/fonts/GeistMono-Variable.woff2', import.meta.url)).toString('base64');
  await f.evaluate(async (el, data) => {
    const face = await new FontFace('Preview Geist Mono', `url(data:font/woff2;base64,${data})`).load();
    document.fonts.add(face);
    el.parentElement!.style.fontFamily = "'Preview Geist Mono'";
  }, font);
  const actual = await pixels(8);
  await f.evaluate((el) => ((el as HTMLElement).style.clipPath = 'inset(0)'));
  const clipped = await pixels(8);
  const edge = await f.evaluate((el) => {
    (el as HTMLElement).style.clipPath = 'none';
    return Math.floor(el.getBoundingClientRect().right - el.parentElement!.getBoundingClientRect().left);
  });
  const natural = await pixels(8);
  const beyond = natural.filter((v, i) => i % 4 === 0 && (i / 4) % 100 >= edge && v > clipped[i] + 5).length;
  t.diagnostic(`Geist Mono italic f retains ${beyond} right-edge pixels lost by the clipped control`);
  assert.ok(beyond > 0, 'clipping removes right-edge ink from the italic f control');
  assert.deepEqual(actual, natural, 'the decorated ASCII f keeps its natural ink before Z');
});

test('preview shapes Arabic and Hebrew as unsplit words before the next cell', { skip: !status.installed }, async (t) => {
  const words = ['سلام', 'שלום'];
  const { rows, pixels } = await previewFixture(t, words.map((w) => `${w}Z`).join('\r\n'));
  for (const [i, word] of words.entries()) {
    const row = rows.nth(i);
    const actual = await pixels(i);
    assert.deepEqual(await row.locator('span').allTextContents(), [word]);
    assert.equal(await row.locator('span').evaluate((el) => el.style.width), '4ch');
    // Reference: one natural text node in a four-cell box, then the ASCII suffix.
    await row.evaluate((el, word) => {
      const ref = document.createElement('span');
      ref.style.cssText = 'display:inline-block;width:4ch;clip-path:inset(0)';
      ref.textContent = word;
      el.replaceChildren(ref, 'Z');
    }, word);
    assert.deepEqual(actual, await pixels(i), `visual order and shaping for ${word}`);
  }
});

test('one background color covers equal-height ASCII and wide cells in Chromium', { skip: !status.installed }, async (t) => {
  const { rows, pixels } = await previewFixture(t, '\r\n\r\n\r\n\x1b[38;2;0;255;0;48;2;0;255;0mA界Z');
  const x = await rows.nth(3).evaluate((el) => [...el.children].map((span) => Math.floor(span.getBoundingClientRect().left - el.getBoundingClientRect().left + span.getBoundingClientRect().width / 2)));
  const p = await pixels(3);
  const bands = x.map((col) => Array.from({ length: p.length / 400 }, (_, y) => y).filter((y) => p[y * 400 + col * 4 + 1] > 150));
  t.diagnostic(`Background pixel rows for A界Z: ${JSON.stringify(bands.map((b) => [b[0], b.at(-1)]))}`);
  assert.equal(bands.length, 3);
  assert.ok(bands[0].length > 0);
  assert.deepEqual(bands[1], bands[0]);
  assert.deepEqual(bands[2], bands[0]);
});

test('empty pane clicks hire in place without swallowing worker picks or allowing offline hires', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/dashboard-pane.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'PaneUI', write: false, target: 'es2022' }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="modal-root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.hires = [];
    w.assignments = [];
    w.live = true;
    const pane = w.PaneUI.createPane(
      {
        live() {
          return w.live;
        },
        focus() {},
        mission() {
          return undefined;
        },
        worker() {
          return undefined;
        },
        hire(index: number) {
          w.hires.push(index);
        },
        assign(index: number, id: string) {
          w.assignments.push([index, id]);
        },
      },
      3,
    );
    document.body.append(pane.el);
    // Pixel is the existing worker offered by the owner's companion screenshot.
    w.paint = (anyone = true) =>
      pane.update({
        view: 'terminal',
        focused: true,
        maximized: false,
        canMaximize: false,
        covered: false,
        takeFocus: false,
        anyone,
        candidates: anyone ? [{ id: 'pixel', name: 'Pixel', color: '#89d9ed' }] : [],
      });
    w.paint();
  });
  await page.locator('.dash-pick span').last().click();
  assert.deepEqual(await page.evaluate(() => (window as any).assignments), [[3, 'pixel']]);
  assert.deepEqual(await page.evaluate(() => (window as any).hires), []);
  await page.getByRole('button', { name: 'Hire Droid here' }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3], 'button bubbling does not hire twice');
  await page.locator('.dash-empty h3').click();
  await page.locator('.dash-empty').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3]);
  await page.evaluate(() => {
    document.querySelector('.dash-empty h3')!.firstChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(errors, [], 'non-element event targets do not throw');
  await page.evaluate(() => {
    (window as any).live = false;
    (window as any).paint();
  });
  assert.equal(await page.getByRole('button', { name: 'Hire Droid here' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Pixel' }).isDisabled(), true);
  await page.locator('.dash-empty h3').click();
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3], 'offline backgrounds do not hire');
  await page.evaluate(() => {
    (window as any).live = true;
    (window as any).paint(false);
  });
  await page.getByRole('button', { name: 'Hire Droid here' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3, 3], 'an unpopulated floor supports keyboard hiring');
});

test('only the focused thread pane shows its composer, reclaiming space without losing drafts or reading position', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: "export { createPane } from './dashboard-pane'; export { store } from './state'; export { reconcilePanes } from './dashboard-workspace';",
      resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'PaneUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases.find((example: { name: string }) => example.name === 'reported_release_turn');
  await page.setContent('<!doctype html><div id="dashboard"><div class="dash-workspace"></div></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addStyleTag({
    content:
      '.dash-workspace { position: relative; flex: none; height: 360px; width: 100%; } .dash-pane { top: 0; width: 49%; height: 100%; transition: none; animation: none; } .dash-pane:first-child { left: 0; } .dash-pane:last-child { left: 51%; }',
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((captured) => {
    const w = window as any;
    // Pixel and Byte are the owner's workers; conversation rows use the captured golden session.
    w.workers = ['Pixel', 'Byte'].map((name) => ({ id: name.toLowerCase(), name, color: '#89d9ed', kind: 'agent', status: 'idle', sessionId: 'captured', acked: true }));
    for (const worker of w.workers) w.PaneUI.store.workers.set(worker.id, worker);
    const listeners = new Set<(msg: any) => void>();
    w.actions = [];
    w.focused = 0;
    const net = {
      send(msg: any) {
        if (msg.t === 'thread.read')
          queueMicrotask(() => {
            for (const receive of listeners)
              receive({ t: 'thread.snapshot', workerId: msg.workerId, request: msg.request, sessionId: 'captured', entries: captured.entries, hasMore: false, presentation: { version: 1, rows: captured.expected } });
          });
        return true;
      },
      onMessage(receive: (msg: any) => void) {
        listeners.add(receive);
        return () => listeners.delete(receive);
      },
    };
    w.paint = () =>
      w.panes.forEach((pane: any, index: number) =>
        pane.update({ worker: w.workers[index], view: 'thread', focused: index === w.focused, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false }),
      );
    const host = {
      net,
      live: () => true,
      floor: () => 'floor',
      busy: () => false,
      read: () => '',
      remember() {},
      action: async (msg: any) => {
        w.actions.push(msg);
      },
      mission: () => undefined,
      worker: (id: string) => w.workers.find((m: any) => m.id === id),
      focus(index: number) {
        if (w.focused === index) return;
        w.focused = index;
        w.paint();
      },
    };
    w.panes = [0, 1].map((index) => w.PaneUI.createPane(host, index));
    document.querySelector('.dash-workspace')!.append(...w.panes.map((pane: any) => pane.el));
    w.paint();
  }, captured);
  const panes = page.locator('.dash-pane');
  const first = panes.nth(0);
  const second = panes.nth(1);
  await first.locator('.wt-entry').first().waitFor();
  // Expand the captured activity so both viewport sizes have enough history to scroll.
  await first.locator('.wt-list').evaluate((el) => {
    for (const details of el.querySelectorAll('details')) details.open = true;
    for (const trigger of el.querySelectorAll<HTMLButtonElement>('.wt-sg-trigger, .wt-tr-trigger')) if (trigger.hasAttribute('aria-expanded')) trigger.click();
  });
  await first.locator('.wt-scroll').evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await first.locator('.wt-latest').waitFor({ state: 'visible' });
  await first.locator('.wt-latest').click();
  assert.equal(await first.locator('.wt-composer').isVisible(), true);
  assert.equal(await second.locator('.wt-composer').isVisible(), false);
  const height = () => first.locator('.wt-scroll').evaluate((el) => el.clientHeight);
  const bottomGap = () => first.locator('.wt-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const smallHeight = await height();
  const composerHeight = await first.locator('.wt-composer').evaluate((el) => el.getBoundingClientRect().height);
  assert.equal(await page.getByRole('textbox', { name: 'Message to Pixel' }).count(), 1, 'the composer names its worker');
  await first.locator('.wt-input').fill('Keep this unsent draft');
  await first.locator('.wt-input').evaluate((el) => ((window as any).originalInput = el));
  await second.locator('.dash-pane-head').click();
  assert.equal(await second.locator('.wt-input').evaluate((el) => document.activeElement === el), true, 'clicking another pane focuses its composer');
  await page.keyboard.type('Ready to type');
  assert.equal(await second.locator('.wt-input').inputValue(), 'Ready to type', 'typing after one click goes into the selected pane');
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  await page.waitForFunction(() => {
    const el = document.querySelector('.wt-scroll')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  assert.equal(await first.locator('.wt-composer').isVisible(), false);
  assert.equal(await second.locator('.wt-composer').isVisible(), true);
  assert.ok(Math.abs((await height()) - smallHeight - composerHeight) < 2, 'the entire composer height becomes conversation space');
  assert.ok((await bottomGap()) < 2, 'following latest stays pinned when the composer collapses');
  // Keyboard entry into history selects the pane, but does not steal focus into its newly shown input.
  await first.locator('.wt-scroll').focus();
  assert.equal(await first.locator('.wt-input').isVisible(), true);
  assert.equal(await first.locator('.wt-scroll').evaluate((el) => document.activeElement === el), true);
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  assert.equal(await first.locator('.wt-input').evaluate((el) => (window as any).originalInput === el), true);
  await page.waitForFunction(() => {
    const el = document.querySelector('.wt-scroll')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  // Reading older messages must not be mistaken for following the tail after either resize.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await first.locator('.wt-scroll').evaluate((el) => {
    el.scrollTop = 40;
    el.dispatchEvent(new Event('scroll'));
  });
  const top = await first.locator('.wt-scroll').evaluate((el) => el.scrollTop);
  assert.ok(top > 0 && (await bottomGap()) > 80, 'the captured conversation overflows the pane');
  await second.locator('.dash-pane-head').click();
  await first.locator('.wt-scroll').focus();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await first.locator('.wt-scroll').evaluate((el) => el.scrollTop), top);
  // A hidden composer is absent from keyboard navigation, not merely transparent.
  await second.locator('.dash-pane-head').click();
  await first.locator('.wt-input').evaluate((el: HTMLTextAreaElement) => el.focus());
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), false);
  assert.equal(await second.locator('.wt-composer').isVisible(), true);
  // Questions remain visible in unfocused panes, and still suppress the composer on focus.
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'needs_input';
    w.paint();
  });
  assert.equal(await first.locator('.dash-question').isVisible(), true);
  await first.locator('.wt-scroll').focus();
  assert.equal(await first.locator('.wt-composer').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => (window as any).actions), [], 'selecting a pane never sends a prompt');
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'idle';
    w.workers.reverse();
    w.PaneUI.reconcilePanes(
      w.panes,
      w.workers.map((worker: any) => worker.id),
    );
    w.focused = 0;
    w.paint();
  });
  assert.equal(await first.getAttribute('aria-label'), 'Pane 2: Pixel');
  assert.equal(await first.locator('.dash-pane-no').textContent(), '2');
  assert.equal(await first.locator('.wt-input').evaluate((el) => (window as any).originalInput === el), true, 'moving retains the mounted Thread and its draft resources');
  await first.locator('.dash-pane-head').click();
  assert.equal(await page.evaluate(() => (window as any).focused), 1, 'moved pane actions use their new slot');
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  assert.equal(await first.locator('.wt-composer').isVisible(), true);
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), true, 'moved panes still focus their own composer');
  await second.locator('.dash-pane-head').click();
  const summary = first.locator('.wt-list :is(.wt-sg-trigger, .wt-tr-trigger)[aria-expanded], .wt-list summary').first();
  await summary.click();
  assert.equal(await summary.evaluate((el) => document.activeElement === el), true, 'clicking a disclosure keeps keyboard focus on that control');
  await second.locator('.dash-pane-head').click();
  await first
    .locator('.wt-entry')
    .first()
    .evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const selection = window.getSelection()!;
      selection.selectAllChildren(el);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), false, 'selecting conversation text does not jump into the composer');
  assert.ok(await page.evaluate(() => window.getSelection()!.toString().length > 0));
  await page.evaluate(() => {
    window.getSelection()!.removeAllRanges();
    (window as any).panes[1].focusContent();
  });
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), true, 'explicit keyboard pane focus prefers the composer over earlier history');
  await page.evaluate(() => (window as any).panes.forEach((pane: any) => pane.dispose()));
  assert.deepEqual(errors, []);
});

test('a pane keeps one answer window open across a questionnaire and closes it when the worker moves on', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser, { viewport: { width: 1280, height: 860 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: { contents: "export { createPane } from './dashboard-pane'; export { store } from './state';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
    bundle: true,
    format: 'iife',
    globalName: 'PaneUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases.find((example: { name: string }) => example.name === 'reported_release_turn');
  // Screens as Droid's AskUser draws them, ending with the captured review.
  const screens = {
    first: ['  Ask User', '  Which hypervisor should we use?', '', '  1. UTM', '  2. Parallels', '  Or type your own answer...', '', '  Space/Enter/1-9 Select'],
    second: ['  Ask User', '  Which Windows licence should we use?', '', '  1. Evaluation', '  2. Retail', '  Or type your own answer...', '', '  Space/Enter/1-9 Select'],
    third: ['  Ask User', '  How should agents connect?', '', '  1. SSH', '  2. RDP', '  Or type your own answer...', '', '  Space/Enter/1-9 Select'],
    review: readFileSync(new URL('../android/app/src/test/resources/askuser-1.7.1-review.txt', import.meta.url), 'utf8').split('\n'),
  };
  await page.setContent('<!doctype html><div id="dashboard"><div class="dash-workspace"></div></div><div id="modal-root"></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: '.dash-workspace { position: relative; height: 700px; } .dash-pane { top: 0; left: 0; width: 100%; height: 100%; transition: none; animation: none; }' });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate(
    ({ captured, screens }) => {
      const w = window as any;
      w.screens = screens;
      w.worker = {
        id: 'pixel',
        name: 'Pixel',
        color: '#89d9ed',
        kind: 'agent',
        status: 'needs_input',
        sessionId: 'captured',
        acked: true,
        ask: {
          kind: 'question',
          questions: [
            { question: 'Which hypervisor should we use?', topic: 'Hypervisor', options: ['UTM', 'Parallels'], multiSelect: false },
            { question: 'Which Windows licence should we use?', topic: 'Windows-licence', options: ['Evaluation', 'Retail'], multiSelect: false },
            { question: 'How should agents connect?', topic: 'Agent-access', options: ['SSH', 'RDP'], multiSelect: false },
          ],
        },
      };
      w.PaneUI.store.workers.set('pixel', w.worker);
      w.show = (name: string | undefined) => {
        if (name) {
          const lines = w.screens[name];
          w.PaneUI.store.screens.set('pixel', { cols: 100, rows: lines.length, lines: lines.map((line: string) => [[line, -1, -1, 0]]) });
        } else w.PaneUI.store.screens.delete('pixel');
        w.pane.paintQuestion();
      };
      w.actions = [];
      const listeners = new Set<(msg: any) => void>();
      const net = {
        send(msg: any) {
          if (msg.t === 'thread.read')
            queueMicrotask(() => {
              for (const receive of listeners)
                receive({ t: 'thread.snapshot', workerId: msg.workerId, request: msg.request, sessionId: 'captured', entries: captured.entries, hasMore: false, presentation: { version: 1, rows: captured.expected } });
            });
          return true;
        },
        onMessage(receive: (msg: any) => void) {
          listeners.add(receive);
          return () => listeners.delete(receive);
        },
      };
      w.pane = w.PaneUI.createPane(
        {
          net,
          live: () => true,
          floor: () => 'floor',
          busy: () => false,
          usable: () => true,
          read: () => '',
          remember() {},
          setView() {},
          action: async (msg: any) => {
            w.actions.push(msg);
          },
          mission: () => undefined,
          worker: (id: string) => (id === 'pixel' ? w.worker : undefined),
          focus() {},
        },
        0,
      );
      document.querySelector('.dash-workspace')!.append(w.pane.el);
      w.paint = () => w.pane.update({ worker: w.worker, view: 'thread', focused: true, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false });
      w.show('first');
      w.paint();
    },
    { captured, screens },
  );
  const workspace = page.locator('.question-workspace');
  const question = () => workspace.locator('.qw-question').textContent();
  const states = () => workspace.locator('.qw-step').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
  const show = (name?: string) => page.evaluate((name) => (window as any).show(name), name);
  await page.getByRole('button', { name: 'Answer questions' }).click();
  assert.equal(await question(), 'Which hypervisor should we use?');
  assert.deepEqual(await states(), ['current', 'upcoming', 'upcoming', 'upcoming']);

  // Answered in the terminal before the owner started: the window follows to the next question.
  await show('second');
  assert.equal(await question(), 'Which Windows licence should we use?');
  assert.deepEqual(await states(), ['done', 'current', 'upcoming', 'upcoming']);
  assert.equal(await workspace.getByRole('button', { name: 'Show current question' }).isVisible(), false);

  // A started draft is never swapped for another question without the owner's say.
  await workspace.locator('input[value="2"]').check();
  await show('third');
  assert.equal(await question(), 'Which Windows licence should we use?');
  assert.match((await workspace.locator('.qw-feedback').textContent()) ?? '', /changed or was answered elsewhere/);
  await workspace.getByRole('button', { name: 'Show current question' }).click();
  assert.equal(await question(), 'How should agents connect?');
  assert.equal(await workspace.locator('input[value="2"]').isChecked(), false, 'the earlier draft does not carry over');

  await workspace.locator('input[value="1"]').check();
  await workspace.getByRole('button', { name: 'Submit and continue' }).click();
  await page.waitForFunction(() => (window as any).actions.length === 1);
  const sent = await page.evaluate(() => (window as any).actions[0]);
  assert.equal(sent.t, 'worker.answer');
  assert.equal(sent.choice, 1);
  assert.equal(sent.menu.question, 'How should agents connect?');
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Answer sent. Opening the review…');
  assert.equal(await workspace.locator('.qw-step').nth(2).locator('.qw-step-answer').textContent(), 'SSH');

  await show('review');
  assert.equal(await workspace.locator('.qw-question').textContent(), 'Review your answers');
  assert.deepEqual(await states(), ['done', 'done', 'done', 'current']);
  // The elapsed-time dismissal must still fire if the wall clock does not advance.
  await page.clock.setFixedTime(new Date());
  await workspace.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Sent. Pixel is continuing.');
  assert.equal(await page.evaluate(() => (window as any).actions.length), 2);
  assert.equal(await page.evaluate(() => (window as any).actions[1].menu.review.length), 6);
  assert.equal(await workspace.count(), 1, 'one window served the whole questionnaire');

  // The worker moves on: the window says so, then closes by itself.
  await page.evaluate(() => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'working', ask: undefined };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.show(undefined);
    w.paint();
  });
  await workspace.waitFor({ state: 'detached', timeout: 6000 });
  await page.clock.setSystemTime(new Date());

  // A cloud worker's AskUser has no terminal Review step and no Raw TTY button.
  await page.evaluate(() => {
    const w = window as any;
    w.actions.length = 0;
    w.worker = {
      ...w.worker,
      status: 'needs_input',
      ask: {
        kind: 'question',
        questions: [
          { question: 'How should a multi-question series flow inside the single overlay?', topic: 'Series flow', options: ['Guided stepper (Recommended)', 'Fill all, then send'], multiSelect: false },
          { question: 'For single-choice questions, should picking an option send it right away?', topic: 'Single pick', options: ['Keep explicit submit', 'Pick sends immediately'], multiSelect: false },
        ],
      },
      cloud: {
        computerId: 'computer',
        computerName: 'mac-mini',
        menu: {
          question: 'How should a multi-question series flow inside the single overlay?',
          choices: [
            { number: 1, label: 'Guided stepper (Recommended)' },
            { number: 2, label: 'Fill all, then send' },
          ],
          freeText: true,
        },
      },
    };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.paint();
  });
  await page.getByRole('button', { name: 'Answer questions' }).click();
  assert.deepEqual(await states(), ['current', 'upcoming']);
  assert.equal(await workspace.getByRole('button', { name: 'Raw TTY' }).count(), 0);
  await workspace.locator('input[value="1"]').check();
  await workspace.getByRole('button', { name: 'Submit and continue' }).click();
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Answer sent. Opening question 2 of 2…');
  await page.evaluate(() => {
    const w = window as any;
    w.worker = {
      ...w.worker,
      cloud: {
        ...w.worker.cloud,
        menu: {
          question: 'For single-choice questions, should picking an option send it right away?',
          choices: [
            { number: 1, label: 'Keep explicit submit' },
            { number: 2, label: 'Pick sends immediately' },
          ],
          freeText: true,
        },
      },
    };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.pane.paintQuestion();
  });
  assert.deepEqual(await states(), ['done', 'current']);
  assert.equal(await workspace.locator('.qw-step').first().locator('.qw-step-answer').textContent(), 'Guided stepper (Recommended)');
  await workspace.locator('input[value="1"]').check();
  await workspace.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.qw-feedback')?.textContent === 'Sent. Pixel is continuing.');
  await page.evaluate(() => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'working', ask: undefined, cloud: { ...w.worker.cloud, menu: undefined } };
    w.PaneUI.store.workers.set('pixel', w.worker);
    w.paint();
  });
  await workspace.waitFor({ state: 'detached', timeout: 6000 });
  assert.deepEqual(errors, []);
});
