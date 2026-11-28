import assert from 'node:assert/strict';
import test from 'node:test';
import { skip, terminalResizeFixture } from './helpers/terminal-resize-fixture.js';

test('inline terminals follow pane geometry without focus or stale size rollbacks', { skip }, async (t) => {
  const rig = await terminalResizeFixture(t);

  for (const mode of ['inline', 'shell']) {
    await t.test(`${mode} sends 30 settled keystrokes without measuring or resizing`, async () => {
      const page = await rig(true, false, false, mode);
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type('x');
      assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'first input claims the shared grid');
      await page.evaluate(() => {
        const w = window as any;
        w.messages = [];
        w.proposals = 0;
        const propose = w.term.proposeDimensions.bind(w.term);
        w.term.proposeDimensions = () => {
          w.proposals++;
          return propose();
        };
        // Apart from the adapter's proposal, the old input path read the host itself.
        const host = document.querySelector('.term-host')!;
        for (const name of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'getBoundingClientRect'])
          Object.defineProperty(host, name, {
            get: () => {
              throw Error(`input measured ${name}`);
            },
          });
      });
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyzabcd');
      assert.deepEqual(
        await page.evaluate(() => {
          const w = window as any;
          return [w.proposals, w.sizes().length, w.messages.filter((m: any) => m.t.endsWith('.input')).length];
        }),
        [0, 0, 30],
      );
    });
    await t.test(`${mode} enables clipboard and input only after snapshot and pending output drain`, async () => {
      const page = await rig(true, true, false, mode);
      const result = await page.evaluate(async (mode) => {
        const w = window as any;
        const writes: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => writes.push(value) } });
        const data = (value: string) => w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: mode === 'shell' ? w.TerminalUI.OFFICE_SHELL_ID : 'pixel', data: value });
        const marker = '\x1b]52;c;cHJvb2Y=\x07\x1b[6n';
        const initial = !!w.term.options.disableStdin;
        w.snapshot(marker);
        data(marker);
        await w.frames();
        const afterDrain = writes.length;
        data(marker);
        const live = writes.length;
        w.net.up = false;
        w.connectionStatus?.(false);
        data(marker);
        w.net.up = true;
        w.connectionStatus?.(true);
        data(marker);
        w.snapshot(marker);
        data(`${marker}\x1b]52;c;b2xk`);
        await w.frames();
        data('\x07'); // Live terminator of an OSC that started in the attach backlog.
        const reattached = writes.length;
        data(marker);
        return { initial, afterDrain, live, reattached, total: writes.length, ptyInput: w.messages.filter((m: any) => m.t.endsWith('.input')) };
      }, mode);
      assert.deepEqual(result, { initial: true, afterDrain: 0, live: 1, reattached: 1, total: 2, ptyInput: [] });
    });

    await t.test(`${mode} forwards focus changes once and never claims size for them`, async () => {
      const page = await rig(true, false, false, mode);
      // The Boss Shell focuses itself shortly after opening; let that land before taking focus away.
      if (mode === 'shell') await page.waitForFunction(() => document.activeElement === (window as any).term.textarea);
      await page.evaluate(() => {
        document.getElementById('focus')!.focus();
        (window as any).messages = [];
      });
      const reports = async (enable = 0) =>
        page.evaluate(async (enable) => {
          const w = window as any;
          // Droid turns focus reporting on again each time it regains focus.
          for (let i = 0; i < enable; i++) await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
          return { input: w.messages.filter((m: any) => m.t === 'term.input' || m.t === 'shell.input').map((m: any) => m.data), sizes: w.sizes() };
        }, enable);
      assert.deepEqual(await reports(3), { input: [], sizes: [] }, 'an unfocused window stays silent when focus reporting turns on');
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await reports(3), { input: ['\x1b[I'], sizes: [] }, 'focus-in is sent once, not echoed for every re-enable');
      // No notification is emitted for a blur while reporting is off. The next real focus-in still counts.
      await page.evaluate(async () => {
        const w = window as any;
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004l', resolve));
        document.getElementById('focus')!.focus();
      });
      assert.deepEqual(await reports(1), { input: ['\x1b[I'], sizes: [] });
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await reports(), { input: ['\x1b[I', '\x1b[I'], sizes: [] }, 'off/on between transitions does not suppress the next focus-in');
      await page.evaluate(() => document.getElementById('focus')!.focus());
      assert.deepEqual(await reports(2), { input: ['\x1b[I', '\x1b[I', '\x1b[O'], sizes: [] });
      await page.evaluate(() => (window as any).term.input('x'));
      assert.equal((await reports()).sizes.length, 1, 'typing still claims the size');
    });

    await t.test(`${mode} sends focus-in again after focus changed while a snapshot loaded`, async () => {
      const page = await rig(true, false, false, mode);
      if (mode === 'shell') await page.waitForFunction(() => document.activeElement === (window as any).term.textarea);
      const sent = () => page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input' || m.t === 'shell.input').map((m: any) => m.data));
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        w.messages = [];
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
        document.getElementById('focus')!.focus();
        w.term.focus();
        // A fresh snapshot loads, and focus leaves while it does: that focus-out never reaches the program.
        w.snapshot();
        document.getElementById('focus')!.focus();
      });
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await sent(), ['\x1b[O', '\x1b[I'], 'first blur after mode enable is a real transition');
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
      });
      assert.deepEqual(await sent(), ['\x1b[O', '\x1b[I'], 'enabling focus mode on an already-focused terminal is not a focus transition');
      await page.locator('#focus').focus();
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await sent(), ['\x1b[O', '\x1b[I', '\x1b[O', '\x1b[I'], 'both real transitions reach the program');
    });

    await t.test(`${mode} keeps forwarding focus when it stays focused through a snapshot`, async () => {
      const page = await rig(true, false, false, mode);
      if (mode === 'shell') await page.waitForFunction(() => document.activeElement === (window as any).term.textarea);
      const sent = () => page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input' || m.t === 'shell.input').map((m: any) => m.data));
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
        w.messages = [];
        // A snapshot carries the program's modes, focus reporting among them.
        w.snapshot('\x1b[?1004h');
      });
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await sent(), ['\x1b[I'], 'the snapshot reasserts this window’s focus');
      await page.evaluate(async () => {
        const w = window as any;
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
        document.getElementById('focus')!.focus();
      });
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await sent(), ['\x1b[I', '\x1b[O'], 'the next blur reaches the program');
    });
  }

  await t.test('shell acknowledgements do not roll back rapid resizes and external sizes stay passive', async () => {
    const page = await rig(false, false, false, 'shell');
    await page.evaluate(() => {
      const w = window as any;
      w.update(w.term.cols, w.term.rows);
      w.messages = [];
    });
    for (const width of [1440, 1024, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => (window as any).frames());
    }
    const final = await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]);
    const sizes = await page.evaluate(() => (window as any).sizes());
    assert.equal(sizes.length, 3);
    for (const size of sizes) {
      await page.evaluate((size) => (window as any).update(...size), size);
      assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), final);
    }
    await page.evaluate(() => {
      const w = window as any;
      w.update(90, 25);
      w.messages = [];
    });
    await page.evaluate(() => (window as any).frames());
    assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), [90, 25]);
    assert.equal(await page.evaluate(() => (window as any).sizes().length), 0, 'following another viewer must not create a resize loop');
    await page.evaluate(() => (window as any).term.input('x'));
    assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'typing explicitly reclaims size');
  });

  await t.test('an unpainted snapshot accepts keyboard input but not pointer reports', async () => {
    const page = await rig(true, true);
    await page.evaluate(() => (window as any).snapshot('\x1b[?1000h\x1b[?1006h\x1b[?2026h'));
    const root = page.locator('.office-wterm');
    await page.waitForFunction(() => !(window as any).term.options.disableStdin && !!document.querySelector('.office-wterm.replaying'));
    await page.evaluate(() => (window as any).term.focus());
    await page.keyboard.type('k');
    const bounds = (await root.boundingBox())!;
    await page.mouse.click(bounds.x + 25, bounds.y + 34);
    const input = await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input').map((m: any) => m.data));
    assert.deepEqual(input, ['k']);
    await page.evaluate(() => (window as any).term.write('\x1b[?2026l'));
    await page.waitForFunction(() => !document.querySelector('.office-wterm.replaying'));
    await page.keyboard.type('z');
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).data), 'z', 'the concealed click leaves keyboard input at the terminal');
    await page.mouse.click(bounds.x + 25, bounds.y + 34);
    assert.match(await page.evaluate(() => (window as any).messages.at(-1).data), /^\x1b\[<0;/);
  });

  for (const mode of ['shell', 'dragging']) {
    await t.test(`${mode} reveals its first grid only after a queued exclusive fit`, async () => {
      const page = await rig(false, true, false, mode);
      if (mode === 'shell') {
        await page.setViewportSize({ width: 1450, height: 900 });
        await page.evaluate(() => (window as any).frames());
      }
      await page.evaluate((mode) => {
        const w = window as any,
          el = w.term.native.element;
        w.firstVisible = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (el.classList.contains('replaying')) return;
            observer.disconnect();
            resolve({ grid: [w.term.cols, w.term.rows], sizes: w.sizes() });
          });
          observer.observe(el, { attributes: true, attributeFilter: ['class'] });
        });
        if (mode === 'shell') window.addEventListener('resize', () => w.snapshot('first screen'), { once: true });
        else w.snapshot('first screen');
      }, mode);
      if (mode === 'shell') await page.setViewportSize({ width: 1510, height: 900 });
      else
        await page.evaluate(async () => {
          const w = window as any;
          await w.frames();
          document.querySelector('.dash-workspace')!.classList.remove('resizing');
        });
      const result = await page.evaluate(async () => {
        const w = window as any,
          first = await w.firstVisible,
          fit = w.term.proposeDimensions();
        return { first, expected: [fit.cols, fit.rows] };
      });
      assert.deepEqual(result.first, { grid: result.expected, sizes: [result.expected] });
    });
  }

  await t.test('showing a tab during a continuing drag waits for release before claiming size', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!,
        ws = raw.parentElement!;
      w.messages = [];
      ws.classList.add('resizing');
      raw.style.setProperty('--w', '.6');
      await w.frames();
      w.visibility(true);
      w.visibility(false);
      await w.frames();
      raw.style.setProperty('--w', '.7');
      await w.frames();
      const during = w.sizes();
      ws.classList.remove('resizing');
      await w.frames();
      const { cols, rows } = w.term.proposeDimensions();
      return { during, after: w.sizes(), expected: [cols, rows] };
    });
    assert.deepEqual(result.during, []);
    assert.deepEqual(result.after, [result.expected]);
  });

  for (const first of [false, true]) {
    await t.test(`disconnect cancels the ${first ? 'first' : 'replacement'} snapshot paint hold`, async () => {
      const page = await rig(true, true);
      const state = await page.evaluate(async (first) => {
        const w = window as any,
          el = w.term.native.element;
        if (!first) {
          w.snapshot('previous screen');
          await w.frames();
        }
        w.snapshot('incomplete snapshot');
        w.net.up = false;
        w.connectionStatus(false);
        await w.frames();
        return [!!w.term.paintSignal, el.classList.contains('replaying'), el.textContent.includes('incomplete snapshot')];
      }, first);
      assert.deepEqual(state, [true, first, false]);
    });
  }

  for (const mode of ['inline', 'shell']) {
    await t.test(`${mode} keeps a painted grid visible throughout a same-size resync`, async () => {
      const page = await rig(true, true, false, mode);
      const frames = await page.evaluate(async () => {
        const w = window as any,
          el = w.term.native.element;
        w.snapshot('old screen');
        await w.frames();
        const sample = () => [getComputedStyle(el).opacity, el.querySelector('.term-grid').textContent.trim()];
        w.snapshot('new screen');
        const samples = [sample()];
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          samples.push(sample());
        }
        return samples;
      });
      assert.ok(
        frames.every(([opacity, text]) => opacity === '1' && /old screen|new screen/.test(text)),
        JSON.stringify(frames),
      );
      assert.match(frames.at(-1)![1], /new screen/);
    });
  }

  await t.test('a late detached snapshot cannot conceal the last visible grid', async () => {
    const page = await rig(true, true);
    const result = await page.evaluate(async () => {
      const w = window as any,
        el = w.term.native.element;
      w.snapshot('old screen');
      await w.frames();
      w.visibility(true);
      w.snapshot('late screen');
      w.visibility(false);
      await w.frames();
      return [el.classList.contains('replaying'), getComputedStyle(el).opacity, el.querySelector('.term-grid').textContent.trim()];
    });
    assert.deepEqual(result, [false, '1', 'old screen']);
  });

  await t.test('a viewport resize with no box change releases the next input claim', async () => {
    const page = await rig(true);
    const sizes = await page.evaluate(async () => {
      const w = window as any;
      window.dispatchEvent(new Event('resize'));
      await w.frames();
      w.term.input('x');
      return w.sizes();
    });
    assert.equal(sizes.length, 1);
  });

  await t.test('a stepped width animation retains its grid through quiet intermediate boxes', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any,
        pane = document.getElementById('mount')!;
      w.messages = [];
      const start = w.term.cols;
      const movement = pane.animate([{ width: '600px' }, { width: '400px' }], { duration: 500, easing: 'steps(3)', fill: 'forwards' });
      await movement.ready;
      const intermediate = [];
      while (movement.playState === 'running') {
        if (pane.offsetWidth < 600 && pane.offsetWidth > 400) intermediate.push([w.term.cols, w.sizes().length]);
        await new Promise(requestAnimationFrame);
      }
      await w.frames();
      return { start, intermediate, after: w.sizes(), final: w.term.cols };
    });
    assert.ok(result.intermediate.length > 1);
    assert.ok(result.intermediate.every(([cols, packets]: number[]) => cols === result.start && packets === 0));
    assert.deepEqual(
      result.after.map(([cols]: number[]) => cols),
      [result.final],
    );
    assert.ok(result.final < result.start);
  });

  await t.test('trusted paging during a shrinking layout leaves the reader at the paged offset', async () => {
    const page = await rig(false);
    await page.evaluate(async () => {
      const w = window as any,
        pane = document.getElementById('mount')!;
      w.term.write(Array.from({ length: 180 }, (_, i) => `line ${i}\r\n`).join(''));
      w.term.scrollToBottom();
      w.term.focus();
      await w.frames();
      // Two 12px steps: PageDown has 12px less travel than PageUp, and
      // the new bottom is 12px farther away. The reader should finish 24px up.
      pane.style.transition = 'height 60s steps(4)';
      pane.style.height = '302px';
      w.shrink = pane.getAnimations()[0];
      w.shrink.currentTime = 16000;
      await w.frames();
    });
    await page.keyboard.press('Shift+PageUp');
    await page.evaluate(async () => {
      const w = window as any;
      await w.frames();
      w.shrink.currentTime = 31000;
      await w.frames();
    });
    await page.keyboard.press('Shift+PageDown');
    const gap = await page.evaluate(async () => {
      const w = window as any;
      await w.frames();
      const el = w.term.native.element;
      return el.scrollHeight - el.clientHeight - el.scrollTop;
    });
    assert.equal(gap, 24);
  });

  for (const reading of [false, true]) {
    await t.test(`an animated shrink preserves the ${reading ? 'reader offset' : 'tail'} through intermediate boxes`, async () => {
      const page = await rig(false);
      const result = await page.evaluate(async (reading) => {
        const w = window as any,
          term = w.term,
          root = term.native.element,
          pane = document.getElementById('mount')!;
        term.write(Array.from({ length: 180 }, (_, i) => `line ${i}\r\n`).join(''));
        term.scrollToBottom();
        await w.frames();
        if (reading) root.scrollTop -= 280;
        await w.frames();
        const start = root.scrollTop,
          offset = () => (reading ? Math.abs(root.scrollTop - start) : root.scrollHeight - root.clientHeight - root.scrollTop),
          offsets: number[] = [];
        w.messages = [];
        const observation = term.onFit(() => offsets.push(offset()));
        pane.style.transition = 'height 320ms ease';
        pane.style.height = '210px';
        const shrink = pane.getAnimations()[0];
        // rAF runs before ResizeObserver. The first shrinking frame must already be pinned.
        let frames = 0;
        while (shrink.playState === 'running') {
          await new Promise(requestAnimationFrame);
          offsets.push(offset());
          if (++frames === 3) term.write('in flight\r\n');
        }
        await shrink.finished;
        await w.frames();
        observation.dispose();
        return { offsets, final: offset(), sizes: w.sizes(), live: root.textContent.includes('in flight') };
      }, reading);
      assert.ok(result.offsets.length > 2);
      assert.ok(Math.max(...result.offsets, result.final) < 1, JSON.stringify(result));
      assert.equal(result.sizes.length, 1);
      assert.equal(result.live, true);
    });
  }

  await t.test('the first painted snapshot stays concealed while its observed fit is pending', async () => {
    const page = await rig(false, true, false, 'dashboard');
    const state = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!,
        el = w.term.native.element;
      const painted = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!el.querySelector('.term-grid').textContent.includes('first screen')) return;
          observer.disconnect();
          raw.parentElement!.classList.add('resizing');
          raw.style.setProperty('--w', '.7');
          resolve();
        });
        observer.observe(el, { subtree: true, childList: true, characterData: true });
      });
      w.snapshot('first screen');
      await painted;
      await w.frames();
      const during = getComputedStyle(el).opacity;
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      await w.frames();
      return [during, getComputedStyle(el).opacity, w.term.cols, w.term.proposeDimensions().cols];
    });
    assert.deepEqual(state, ['0', '1', state[3], state[3]]);
  });

  await t.test('a sidebar toggle with a covered Raw terminal emits at most one resize', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const sizes = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.classList.add('covered');
      const thread = document.createElement('section');
      thread.className = 'dash-pane';
      thread.dataset.mode = 'thread';
      raw.after(thread);
      w.messages = [];
      const body = document.querySelector('.dash-body')!;
      body.classList.add('side-closed');
      await w.frames();
      await Promise.all(body.getAnimations().map((a) => a.finished));
      await w.frames();
      return w.sizes();
    });
    assert.ok(sizes.length <= 1, JSON.stringify(sizes));
  });

  await t.test('typing at successive splitter positions sends bytes immediately but claims only the final size', async () => {
    const page = await rig(true, false, false, 'dashboard');
    const sizes = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.parentElement!.classList.add('resizing');
      for (const [width, key] of [
        ['.4', 'a'],
        ['.7', 'b'],
      ]) {
        raw.style.setProperty('--w', width);
        await w.frames();
        w.term.input(key);
      }
      const during = w.sizes(),
        bytes = w.messages.filter((m: any) => m.t === 'term.input').map((m: any) => m.data);
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      const { cols, rows } = w.term.proposeDimensions();
      return { during, bytes, after: w.sizes(), expected: [cols, rows] };
    });
    assert.deepEqual(sizes.bytes, ['a', 'b']);
    assert.deepEqual(sizes.during, []);
    assert.deepEqual(sizes.after, [sizes.expected]);
  });

  for (const mode of ['inline', 'shell']) {
    await t.test(`${mode} snapshot-ready and input share the settling viewport fit`, async () => {
      const page = await rig(true, true, false, mode);
      const result = await page.evaluate(async () => {
        const w = window as any,
          pane = w.term.native.element.parentElement;
        const observed = () =>
          new Promise<void>((resolve) => {
            const sub = w.term.onFit(() => {
              sub.dispose();
              resolve();
            });
          });
        window.dispatchEvent(new Event('resize'));
        let next = observed();
        pane.style.width = '510px';
        await next;
        w.snapshot();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        w.term.input('x');
        const during = w.sizes(),
          bytes = w.messages.filter((m: any) => m.t.endsWith('.input')).map((m: any) => m.data);
        next = observed();
        pane.style.width = '730px';
        await next;
        await w.frames();
        const { cols, rows } = w.term.proposeDimensions();
        return { bytes, during, after: w.sizes(), expected: [cols, rows] };
      });
      assert.deepEqual(result.bytes, ['x']);
      assert.deepEqual(result.during, []);
      assert.deepEqual(result.after, [result.expected]);
    });
  }

  await t.test('removing the drag class without a pointer event resumes live painting', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const output = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.parentElement!.classList.add('resizing');
      raw.style.setProperty('--w', '.7');
      await w.frames();
      w.term.write('still streaming');
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      return w.term.native.element.textContent;
    });
    assert.match(output, /still streaming/);
  });

  await t.test('hiding a tab or disposing a pane clears its unfinished fit', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.parentElement!.classList.add('resizing');
      raw.style.setProperty('--w', '.7');
      await w.frames();
      w.visibility(true);
      const hiddenFit = w.term.fitting;
      raw.parentElement!.classList.remove('resizing');
      w.visibility(false);
      await w.frames();
      w.term.write('paint after interrupted drag');
      await w.frames();
      const painted = w.term.native.element.textContent.includes('paint after interrupted drag');
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      raw.parentElement!.classList.add('resizing');
      raw.style.setProperty('--w', '.4');
      await w.frames();
      w.messages = [];
      w.handle.close();
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      return [hiddenFit, painted, w.term.fitting, w.sizes()];
    });
    assert.deepEqual(result, [false, true, false, []]);
  });

  await t.test('the divider stays on the terminal edge, and Thread-only dividers still animate', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const raw = document.querySelector<HTMLElement>('#mount')!,
        handle = document.createElement('div');
      handle.className = 'dash-handle col';
      handle.style.setProperty('--at', '.5');
      raw.after(handle);
      await Promise.all(raw.getAnimations().map((a) => a.finished));
      const offset = () => handle.getBoundingClientRect().left + 4 - raw.getBoundingClientRect().right;
      const offsets = [offset()];
      raw.style.setProperty('--w', '.7');
      handle.style.setProperty('--at', '.7');
      for (let i = 0; i < 6; i++) {
        await new Promise(requestAnimationFrame);
        offsets.push(offset());
      }
      raw.dataset.mode = 'thread';
      return { offsets, threadOnly: getComputedStyle(handle).transitionProperty };
    });
    assert.ok(
      result.offsets.every((n) => Math.abs(n) < 1),
      `divider offsets: ${result.offsets}`,
    );
    assert.match(result.threadOnly, /left/);
  });

  await t.test('reduced motion disables all mixed-pane and divider transitions', async () => {
    const page = await rig(false, false, false, 'dashboard');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const properties = await page.evaluate(() => {
      const raw = document.querySelector<HTMLElement>('#mount')!,
        thread = document.createElement('section'),
        handle = document.createElement('div');
      thread.className = 'dash-pane';
      thread.dataset.mode = 'thread';
      handle.className = 'dash-handle col';
      raw.after(thread, handle);
      return [raw, thread, handle].map((el) => getComputedStyle(el).transitionProperty);
    });
    assert.deepEqual(properties, ['none', 'none', 'none']);
  });

  await t.test('dashboard sidebar breakpoints and pane splits send only the settled grid', async () => {
    const page = await rig(false, false, false, 'dashboard');
    await page.setViewportSize({ width: 1120, height: 720 });
    const settle = () =>
      page.evaluate(async () => {
        const w = window as any;
        await w.frames();
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished),
        );
        await w.frames();
        const sizes = w.sizes();
        w.messages = [];
        return sizes;
      });
    await settle();
    // The sidebar itself shrinks by 32px. Change the half-pane by more than a terminal cell.
    for (const width of [1020, 1230]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal((await settle()).length, 1, 'one resize across the responsive sidebar breakpoint');
    }
    await page.locator('#mount').evaluate((el) => el.style.setProperty('--w', '1'));
    assert.equal((await settle()).length, 1, 'one resize when the terminal takes the full workspace');
    await page.evaluate(async () => {
      const pane = document.getElementById('mount')!;
      pane.parentElement!.classList.add('resizing');
      for (const width of ['0.4', '0.5', '0.6']) {
        pane.style.setProperty('--w', width);
        await (window as any).frames();
      }
    });
    assert.deepEqual(await settle(), [], 'a live divider drag does not repeatedly reflow the PTY');
    await page.evaluate(async () => {
      const w = window as any;
      w.term.write('output during drag');
      await w.frames();
    });
    assert.ok(!(await page.locator('.term-grid').innerText()).includes('output during drag'), 'the previous complete grid stays painted');
    await page.evaluate(() => {
      const workspace = document.querySelector('.dash-workspace')!;
      workspace.classList.remove('resizing');
      const handle = document.createElement('div');
      handle.className = 'dash-handle';
      workspace.append(handle);
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    assert.equal((await settle()).length, 1, 'release commits the last observed box even when the pointer stopped moving');
    assert.match(await page.locator('.term-grid').innerText(), /output during drag/);
  });

  await t.test('a Thread pane stays next to a visible Raw TTY throughout a layout change', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const raw = document.querySelector<HTMLElement>('#mount')!;
      const thread = document.createElement('section');
      thread.className = 'dash-pane';
      thread.dataset.mode = 'thread';
      thread.style.cssText = '--x:.5;--y:0;--w:.5;--h:1;--gl:3px;--gr:0px;--gt:0px;--gb:0px';
      raw.style.setProperty('--gr', '3px');
      raw.after(thread);
      // Both newly mounted panes scale around their centers before layout begins.
      await Promise.all([raw, thread].flatMap((el) => el.getAnimations().map((a) => a.finished)));
      const gap = () => thread.getBoundingClientRect().left - raw.getBoundingClientRect().right;
      const samples = [gap()];
      for (const width of ['.333333', '.5']) {
        raw.style.setProperty('--w', width);
        thread.style.setProperty('--x', width);
        thread.style.setProperty('--w', width);
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          samples.push(gap());
        }
      }
      raw.hidden = true;
      return { samples, threadOnly: getComputedStyle(thread).transitionProperty };
    });
    assert.ok(
      result.samples.every((value) => Math.abs(value - 6) <= 1),
      `6px divider gaps: ${result.samples}`,
    );
    assert.match(result.threadOnly, /\bwidth\b/, 'Thread-only workspaces still animate');
  });

  await t.test('shared attachment stays passive, but each pane size change claims its new box', async () => {
    const page = await rig();
    assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    for (const [width, height] of [
      [600, 700],
      [1000, 700],
      [600, 350],
    ]) {
      await page.evaluate(([width, height]) => (window as any).resize(width, height), [width, height]);
      await page.evaluate(() => (window as any).frames());
      const state = await page.evaluate(() => {
        const w = window as any;
        const size = [w.term.cols, w.term.rows];
        // An unrelated status update still has the old server size.
        w.update();
        return { size, after: [w.term.cols, w.term.rows], sent: w.sizes().at(-1), focused: document.activeElement?.id };
      });
      assert.deepEqual(state.sent, state.size);
      assert.deepEqual(state.after, state.size, 'stale worker metadata cannot roll back the local fit');
      assert.equal(state.focused, 'focus');
    }
    await page.evaluate(() => {
      const w = window as any;
      const final = [w.term.cols, w.term.rows];
      for (const [cols, rows] of w.sizes()) {
        w.update(cols, rows);
        if (w.term.cols !== final[0] || w.term.rows !== final[1]) throw Error('An earlier acknowledgement rolled back the final size');
      }
      w.update(90, 25);
    });
    assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), [90, 25], 'a genuine resize from another window is still adopted');
    const before = await page.evaluate(() => (window as any).sizes().length);
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), before, 'following another window must not create a resize loop');
    await page.evaluate(() => (window as any).resize(700, 400));
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), before + 1);
  });

  await t.test('a hidden following pane detaches once, ignores late snapshots, and hydrates once on return', async () => {
    const page = await rig();
    await page.evaluate(() => {
      const w = window as any;
      w.messages = [];
      w.writes = 0;
      const write = w.term.write.bind(w.term);
      w.term.write = (...args: any[]) => {
        w.writes++;
        return write(...args);
      };
      w.visibility(true);
      w.visibility(true);
      w.handle.attach();
      w.snapshot();
      w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: 'pixel', data: 'invisible output' });
    });
    assert.deepEqual(
      await page.evaluate(() => {
        const w = window as any;
        return { messages: w.messages.map((m: any) => m.t), writes: w.writes, stdinDisabled: w.term.options.disableStdin };
      }),
      { messages: ['worker.detach'], writes: 0, stdinDisabled: true },
    );
    await page.evaluate(() => (window as any).visibility(false));
    await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    await page.evaluate(() => (window as any).visibility(false));
    assert.deepEqual(await page.evaluate(() => (window as any).messages.map((m: any) => m.t)), ['worker.detach', 'worker.attach']);
    await page.evaluate(() => {
      const w = window as any;
      w.handle.close();
      w.messages = [];
      w.visibility(true);
      w.visibility(false);
    });
    assert.deepEqual(await page.evaluate(() => (window as any).messages), []);
  });

  await t.test('initially hidden panes wait for visibility; reconnecting while hidden does not attach early', async () => {
    const page = await rig(true, false, false, 'inline', true);
    assert.deepEqual(await page.evaluate(() => (window as any).messages.map((m: any) => m.t)), ['worker.detach']);
    await page.evaluate(() => {
      const w = window as any;
      w.net.up = false;
      w.connectionStatus(false);
      w.net.up = true;
      w.connectionStatus(true);
      w.handle.attach();
    });
    assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'worker.attach').length), 0);
    await page.evaluate(() => (window as any).visibility(false));
    await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'worker.attach').length), 1);
  });

  await t.test('a scrolled-up reader keeps its exact history and input readiness across backgrounding', async () => {
    const page = await rig();
    await page.evaluate(async () => {
      const w = window as any;
      await new Promise<void>((resolve) => w.term.write(Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join(''), resolve));
      await new Promise(requestAnimationFrame);
      w.term.native.element.scrollTop = 0;
    });
    await page.waitForFunction(() => {
      const b = (window as any).term.buffer.active;
      return b.baseY > 0 && b.viewportY === 0;
    });
    const before = await page.evaluate(() => {
      const w = window as any;
      w.messages = [];
      w.visibility(true);
      return { viewport: w.term.buffer.active.viewportY, base: w.term.buffer.active.baseY };
    });
    assert.ok(before.base > before.viewport);
    await page.evaluate(() => (window as any).visibility(false));
    assert.deepEqual(await page.evaluate(() => (window as any).messages), []);
    assert.equal(await page.evaluate(() => (window as any).term.buffer.active.viewportY), before.viewport);
    assert.equal(await page.evaluate(() => (window as any).term.options.disableStdin), false);
  });

  await t.test('first visible desk cells are the painted PTY snapshot, never the provisional 80×24 grid', async () => {
    const page = await rig(true, true);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root = w.term.native.element;
      const before = [w.term.cols, w.term.rows, getComputedStyle(root).opacity, root.querySelector('.term-grid').getBoundingClientRect().height];
      const visible: number[][] = [];
      w.snapshot(Array.from({ length: 120 }, (_, i) => `settled row ${i}\r\n`).join(''));
      for (let i = 0; i < 10; i++) {
        await new Promise(requestAnimationFrame);
        if (getComputedStyle(root).opacity !== '0') visible.push([w.term.cols, w.term.rows, root.scrollTop]);
      }
      return { before, visible, tail: root.scrollHeight - root.clientHeight, text: root.textContent.includes('settled row 119') };
    });
    assert.deepEqual(result.before, [80, 24, '0', 0]);
    assert.ok(result.visible.length && result.text);
    assert.ok(result.tail > 0);
    for (const grid of result.visible) assert.deepEqual(grid, [120, 40, result.tail]);
  });

  await t.test('initial unshared fit survives the snapshot refresh before its acknowledgement', async () => {
    const page = await rig(false);
    const state = await page.evaluate(() => {
      const w = window as any;
      return { size: [w.term.cols, w.term.rows], sent: w.sizes() };
    });
    assert.equal(state.sent.length, 1);
    assert.deepEqual(state.size, state.sent[0]);
    assert.notDeepEqual(state.size, [120, 40]);
  });

  await t.test('first revealing a shared terminal is passive, including repeated hide/show at the same size', async () => {
    const page = await rig(true, false, true);
    for (const display of ['', 'none', '']) {
      await page.evaluate((display) => {
        document.getElementById('mount')!.style.display = display;
      }, display);
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    }
  });

  await t.test('A to B to A cannot consume pending acknowledgements from stale status at A', async () => {
    const page = await rig(false);
    const original = await page.evaluate(() => {
      const w = window as any;
      const original = [w.term.cols, w.term.rows];
      w.update(...original);
      w.messages = [];
      return original;
    });
    for (const width of [800, 600]) {
      await page.evaluate((width) => (window as any).resize(width, 350), width);
      await page.evaluate(() => (window as any).frames());
    }
    const sizes = await page.evaluate(() => (window as any).sizes());
    assert.equal(sizes.length, 2);
    assert.deepEqual(sizes[1], original);
    await page.evaluate(() => (window as any).update());
    for (const size of sizes) {
      await page.evaluate((size) => (window as any).update(...size), size);
      assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), original);
    }
  });

  await t.test('pane changes while a snapshot is loading fit when it becomes ready', async () => {
    const page = await rig(true, true);
    await page.evaluate(() => (window as any).resize(900, 600));
    await page.evaluate(() => (window as any).frames());
    assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    await page.evaluate(() => (window as any).snapshot());
    await page.waitForFunction(() => (window as any).sizes().length === 1);
    assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), await page.evaluate(() => (window as any).sizes()[0]));
  });

  await t.test('small and oversized panes use the PTY limits and do not repeat clamped requests', async () => {
    const page = await rig();
    for (const [width, height, expected] of [
      [100, 50, [20, 5]],
      [8000, 8000, [400, 200]],
    ] as const) {
      await page.evaluate(([width, height]) => (window as any).resize(width, height), [width, height]);
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await page.evaluate(() => (window as any).sizes().at(-1)), expected);
      await page.evaluate((size) => (window as any).update(...size), expected);
    }
    const count = await page.evaluate(() => (window as any).sizes().length);
    await page.evaluate(() => (window as any).resize(8500, 8500));
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), count);
  });
});
