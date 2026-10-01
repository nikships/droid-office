// The headset app names no controls: no aim labels, control hints or "press E" text, so with the
// workspace closed the FPS counter is the only text that stays in view. Desktop and WebXR keep theirs.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { controlHintsShown, withControlHint } from '../src/client/native/mode.js';
import { nativeStatus } from '../src/client/native/performance.js';
import { ServicesBoardTexture } from '../src/client/world/boards.js';
import { MachineTexture } from '../src/client/world/machine.js';
import type { MachineState, ProxyState } from '../src/shared/protocol.js';

/** Text that tells you which key, button or gesture does something. */
const CONTROL = [
  /\b[Pp]ress(?:es)? (?:[A-Z]\b|the (?:controller )?trigger|trigger|grip)/,
  /\bPRESS [A-Z]\b/,
  /\b[A-Z] (?:again|opens)\b/,
  /\((?:or )?[A-Z](?: to [^)]*)?\)/,
  /\b(?:trigger|grip|squeeze|pinch|thumbstick)\b/i,
  /\b(?:Shift|Ctrl|Alt)\+|⌘/,
  /\bEsc\b/,
  /\b(?:[Aa]im|[Pp]oint) at\b/,
  /\bclick\b/i,
];
const namesControl = (text: string) => CONTROL.some((re) => re.test(text));

const page = (t: TestContext, search: string) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search } });
  t.after(() => (previous ? Object.defineProperty(globalThis, 'location', previous) : Reflect.deleteProperty(globalThis, 'location')));
};

test('control hints show on the desktop and in WebXR, never in the headset app', (t) => {
  assert.equal(controlHintsShown(''), true);
  assert.equal(controlHintsShown('?native=0'), true);
  assert.equal(controlHintsShown('?native=1'), false);
  assert.equal(controlHintsShown(), true, 'no page (a test, a worker) is not the headset app');
  page(t, '?native=1');
  assert.equal(controlHintsShown(), false);
  assert.equal(withControlHint('🙋 Pixel needs input', '. E opens its terminal'), '🙋 Pixel needs input');
  assert.equal(withControlHint('Your hands are full: put #12 down first', ' (Q)'), 'Your hands are full: put #12 down first');
});

test('desktop text keeps its control hints, character for character', (t) => {
  page(t, '?x=1');
  assert.equal(withControlHint('🙋 Pixel needs input', '. E opens its terminal'), '🙋 Pixel needs input. E opens its terminal');
  assert.equal(withControlHint('Your hands are full: put #12 down first', ' (Q)'), 'Your hands are full: put #12 down first (Q)');
});

test('the closed-workspace status shows the FPS counter when it is on, and otherwise only a passing toast', () => {
  const metrics = { fps: 90.015, refresh: 90, focused: true, controlAgeMs: 30, scene: { objects: 1500, drawCalls: 150, stateSerial: 2 } };
  assert.deepEqual(nativeStatus(metrics, true, ''), { aim: '90.0 fps · 90 Hz', message: '' });
  assert.deepEqual(nativeStatus({ ...metrics, controlAgeMs: 2000 }, true, ''), { aim: '90.0 fps · 90 Hz · Office delayed', message: '' });
  assert.deepEqual(nativeStatus(undefined, true, ''), { aim: 'Measuring FPS…', message: '' });
  assert.deepEqual(nativeStatus(metrics, false, ''), { aim: '', message: '' }, 'the counter off leaves nothing to show, so the panel hides');
  assert.deepEqual(nativeStatus(metrics, true, 'Merged #12 🎉'), { aim: '90.0 fps · 90 Hz', message: 'Merged #12 🎉' });
  assert.equal(namesControl(nativeStatus(metrics, true, '').aim), false);
});

// ---- Source guards: new text has to choose desktop-only hints on purpose ----

