import assert from 'node:assert/strict';
import test from 'node:test';
import { skip, terminalResizeFixture } from './helpers/terminal-resize-fixture.js';

test('terminal font changes keep the grid, live output and reading position in sync', { skip }, async (t) => {
  const rig = await terminalResizeFixture(t);

  for (const mode of ['inline', 'modal', 'shell']) {
    await t.test(`${mode} paints a text-size step with its fitted grid, including a burst`, async () => {
      const page = await rig(false, false, false, mode);
      const results = await page.evaluate(async () => {
        const w = window as any;
        const root: HTMLElement = w.term.native.element;
        const sample = () => [getComputedStyle(root.querySelector('.term-row')!).fontSize, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length, w.term.cols];
        const steps = [];
        for (const sizes of [[16], [14], [16, 18, 20, 22, 24]]) {
          const before = sample();
          w.update(w.term.cols, w.term.rows);
          w.messages = [];
          const frames: (string | number)[][] = [];
          const stop = w.eachPaint(() => frames.push(sample()));
          for (const px of sizes) {
            w.TerminalUI.setTermFontSize(px);
            await new Promise(requestAnimationFrame);
          }
          await w.frames();
          stop();
          steps.push({ before, after: sample(), frames, sent: w.sizes(), px: sizes.at(-1) });
        }
        return steps;
      });
      for (const { before, after, frames, sent, px } of results) {
        assert.equal(after[0], `${px}px`);
        assert.notEqual(before[2], after[2]);
        assert.deepEqual(sent, [[after[2], after[1]]]);
        assert.ok(frames.some((frame) => frame[0] === after[0]));
        for (const frame of frames) assert.deepEqual(frame, frame[0] === before[0] ? before : after, 'no intermediate font or partially refitted grid');
      }
    });

    await t.test(`${mode} fits visible cells inside padding and refits shared views on layout and font changes`, async () => {
      const page = await rig(true, false, false, mode);
      assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
      if (mode === 'inline') await page.evaluate(() => (window as any).resize(700, 400));
      else await page.setViewportSize({ width: 1024, height: 700 });
      await page.evaluate(() => (window as any).frames());
      assert.equal(await page.evaluate(() => (window as any).sizes().length), 1);
      const fits = () =>
        page.evaluate(() => {
          const host = document.querySelector('.term-host')!.getBoundingClientRect();
          const screen = document.querySelector('.term-grid')!.getBoundingClientRect();
          return screen.right <= host.right - 4 && screen.bottom <= host.bottom - 4 ? true : { host: host.toJSON(), screen: screen.toJSON() };
        });
      assert.equal(await fits(), true, 'last row and column must stay inside the padded host');
      await page.evaluate(() => {
        const w = window as any;
        for (const size of w.sizes()) w.update(...size);
        w.update(90, 25);
        w.messages = [];
        w.TerminalUI.setTermFontSize(20);
      });
      await page.evaluate(() => (window as any).frames());
      assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'font change reclaims shared sizing');
      assert.equal(await fits(), true);
    });
  }

  await t.test('stepping text size during a splitter drag keeps both font and grid until release', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const { before, during, after, sizes } = await page.evaluate(async () => {
      const w = window as any;
      const pane = document.querySelector<HTMLElement>('#mount')!;
      const layout = () => [w.term.options.fontSize, w.term.cols, w.term.rows];
      const before = layout();
      w.messages = [];
      pane.parentElement!.classList.add('resizing');
      pane.style.setProperty('--w', '.4');
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      const during = { layout: layout(), sizes: w.sizes() };
      pane.style.setProperty('--w', '.7');
      pane.parentElement!.classList.remove('resizing');
      // Releasing the handle also allows the pane's width transition to finish.
      await new Promise(requestAnimationFrame);
      await Promise.all(pane.getAnimations().map((animation) => animation.finished));
      await w.frames();
      return { before, during, after: layout(), sizes: w.sizes() };
    });
    assert.deepEqual(during, { layout: before, sizes: [] });
    assert.equal(after[0], 16);
    assert.deepEqual(sizes, [after.slice(1)]);
  });

  for (const hide of [false, true]) {
    await t.test(hide ? 'a concealed font step uses the first settled visible box' : 'a box change after observation supersedes the pending font fit', async () => {
      const page = await rig(false, false, false, 'dashboard');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const result = await page.evaluate(async (hide) => {
        const w = window as any;
        const pane = document.querySelector<HTMLElement>('#mount')!;
        const root: HTMLElement = w.term.native.element;
        w.update(w.term.cols, w.term.rows);
        w.messages = [];
        const sample = () => [getComputedStyle(root.querySelector('.term-row')!).fontSize, w.term.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length];
        const before = sample();
        const paints: (string | number)[][] = [];
        const stop = w.eachPaint(() => {
          if (root.clientWidth) paints.push(sample());
        });
        // A layout task runs after the last box observation, immediately before
        // the zero-delay fit commit. Interpose there, not at a guessed wall time.
        w.aroundNextFitTask(() => {
          if (hide) pane.style.display = 'none';
          else pane.style.setProperty('--w', '.35');
        });
        w.TerminalUI.setTermFontSize(16);
        await w.frames();
        const hiddenFont = w.term.options.fontSize;
        if (hide) pane.style.display = '';
        await w.frames();
        await w.frames();
        stop();
        return { before, hiddenFont, after: sample(), sizes: w.sizes(), paints, width: pane.style.getPropertyValue('--w') };
      }, hide);
      if (hide) assert.equal(result.hiddenFont, 14, 'keep the request, not just the old grid, while hidden');
      else assert.equal(result.width, '.35');
      assert.equal(result.after[0], '16px');
      assert.deepEqual(result.sizes, [result.after.slice(1)]);
      for (const frame of result.paints) assert.deepEqual(frame, frame[0] === '14px' ? result.before : result.after);
    });
  }

  await t.test('typing during a shared font-only wait paints the live echo at the next frame', async () => {
    const page = await rig(true);
    const result = await page.evaluate(async () => {
      const w = window as any;
      w.messages = [];
      w.TerminalUI.setTermFontSize(16);
      w.term.input('x');
      w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: 'pixel', data: 'LIVE-ECHO' });
      await new Promise(requestAnimationFrame);
      const echo = w.term.native.element.querySelector('.term-grid').textContent.includes('LIVE-ECHO');
      await w.frames();
      return { echo, input: w.messages.filter((m: any) => m.t === 'term.input').map((m: any) => m.data), sizes: w.sizes() };
    });
    assert.deepEqual(result.input, ['x']);
    assert.ok(result.echo, 'do not hold output while coalescing a font choice');
    assert.equal(result.sizes.length, 1);
  });

  await t.test('a scaled pane at a fractional column boundary fits once to the unscaled probe', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root: HTMLElement = w.term.native.element;
      const pane = document.getElementById('mount')!;
      const probe = root.querySelector('.term-size-probe')!.cloneNode(true) as HTMLElement;
      probe.style.fontSize = '16px';
      root.append(probe);
      const pitch = probe.getBoundingClientRect().width;
      probe.remove();
      const css = getComputedStyle(root);
      const inset = pane.offsetWidth - root.clientWidth + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
      // Round offsetWidth *up* while leaving less than one layout pixel past
      // the last column. A counter-scale based on offsetWidth loses that column.
      let cols = 30;
      for (; cols < 100; cols++) {
        const fraction = (cols * pitch + inset) % 1;
        if (fraction >= 0.5 && fraction < 0.8) break;
      }
      pane.style.width = `${cols * pitch + inset}px`;
      pane.style.transform = 'scale(.83)';
      await w.frames();
      w.update(w.term.cols, w.term.rows);
      w.messages = [];
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      return { cols, observed: w.term.observedDimensions, sizes: w.sizes() };
    });
    assert.ok(result.cols < 100);
    assert.equal(result.observed.cols, result.cols);
    assert.deepEqual(result.sizes, [[result.cols, result.observed.rows]]);
  });

  await t.test('a Boss Shell snapshot becoming ready between a font task and observation takes the new proposal', async () => {
    const page = await rig(false, true, false, 'shell');
    const result = await page.evaluate(async () => {
      const w = window as any;
      w.aroundNextFitTask(undefined, () => w.snapshot('ready'));
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      return { font: w.term.options.fontSize, actual: [w.term.cols, w.term.rows], observed: w.term.observedDimensions, sizes: w.sizes() };
    });
    assert.equal(result.font, 16);
    assert.deepEqual(result.actual, [result.observed.cols, result.observed.rows]);
    assert.deepEqual(result.sizes, [result.actual]);
  });

  for (const [mode, resize] of [
    ['shell', false],
    ['inline', false],
    ['inline', true],
  ] as const) {
    await t.test(`${mode} canceling an unaccepted font step ${resize ? 'preserves a genuine box claim' : 'preserves the shared grid'}`, async () => {
      const page = await rig(true, true, false, mode);
      const result = await page.evaluate(async (resize) => {
        const w = window as any;
        await new Promise<void>((resolve) => {
          w.aroundNextFitTask(undefined, resolve);
          w.TerminalUI.setTermFontSize(16);
        });
        const waiting = w.term.options.fontSize;
        if (resize) {
          w.resize(440, 350);
          await w.frames();
        }
        w.TerminalUI.setTermFontSize(14);
        const probes = w.term.native.element.querySelectorAll('.term-size-probe').length;
        w.snapshot('shared');
        await w.frames();
        await w.frames();
        return { waiting, probes, font: w.term.options.fontSize, grid: [w.term.cols, w.term.rows], fit: w.term.observedDimensions, sizes: w.sizes() };
      }, resize);
      const grid = resize ? [result.fit.cols, result.fit.rows] : [120, 40];
      assert.deepEqual(result.sizes, resize ? [grid] : []);
      assert.deepEqual(result.grid, grid);
      assert.equal(result.waiting, 14);
      assert.equal(result.font, 14);
      assert.equal(result.probes, 1, 'the canceled measurement probe is removed immediately');
    });
  }

  await t.test('a declined font proposal releases the paint hold for a settled pane resize', async () => {
    const page = await rig(true, true);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const holds: boolean[] = [];
      const hold = w.term.setFitPending.bind(w.term);
      w.term.setFitPending = (value: boolean) => {
        holds.push(value);
        hold(value);
      };
      w.resize(440, 350);
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      const waiting = { font: w.term.options.fontSize, sizes: w.sizes(), held: holds.at(-1) };
      w.snapshot();
      await w.frames();
      await w.frames();
      return { waiting, heldDuringResize: holds.includes(true), font: w.term.options.fontSize, grid: [w.term.cols, w.term.rows], sizes: w.sizes() };
    });
    assert.equal(result.heldDuringResize, true);
    assert.deepEqual(result.waiting, { font: 14, sizes: [], held: false });
    assert.equal(result.font, 16);
    assert.deepEqual(result.sizes, [result.grid]);
  });

  await t.test('stepping the font during a synchronized update never paints a partially refitted grid', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const term = w.term;
      const sample = () => [Number.parseFloat(getComputedStyle(term.native.element.querySelector('.term-row')).fontSize), term.native.element.querySelectorAll('.term-row:not(.term-scrollback-row)').length, term.cols];
      const write = (s: string) => new Promise<void>((resolve) => term.write(s, resolve));
      const before = sample();
      const frames: number[][] = [];
      const stop = w.eachPaint(() => frames.push(sample()));
      await write('\x1b[?2026h');
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      const held = sample();
      const synchronized = term.native.bridge.synchronizedOutput?.();
      await write('\x1b[?2026l');
      await w.frames();
      await w.frames();
      stop();
      return { before, held, synchronized, frames, after: sample() };
    });
    assert.equal(result.synchronized, true);
    assert.deepEqual(result.held, result.before, 'keep the original font and grid while the program holds output');
    assert.equal(result.after[0], 16);
    assert.notDeepEqual(result.before.slice(1), result.after.slice(1));
    for (const frame of result.frames) assert.deepEqual(frame, frame[0] === 14 ? result.before : result.after, `synchronized=${result.synchronized}, before close: ${result.held}`);
  });

  await t.test('a synchronized update can start after font commit but before wterm paints', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root = w.term.native.element;
      const sample = () => {
        const rows = root.querySelectorAll('.term-row:not(.term-scrollback-row)');
        const style = getComputedStyle(rows[0]);
        return [style.fontSize, rows.length, rows[0].offsetHeight, style.getPropertyValue('--term-cell-width')];
      };
      const before = sample();
      const frames: (string | number)[][] = [];
      const stop = w.eachPaint(() => frames.push(sample()));
      w.aroundNextFitTask(undefined, () => w.term.write('\x1b[?2026h'));
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      w.term.write('\x1b[?2026l');
      await w.frames();
      stop();
      return { before, frames, after: sample() };
    });
    assert.equal(result.after[0], '16px');
    assert.notEqual(result.before[1], result.after[1]);
    for (const frame of result.frames) assert.deepEqual(frame, frame[0] === '14px' ? result.before : result.after);
  });

  for (const layout of ['font only', 'pane resize', 'same column count']) {
    await t.test(`a font step keeps the same visible history row on every paint: ${layout}`, async () => {
      const page = await rig(false);
      const result = await page.evaluate(async (layout) => {
        const w = window as any;
        const root: HTMLElement = w.term.native.element;
        const sample = () => {
          const y = root.getBoundingClientRect().top + 2;
          const row = [...root.querySelectorAll<HTMLElement>('.term-row')].find((el) => {
            const box = el.getBoundingClientRect();
            return box.top <= y && box.bottom > y;
          });
          return row?.textContent.trim();
        };
        if (layout === 'same column count') {
          w.resize(140, 350);
          await w.frames();
        }
        const cols = w.term.cols;
        w.term.write(Array.from({ length: 250 }, (_, i) => (i < 80 ? `${i} ${'long prefix '.repeat(6)}` : `passage ${i}`)).join('\r\n'));
        await w.frames();
        const height = Number.parseFloat(getComputedStyle(root).getPropertyValue('--term-row-height'));
        root.scrollTop = root.scrollHeight - root.clientHeight - 35.5 * height;
        await w.frames();
        const before = sample();
        const frames: (string | undefined)[] = [];
        const stop = w.eachPaint(() => frames.push(sample()));
        if (layout === 'pane resize') w.resize(440, 240);
        // A program can start a synchronized redraw between resize and its
        // first paint. The retained rows must keep their old scroll coordinate.
        w.aroundNextFitTask(undefined, () => w.term.write('\x1b[?2026h'));
        w.TerminalUI.setTermFontSize(16);
        await w.frames();
        await w.frames();
        w.term.write('\x1b[?2026l');
        await w.frames();
        stop();
        return { before, frames, after: sample(), font: w.term.options.fontSize, sameCols: cols === w.term.cols };
      }, layout);
      assert.match(result.before ?? '', /^passage \d+$/);
      assert.equal(result.font, 16);
      assert.equal(result.sameCols, layout === 'same column count');
      assert.equal(result.after, result.before);
      assert.deepEqual([...new Set(result.frames)], [result.before]);
    });
  }

  for (const scenario of ['wheel', 'read-only', 'clamped', 'never closes'] as const) {
    await t.test(`a font step preserves the reader through an already open screen update: ${scenario}`, async () => {
      const page = await rig(scenario === 'read-only', false, false, scenario === 'read-only' ? 'read-only' : 'inline');
      const initial = await page.evaluate(async (scenario) => {
        const w = window as any;
        const term = w.term;
        const root: HTMLElement = term.native.element;
        if (scenario === 'clamped') {
          w.resize(140, 85);
          await w.frames();
        }
        term.write(Array.from({ length: 320 }, (_, i) => `line ${i}`).join('\r\n'));
        await w.frames();
        const pitch = parseFloat(root.style.getPropertyValue('--term-row-height'));
        root.scrollTop = 150.5 * pitch + parseFloat(getComputedStyle(root).paddingTop);
        await w.frames();
        const sample = () => {
          const y = root.getBoundingClientRect().top + 2;
          const row = [...root.querySelectorAll('.term-row')].find((el) => {
            const box = el.getBoundingClientRect();
            return box.top <= y && box.bottom > y;
          });
          return row?.textContent.trim() ?? null;
        };
        const before = sample();
        const paints: (string | null)[] = [];
        const stop = w.eachPaint(() => paints.push(sample()));
        w.readerPaints = () => paints.splice(0);
        w.readerState = () => ({
          line: sample(),
          font: getComputedStyle(root.querySelector('.term-row')!).fontSize,
          painted: [term.native.renderer.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length],
          grid: [term.cols, term.rows],
          open: term.core.synchronizedOutput(),
        });
        w.stopReaderPaints = stop;
        const grid = [term.cols, term.rows];
        term.write('\x1b[?2026h');
        w.TerminalUI.setTermFontSize(16);
        await new Promise((r) => setTimeout(r, 410));
        return { before, grid, held: w.readerState(), paints: w.readerPaints() };
      }, scenario);
      assert.equal(initial.before, 'line 150');
      if (scenario === 'read-only') assert.deepEqual(initial.grid, [120, 40]);
      if (scenario === 'clamped') assert.deepEqual(initial.grid, [20, 5]);
      assert.equal(initial.held.open, true);
      assert.deepEqual([...new Set(initial.paints)], ['line 150']);
      if (scenario === 'wheel') {
        await page.locator('.office-wterm').hover();
        await page.mouse.wheel(0, 57);
        await page.evaluate(() => (window as any).frames());
        assert.equal(await page.evaluate(() => (window as any).readerState().line), 'line 153');
        await page.evaluate(() => (window as any).readerPaints());
      }
      if (scenario === 'never closes') {
        await page.waitForFunction(
          () => {
            const w = window as any;
            const s = w.readerState();
            return s.font === '16px' && s.grid[0] === s.painted[0] && s.grid[1] === s.painted[1];
          },
          undefined,
          { timeout: 2500 },
        );
      } else {
        await page.evaluate(() => (window as any).term.write('\x1b[?2026l'));
      }
      const result = await page.evaluate(async () => {
        const w = window as any;
        await w.frames();
        w.stopReaderPaints();
        return { ...w.readerState(), paints: w.readerPaints() };
      });
      assert.equal(result.font, '16px');
      assert.equal(result.open, scenario === 'never closes');
      assert.deepEqual(result.painted, result.grid);
      assert.equal(result.line, scenario === 'wheel' ? 'line 153' : 'line 150');
      assert.deepEqual(initial.held.grid, initial.grid, 'do not resize during the initial 410 ms hold');
      assert.deepEqual([...new Set(result.paints)], [result.line]);
      if (scenario === 'never closes') assert.notDeepEqual(result.grid, initial.grid);
    });
  }

  for (const stream of ['reopen every third frame', 'remain open', 'replace every third frame'] as const) {
    const skipDeadline = process.env.GITHUB_ACTIONS === 'true' && stream !== 'reopen every third frame' && 'Local Chromium check: deadline timing varies on CI runners';
    await t.test(`a queued font step has one synchronized-output deadline: ${stream}`, { skip: skipDeadline }, async () => {
      const page = await rig(false);
      const result = await page.evaluate(async (stream) => {
        const w = window as any;
        const term = w.term;
        w.messages = [];
        term.write('\x1b[?2026h');
        // Keep real writes, frames and fit tasks; only advance the deadline clock when the test is ready.
        const start = performance.now();
        let elapsed = 0;
        Object.defineProperty(performance, 'now', { configurable: true, value: () => start + elapsed });
        let frame = 0;
        let committedAt = -1;
        let committedFrame = -1;
        let committedOpen = false;
        const set = term.setFontForFit.bind(term);
        term.setFontForFit = (px: number) => {
          committedAt = elapsed;
          committedFrame = frame;
          committedOpen = term.core.synchronizedOutput();
          set(px);
        };
        await new Promise<void>((resolve) => {
          w.aroundNextFitTask(undefined, resolve);
          w.TerminalUI.setTermFontSize(16);
        });
        for (const ms of [125, 250, 375, 500, 625, 750, 875, 999, 1000]) {
          await new Promise(requestAnimationFrame);
          elapsed = ms;
          frame++;
          if (stream === 'reopen every third frame' && frame % 3 === 1) term.write('\x1b[?2026l');
          if (stream === 'reopen every third frame' && frame % 3 === 2) term.write('\x1b[?2026h');
          if (stream === 'replace every third frame' && frame % 3 === 0) term.write('\x1b[?2026l\x1b[?2026h');
          term.write(`frame ${frame}\r\n`);
          if (ms >= 999) await w.frames(); // Give the fit tasks a turn on each side of the boundary.
        }
        const open = term.core.synchronizedOutput();
        Reflect.deleteProperty(performance, 'now');
        term.write('\x1b[?2026l');
        await w.frames();
        return { committedAt, committedFrame, committedOpen, open, sizes: w.sizes().length, output: term.native.element.textContent.includes(`frame ${frame}`) };
      }, stream);
      assert.equal(result.sizes, 1);
      assert.equal(result.output, true);
      if (stream === 'reopen every third frame') {
        assert.equal(result.committedFrame, 1, 'use the first frame between blocks');
        assert.equal(result.committedOpen, false);
      } else {
        assert.equal(result.committedAt, 1000, 'use the original deadline even when blocks are replaced');
        assert.equal(result.committedOpen, true);
        assert.equal(result.open, true, 'the font commit does not flush the program’s block');
      }
    });
  }

  await t.test('A+ from Thread returns to Raw without painting larger cells on the retained grid', async () => {
    const page = await rig(false, false, false, 'thread');
    await page.getByRole('button', { name: 'Thread', exact: true }).click();
    await page.evaluate(() => (window as any).frames());
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root: HTMLElement = w.term.native.element;
      w.update(w.term.cols, w.term.rows);
      w.messages = [];
      const paints: number[][] = [];
      const stop = w.eachPaint(() => {
        if (root.clientWidth && !root.classList.contains('replaying') && getComputedStyle(root.querySelector('.term-row')!).fontSize === '16px')
          paints.push([w.term.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length]);
      });
      document.querySelector<HTMLButtonElement>('[aria-label="Bigger terminal text"]')!.click();
      await w.frames();
      await w.frames();
      stop();
      return { paints, sizes: w.sizes(), observed: w.term.observedDimensions };
    });
    const grid = [result.observed.cols, result.observed.rows];
    assert.deepEqual(result.sizes, [grid]);
    assert.ok(result.paints.length);
    for (const actual of result.paints) assert.deepEqual(actual, grid);
  });

  await t.test('a second post-commit press paints both fitted grids without holding live output', async () => {
    const page = await rig(false, false, false, 'modal');
    const result = await page.evaluate(async () => {
      const w = window as any;
      const click = () => document.querySelector<HTMLButtonElement>('[aria-label="Bigger terminal text"]')!.click();
      const send = w.net.send.bind(w.net);
      let second = false;
      w.net.send = (msg: any) => {
        if (!second && msg.t === 'term.resize') {
          second = true;
          // Queue the second press after the commit returns, before any paint.
          queueMicrotask(click);
        }
        return send(msg);
      };
      w.messages = [];
      const root: HTMLElement = w.term.native.element;
      const sample = () => [getComputedStyle(root.querySelector('.term-row')!).fontSize, w.term.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length];
      const before = sample();
      const paints: (string | number)[][] = [];
      let firstEcho: boolean | undefined;
      const stop = w.eachPaint(() => {
        paints.push(sample());
        if (!second) return;
        if (firstEcho === undefined && paints.filter((p) => p[0] === '16px').length === 1) w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: 'pixel', data: 'NEXT-ECHO' });
        else if (firstEcho === undefined) firstEcho = root.querySelector('.term-grid')!.textContent.includes('NEXT-ECHO');
      });
      click();
      await w.frames();
      await w.frames();
      stop();
      return { before, paints, firstEcho, sizes: w.sizes() };
    });
    assert.equal(result.sizes.length, 2);
    const [first, last] = result.sizes;
    const layouts = [result.before, ['16px', ...first], ['18px', ...last]];
    assert.deepEqual(
      result.paints.filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0]),
      layouts,
    );
    for (const paint of result.paints)
      assert.deepEqual(
        paint,
        layouts.find((layout) => layout[0] === paint[0]),
      );
    assert.equal(result.firstEcho, true, 'superseded font probe must not hold the next echo');
    t.diagnostic(`post-commit press: ${JSON.stringify(layouts)}`);
  });

  await t.test('desk and shell buttons step from their own requested size after another tab changes its preference', async () => {
    for (const mode of ['modal', 'shell']) {
      const page = await rig(false, false, false, mode);
      const other = await page.context().newPage();
      await other.route(page.url(), (route) => route.fulfill({ contentType: 'text/html', body: '<title>Other tab</title>' }));
      await other.goto(page.url());
      await other.evaluate(() => localStorage.setItem('droid-office.term-font', '22'));
      const result = await page.evaluate(async () => {
        const w = window as any;
        const before = [w.term.options.fontSize, localStorage.getItem('droid-office.term-font')];
        const bigger = document.querySelector<HTMLButtonElement>('[aria-label="Bigger terminal text"]')!;
        bigger.click();
        bigger.click();
        await w.frames();
        return { before, after: w.term.options.fontSize };
      });
      await other.close();
      assert.deepEqual(result, { before: [14, '22'], after: 18 });
    }
  });
});