const ROOT = new URL('../src/client/', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Index after the string, template or parenthesized expression that opens at `i`. */
function skip(src: string, i: number): number {
  const open = src[i];
  if (open === "'" || open === '"') {
    for (i++; i < src.length && src[i] !== open; i++) if (src[i] === '\\') i++;
    return i + 1;
  }
  if (open === '`') {
    for (i++; i < src.length && src[i] !== '`'; i++) {
      if (src[i] === '\\') i++;
      else if (src[i] === '$' && src[i + 1] === '{') {
        let depth = 0;
        for (i++; i < src.length; i++) {
          const c = src[i];
          if (c === "'" || c === '"' || c === '`') i = skip(src, i) - 1;
          else if (c === '{') depth++;
          else if (c === '}' && --depth === 0) break;
        }
      }
    }
    return i + 1;
  }
  // '(': to the matching ')'.
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') i = skip(src, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return i;
}

/** The argument text of every `name(…)` call in `src` that is not a method of something else. */
function calls(src: string, name: string): { args: string; line: number }[] {
  const out: { args: string; line: number }[] = [];
  for (const m of src.matchAll(new RegExp(`(?<![\\w$])${name}\\(`, 'g'))) {
    const open = m.index + name.length;
    out.push({ args: src.slice(open + 1, skip(src, open) - 1), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** `text` without its withControlHint(…) calls: the hint inside one only shows where hints are shown. */
function unhinted(text: string): string {
  let out = text;
  for (let at = out.indexOf('withControlHint('); at >= 0; at = out.indexOf('withControlHint(')) out = out.slice(0, at) + out.slice(skip(out, at + 'withControlHint'.length));
  return out;
}

test('every toast that names a control is a hint toast, or keeps the control in withControlHint', () => {
  // WebXR's own world-space UI (vr/) is the browser headset's, which keeps its hints.
  const files = sources(ROOT).filter((path) => !path.includes('/vr/'));
  const offenders: string[] = [];
  for (const path of files) {
    const src = readFileSync(path, 'utf8');
    for (const { args, line } of calls(src, 'toast')) {
      const text = unhinted(args);
      if (namesControl(text)) offenders.push(`${relative(ROOT, path)}:${line}: toast(${args.slice(0, 100)})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the guard itself catches a control named in a toast', () => {
  const src = `toast(\`✋ You took #\${n} off the board: press E\`); hintToast('Hold grip to draw'); toast(withControlHint('Full', ' (Q)'));`;
  const named = calls(src, 'toast').filter(({ args }) => namesControl(unhinted(args)));
  assert.equal(named.length, 1);
  assert.match(named[0].args, /press E/);
});

/** Lines of these files whose prose names a control without being gated on that line. */
function ungatedControlText(files: string[]): string[] {
  const offenders: string[] = [];
  for (const path of files) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        // Prose only: a one-word string is an identifier, such as the 'click' event.
        const strings = [...line.matchAll(/'[^']*'|`[^`]*`|"[^"]*"/g)].map((m) => m[0]).filter((s) => /\s/.test(s));
        if (!strings.some(namesControl)) return;
        if (/controlHintsShown\(\)|withControlHint\(/.test(line)) return;
        offenders.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  return offenders;
}

test('signs, boards and screens in the world name no controls in the headset app', () => {
  // Canvas text drawn onto world objects: every line that names a control is gated on that line.
  assert.deepEqual(ungatedControlText([...sources(join(ROOT, 'world')), join(ROOT, 'ui/blocks.ts'), join(ROOT, 'ui/cabinet.ts'), join(ROOT, 'ui/minesweeper.ts')]), []);
});

test('the hire and ask forms a desk or kiosk opens name no keys in the headset app', () => {
  assert.deepEqual(ungatedControlText([join(ROOT, 'ui/prompt.ts'), join(ROOT, 'ui/ask.ts')]), []);
});

test('the headset app adds no control hints of its own outside the Controls window', () => {
  const ui = readFileSync(join(ROOT, 'native/ui.ts'), 'utf8');
  // A string compared with === is the desktop text the panel replaces, never shown itself.
  const strings = [...ui.matchAll(/(?<!===\s*)('[^'\n]*'|`[^`\n]*`)/g)].map((m) => m[1]).filter(namesControl);
  assert.deepEqual(strings, []);
  const activity = readFileSync(new URL('../native/android/app/src/main/java/dev/droidoffice/xr/OfficeActivity.java', import.meta.url), 'utf8');
  const javaStrings = [...activity.matchAll(/"[^"\n]*"/g)].map((m) => m[0]).filter((s) => namesControl(s) || /motion controller/i.test(s));
  assert.deepEqual(javaStrings, []);
});

/** Stands in for any canvas member a painter reaches for: callable, and every member is itself. */
const anything: unknown = new Proxy(() => {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : anything), apply: () => anything });

/** A page with `search` as its query whose canvases record every line of text drawn on them. */
function canvasPage(t: TestContext, search: string): string[] {
  page(t, search);
  const drawn: string[] = [];
  const context: object = new Proxy({ measureText: (text: string) => ({ width: text.length * 12 }), fillText: (text: string) => drawn.push(text) }, { get: (target, key) => Reflect.get(target, key) ?? anything });
  const stand = (key: 'document' | 'Path2D', value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key)));
  };
  stand('document', { createElement: () => ({ width: 1, height: 1, getContext: () => context }) });
  // Glyph outlines (world/glyph.ts) are paths; only the text drawn matters here.
  stand('Path2D', function Path2D() {
    return anything;
  });
  return drawn;
}

const MACHINE: MachineState = { cpu: 12, cores: 8, memUsed: 4e9, memTotal: 16e9, history: [], workers: 2, limit: 6 };
const PROXY: ProxyState = { running: true, at: 1, accounts: [{ provider: 'claude', label: 'Claude', windows: [{ label: '5h', pct: 20 }] }] };

test('the Services board and the proxy refresh key state what is so, without help words, in the headset app', (t) => {
  const drawn = canvasPage(t, '?native=1');
  new ServicesBoardTexture().render([], new Map());
  assert.ok(drawn.includes('No web servers running'));
  assert.ok(!drawn.includes('When a worker starts one, it shows up here'));
  new MachineTexture().render(MACHINE, PROXY);
  assert.ok(drawn.includes('↻') && !drawn.includes('↻ REFRESH'), 'the refresh key carries only its glyph');
  new MachineTexture().render(MACHINE, { ...PROXY, refreshing: true });
  assert.ok(drawn.includes('READING…'), 'a read under way still says so');
});

test('the desktop Services board and refresh key keep their words', (t) => {
  const drawn = canvasPage(t, '');
  new ServicesBoardTexture().render([], new Map());
  assert.ok(drawn.includes('When a worker starts one, it shows up here'));
  new MachineTexture().render(MACHINE, PROXY);
  assert.ok(drawn.includes('↻ REFRESH'));
});
