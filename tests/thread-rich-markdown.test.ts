import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { attachCopyFeedback, codeLanguageLabel, highlightCodeBlock, highlightLine, MAX_HIGHLIGHT_CHARS, preloadCodeLanguage, renderCodeFrame, resolveCodeLanguage, tokenizeCode } from '../src/client/ui/code-highlight.js';
import { drawDiagram, renderMermaidSvg, renderThreadMermaid } from '../src/client/ui/diagram.js';
import { formatFilePreviewBytes, normalizeFilePreviewResponse, openFilePreviewModal, threadFilePreviewUrl } from '../src/client/ui/file-preview.js';
import { extractMathSegments, parseWorkspacePathRefs, renderMathToMathMl, threadMarkdown, threadUserMarkdown } from '../src/client/ui/thread-markdown.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { localImagePath } from '../src/shared/worker-thread.js';

test('all five rich-markdown modules load cleanly in Node without touching window or document at import time', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof highlightCodeBlock, 'function');
  assert.equal(typeof renderMermaidSvg, 'function');
  assert.equal(typeof renderThreadMermaid, 'function');
  assert.equal(typeof drawDiagram, 'function');
  assert.equal(typeof threadMarkdown, 'function');
  assert.equal(typeof threadUserMarkdown, 'function');
  assert.equal(typeof openFilePreviewModal, 'function');
});

test('none of the rich-markdown client UI modules pass inline style attributes in h() calls', () => {
  for (const rel of ['code-highlight.ts', 'json-render.ts', 'diagram.ts', 'thread-markdown.ts', 'file-preview.ts']) {
    const src = readFileSync(new URL(`../src/client/ui/${rel}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bh\([^)]*\bstyle\s*:/, `${rel} must not pass style: to h()`);
  }
});

test('resolveCodeLanguage and tokenizeCode highlight common languages and cap oversized inputs', async () => {
  assert.equal(resolveCodeLanguage('ts')?.name, 'TypeScript');
  assert.equal(resolveCodeLanguage('tsx')?.name, 'TSX');
  assert.equal(resolveCodeLanguage('py')?.name, 'Python');
  assert.equal(resolveCodeLanguage('kt')?.name, 'Kotlin');
  assert.equal(resolveCodeLanguage('rs')?.name, 'Rust');
  assert.equal(resolveCodeLanguage('sh')?.name, 'Shell');
  assert.equal(resolveCodeLanguage('src/client/ui/dom.ts:42-50')?.name, 'TypeScript');
  assert.equal(resolveCodeLanguage('.env.example')?.name, 'Shell');
  assert.equal(resolveCodeLanguage('biome.jsonc')?.name, 'JSON');
  assert.equal(resolveCodeLanguage('plaintext'), null);
  assert.equal(codeLanguageLabel('ts'), 'TypeScript');
  assert.equal(codeLanguageLabel(''), 'code');

  const tsTokens = await tokenizeCode('export const count: number = 42; // answer', 'ts');
  assert.ok(tsTokens.some((tok) => tok.cls.includes('tok-kw') && tok.text === 'export'));
  assert.ok(tsTokens.some((tok) => tok.cls.includes('tok-type') && tok.text === 'number'));
  assert.ok(tsTokens.some((tok) => tok.cls.includes('tok-num') && tok.text === '42'));
  assert.ok(tsTokens.some((tok) => tok.cls.includes('tok-cmt') && tok.text.includes('// answer')));

  const diffTokens = await tokenizeCode('+added line\n-removed line', 'diff');
  assert.ok(diffTokens.some((tok) => tok.cls.includes('tok-ins')));
  assert.ok(diffTokens.some((tok) => tok.cls.includes('tok-del')));

  const huge = 'const a = 1;\n'.repeat(Math.ceil((MAX_HIGHLIGHT_CHARS + 100) / 13));
  const capped = await tokenizeCode(huge, 'ts');
  assert.equal(capped.length, 1);
  assert.equal(capped[0].cls, '');
});

test('code-highlight DOM helpers upgrade in place, reuse cached parsers, and handle copy feedback timers', async (t) => {
  class MiniNode {
    tagName: string;
    className = '';
    textContent = '';
    hidden = false;
    tabIndex = -1;
    scrollWidth = 0;
    clientWidth = 0;
    scrollLeft = 0;
    connected = true;
    attrs = new Map<string, string>();
    children: (MiniNode | string)[] = [];
    listeners = new Map<string, (() => void)[]>();

    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
    }

    get isConnected() {
      return this.connected;
    }

    get classList() {
      const list = () => this.className.split(/\s+/).filter(Boolean);
      return {
        add: (...names: string[]) => {
          const s = new Set(list());
          for (const n of names) if (n) s.add(n);
          this.className = [...s].join(' ');
        },
        remove: (...names: string[]) => {
          const drop = new Set(names);
          this.className = list()
            .filter((x) => !drop.has(x))
            .join(' ');
        },
        toggle: (name: string, force?: boolean) => {
          const has = list().includes(name);
          const on = force ?? !has;
          if (on) this.classList.add(name);
          else this.classList.remove(name);
          return on;
        },
        contains: (name: string) => list().includes(name),
      };
    }

    setAttribute(k: string, v: string) {
      if (k === 'class') this.className = v;
      this.attrs.set(k, v);
    }

    addEventListener(type: string, fn: () => void) {
      const arr = this.listeners.get(type) ?? [];
      arr.push(fn);
      this.listeners.set(type, arr);
    }

    trigger(type: string) {
      for (const fn of this.listeners.get(type) ?? []) fn();
    }

    append(...items: (MiniNode | string)[]) {
      for (const item of items) {
        if (item instanceof MiniNode && item.tagName === '#FRAGMENT') {
          this.children.push(...item.children);
        } else {
          this.children.push(item);
        }
      }
      this.textContent = this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }

    replaceChildren(...items: (MiniNode | string)[]) {
      this.children = [];
      this.append(...items);
    }

    replaceWith(_next: unknown) {}

    querySelector(sel: string): MiniNode | null {
      const cls = sel.startsWith('.') ? sel.slice(1) : '';
      for (const c of this.children) {
        if (c instanceof MiniNode) {
          if (cls && c.classList.contains(cls)) return c;
          const nested = c.querySelector(sel);
          if (nested) return nested;
        }
      }
      return null;
    }
  }

  let copiedText = '';
  const prevNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: MiniNode });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new MiniNode(tag),
      createDocumentFragment: () => new MiniNode('#fragment'),
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (txt: string) => {
          copiedText = txt;
        },
      },
    },
  });
  t.after(() => {
    if (prevNode) Object.defineProperty(globalThis, 'Node', prevNode);
    else Reflect.deleteProperty(globalThis, 'Node');
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  await preloadCodeLanguage('ts');
  const frame = renderCodeFrame('const ready = true;', { lang: 'ts' }) as unknown as MiniNode;
  assert.ok(frame.classList.contains('wt-code-block'));
  assert.equal(frame.querySelector('.wt-code-lang')?.textContent, 'TypeScript');

  const lineFrag = highlightLine('let x = 1;', 'ts') as unknown as MiniNode;
  assert.ok(lineFrag.children.length > 1);

  const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));

  const copyBtn = frame.querySelector('.wt-code-copy')!;
  copyBtn.trigger('click');
  await flushMicrotasks();
  assert.equal(copiedText, 'const ready = true;');
  assert.equal(copyBtn.textContent, 'Copied');
  assert.ok(copyBtn.classList.contains('copied'));

  // Clean up timer via attachCopyFeedback reset pattern.
  const customBtn = new MiniNode('button') as unknown as HTMLButtonElement;
  const cleanup = attachCopyFeedback(customBtn, () => 'abc', 'Copy');
  (customBtn as unknown as MiniNode).trigger('click');
  await flushMicrotasks();
  cleanup();
  assert.equal(customBtn.textContent, 'Copy');
});

test('extractMathSegments and renderMathToMathMl render TeX math without triggering on currency, env vars, or code', () => {
  // Currency, ranges, shell variables, URLs, inline code, and fenced code must NEVER trigger math.
  const currencyCases = [
    'The plan costs $100 per month.',
    'Expect between $50 - $100 or $50-$100 for cloud compute.',
    'Refunded $0.00 today, and $100$ is plain digits.',
    'Escaped \\$x^2\\$ stays literal.',
    'Check $PATH and $HOME/$USER in shell.',
    'Inline `$x^2 + y^2$` and URL https://example.com/$a$/$b$ stay untouched.',
    '```tex\n$x^2 + y^2$\n$$E = mc^2$$\n```',
  ];
  for (const sample of currencyCases) {
    const res = extractMathSegments(sample);
    assert.equal(res.segments.length, 0, `expected 0 math segments for: ${sample}`);
    assert.equal(res.textWithPlaceholders, sample);
  }

  // Valid inline and display math extract cleanly, including subscripts with underscores.
  const mixed = ['Given $x_1^2 + y_1^2 = r^2$ and cost $100, compute:', '', '$$', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', '$$'].join('\n');

  const parsed = extractMathSegments(mixed);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].display, false);
  assert.equal(parsed.segments[0].tex, 'x_1^2 + y_1^2 = r^2');
  assert.equal(parsed.segments[1].display, true);
  assert.match(parsed.segments[1].tex, /\\sum_\{i=1\}\^\{n\}/);
  assert.match(parsed.textWithPlaceholders, /\$100/);

  const inlineMl = renderMathToMathMl(parsed.segments[0].tex, false);
  assert.ok(inlineMl);
  assert.match(inlineMl, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML">/);
  assert.doesNotMatch(inlineMl, /\bstyle\s*=/i);
  assert.doesNotMatch(inlineMl, /<annotation/i);

  const displayMl = renderMathToMathMl(parsed.segments[1].tex, true);
  assert.ok(displayMl);
  assert.match(displayMl, /display="block"/);
  assert.doesNotMatch(displayMl, /\bstyle\s*=/i);

  // Incomplete streaming TeX returns null rather than a styled error span.
  assert.equal(renderMathToMathMl('\\frac{1}{', false), null);
});

test('parseWorkspacePathRefs matches workspace paths and line ranges while rejecting URLs, domains, mentions, and .. segments', () => {
  const prose = [
    'Updated src/client/ui/thread-markdown.ts:42-51, (./src/client/ui/diagram.ts:18),',
    'android/app/src/main/java/ai/factory/office/Thread.kt:88, and README.md:12.',
    'Ignored: https://github.com/nikships/droid-office/blob/main/src/foo.ts, mailto:nik@factory.ai,',
    '@nikships, @codemirror/language-data, @codemirror/view/dist/index.js,',
    'factory.ai, factory.ai/guild, docs.factory.ai/llms.txt, github.com/user/repo.git, x.com/factory,',
    'localhost:4600/api/thread/file.json, /Users/nik/repos/foo.ts, ~/secret/key.pem, ../outside.ts, src/../escape.ts, before/after.',
  ].join(' ');

  const hits = parseWorkspacePathRefs(prose);
  assert.deepEqual(
    hits.map((h) => ({ path: h.path, line: h.line, endLine: h.endLine })),
    [
      { path: 'src/client/ui/thread-markdown.ts', line: 42, endLine: 51 },
      { path: 'src/client/ui/diagram.ts', line: 18, endLine: undefined },
      { path: 'android/app/src/main/java/ai/factory/office/Thread.kt', line: 88, endLine: undefined },
      { path: 'README.md', line: 12, endLine: undefined },
    ],
  );
});

test('localImagePath finds the files on the office machine Markdown images name and leaves web URLs alone', () => {
  assert.equal(localImagePath('/Users/nik/Pictures/chaise-room-designs/02-cozy-media-den.png'), '/Users/nik/Pictures/chaise-room-designs/02-cozy-media-den.png');
  assert.equal(localImagePath(' <~/Pictures/a b.png> '), '~/Pictures/a b.png');
  assert.equal(localImagePath('docs/chart.svg'), 'docs/chart.svg');
  assert.equal(localImagePath('file:///tmp/shot%201.png'), '/tmp/shot 1.png');
  assert.equal(localImagePath('file://localhost/tmp/a.png'), '/tmp/a.png');
  for (const web of ['https://example.com/a.png', 'http://192.168.1.2:4600/a.png', 'data:image/png;base64,AAAA', 'blob:abc', '//cdn.example.com/a.png', '#top', '', 'bad%E0%A4%A.png']) {
    assert.equal(localImagePath(web), undefined, web);
  }
});

test('file-preview helpers normalize text, binary, truncated, and error responses cleanly', () => {
  assert.equal(threadFilePreviewUrl({ floor: 'main', workerId: 'w1', path: 'src/a.ts' }), '/api/thread/file?floor=main&worker=w1&path=src%2Fa.ts');
  assert.equal(formatFilePreviewBytes(512), '512 B');
  assert.equal(formatFilePreviewBytes(2048), '2.0 KB');
  assert.equal(formatFilePreviewBytes(2 * 1024 * 1024), '2.0 MB');

  const ok = normalizeFilePreviewResponse({ path: 'src/a.ts', content: 'line 1\r\nline 2\r\n', truncated: true, size: 14 });
  assert.deepEqual(ok.lines, ['line 1', 'line 2']);
  assert.equal(ok.truncated, true);
  assert.equal(ok.binary, false);

  const bin = normalizeFilePreviewResponse({ path: 'icon.png', binary: true, size: 4096 });
  assert.equal(bin.binary, true);
  assert.deepEqual(bin.lines, []);
});

test('openFilePreviewModal handles text, target line scrolling, binary files, and HTTP errors cleanly', async (t) => {
  let scrolledLine = -1;
  let onBodyReplaced: (() => void) | undefined;

  class PreviewNode {
    tagName: string;
    className = '';
    disabled = false;
    parent: PreviewNode | null = null;
    attrs = new Map<string, string>();
    children: (PreviewNode | string)[] = [];

    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
    }

    get textContent(): string {
      return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }

    set textContent(v: string) {
      for (const old of this.children) if (old instanceof PreviewNode) old.parent = null;
      this.children = v ? [v] : [];
    }

    get isConnected(): boolean {
      let cur: PreviewNode | null = this;
      while (cur) {
        if (cur === modalRoot) return true;
        cur = cur.parent;
      }
      return false;
    }

    get lastElementChild(): PreviewNode | null {
      for (let i = this.children.length - 1; i >= 0; i--) {
        if (this.children[i] instanceof PreviewNode) return this.children[i] as PreviewNode;
      }
      return null;
    }

    get classList() {
      const list = () => this.className.split(/\s+/).filter(Boolean);
      return {
        add: (...names: string[]) => {
          const s = new Set(list());
          for (const n of names) if (n) s.add(n);
          this.className = [...s].join(' ');
        },
        remove: (...names: string[]) => {
          const drop = new Set(names);
          this.className = list()
            .filter((x) => !drop.has(x))
            .join(' ');
        },
        contains: (name: string) => list().includes(name),
      };
    }

    setAttribute(k: string, v: string) {
      if (k === 'class') this.className = v;
      this.attrs.set(k, v);
    }

    getAttribute(k: string) {
      return this.attrs.get(k) ?? null;
    }

    addEventListener() {}

    append(...items: (PreviewNode | string)[]) {
      for (const item of items) {
        if (item instanceof PreviewNode && item.tagName === '#FRAGMENT') {
          this.append(...item.children);
        } else {
          if (item instanceof PreviewNode) item.parent = this;
          this.children.push(item);
        }
      }
    }

    replaceChildren(...items: (PreviewNode | string)[]) {
      for (const old of this.children) if (old instanceof PreviewNode) old.parent = null;
      this.children = [];
      this.append(...items);
      if (this.classList.contains('wt-file-modal-body')) onBodyReplaced?.();
    }

    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }

    scrollIntoView() {
      scrolledLine = Number(this.attrs.get('data-line') ?? -1);
    }

    querySelector(sel: string): PreviewNode | null {
      if (sel === ':scope > header') {
        return (this.children.find((c) => c instanceof PreviewNode && c.tagName === 'HEADER') as PreviewNode | undefined) ?? null;
      }
      const cls = sel.startsWith('.') ? sel.slice(1) : '';
      for (const c of this.children) {
        if (c instanceof PreviewNode) {
          if (cls && c.classList.contains(cls)) return c;
          const nested = c.querySelector(sel);
          if (nested) return nested;
        }
      }
      return null;
    }
  }

  const modalRoot = new PreviewNode('div');
  const prevNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevElem = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const prevFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

  Object.defineProperty(globalThis, 'Node', { configurable: true, value: PreviewNode });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: PreviewNode });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new PreviewNode(tag),
      createDocumentFragment: () => new PreviewNode('#fragment'),
      getElementById: (id: string) => (id === 'modal-root' ? modalRoot : null),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {} },
  });

  t.after(() => {
    if (prevNode) Object.defineProperty(globalThis, 'Node', prevNode);
    else Reflect.deleteProperty(globalThis, 'Node');
    if (prevElem) Object.defineProperty(globalThis, 'HTMLElement', prevElem);
    else Reflect.deleteProperty(globalThis, 'HTMLElement');
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
    if (prevFetch) Object.defineProperty(globalThis, 'fetch', prevFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  });

  const waitForBody = () =>
    new Promise<void>((resolve) => {
      onBodyReplaced = () => {
        onBodyReplaced = undefined;
        queueMicrotask(resolve);
      };
    });

  // 1. Text file with target range + truncation
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify({ path: 'src/x.ts', content: 'const a = 1;\nconst b = 2;\nconst c = 3;\n', truncated: true, size: 1200 }), { status: 200 }),
  });
  const p1 = waitForBody();
  const m1 = openFilePreviewModal({ floor: 'main', workerId: 'w1', workerName: 'Nibble', path: 'src/x.ts', line: 2, endLine: 3 });
  await p1;
  assert.equal(scrolledLine, 2);
  assert.ok(modalRoot.querySelector('.wt-file-banner'));
  m1.close();

  // 2. Binary file; a picture shows as itself instead, read as bytes
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify({ path: 'app.wasm', binary: true, size: 512 }), { status: 200 }),
  });
  const p2 = waitForBody();
  const m2 = openFilePreviewModal({ floor: 'main', workerId: 'w1', path: 'app.wasm' });
  await p2;
  assert.match(modalRoot.textContent, /Binary file/);
  m2.close();
  const picture = openFilePreviewModal({ floor: 'main', workerId: 'w1', path: 'logo.png' });
  assert.match(modalRoot.querySelector('.wt-file-image')?.getAttribute('src') ?? '', /path=logo\.png&raw=image/);
  picture.close();

  // 3. HTTP error
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify({ error: 'File not found' }), { status: 404 }),
  });
  const p3 = waitForBody();
  const m3 = openFilePreviewModal({ floor: 'main', workerId: 'w1', path: 'missing.ts' });
  await p3;
  assert.match(modalRoot.textContent, /File not found/);
  m3.close();

  // 4. Terminal source routes through /api/term/file with original requestPath
  let requestedUrl = '';
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ path: '/abs/src/x.ts', content: 'line 1\nline 2\n', size: 14 }), { status: 200 });
    },
  });
  const p4 = waitForBody();
  const m4 = openFilePreviewModal({ floor: 'main', workerId: 'w1', source: 'terminal', path: '/abs/src/x.ts', requestPath: './src/x.ts:2', line: 2 });
  await p4;
  assert.match(requestedUrl, /^\/api\/term\/file\?/);
  assert.equal(new URL(requestedUrl, 'http://127.0.0.1').searchParams.get('path'), './src/x.ts:2');
  assert.equal(scrolledLine, 2);
  m4.close();
});

const status = browserStatus();
const skipChromium = status.installed ? false : `Chromium is not installed in ${status.path}`;

test('email fences render as plain code blocks without form inputs and keyless Markdown is not quotable', { skip: skipChromium }, async (t: TestContext) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const bundle = buildSync({
    stdin: {
      contents: `export { threadMarkdown } from './src/client/ui/thread-markdown.ts';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      sourcefile: 'streamed-email-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'EmailTest',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  const result = await page.evaluate(() => {
    const render = (window as any).EmailTest.threadMarkdown;
    const fence = '```email\nTo: test@example.com\nSubject: Proof\n\nHello.\n```';
    const closed = render(fence, { streaming: false, key: 'reply' }) as HTMLElement;
    return {
      codeLang: closed.querySelector('.wt-md-code-lang')?.textContent,
      forms: closed.querySelectorAll('input, textarea, .wt-md-email').length,
      keyed: closed.getAttribute('data-response-message-id'),
      keyless: render('Not a reply').hasAttribute('data-response-message-id'),
    };
  });
  assert.equal(result.codeLang, 'email');
  assert.equal(result.forms, 0);
  assert.equal(result.keyed, 'reply');
  assert.equal(result.keyless, false);
});

test('cancelling a reveal into reduced motion clears animation styles', { skip: skipChromium }, async (t: TestContext) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const bundle = buildSync({
    stdin: {
      contents: `export { revealContent } from './src/client/ui/thread-tool-row.ts';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      sourcefile: 'reveal-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'RevealTest',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="content">Content</div>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate(() => (window as any).RevealTest.revealContent(document.getElementById('content'), true));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(() => {
    const el = document.getElementById('content')!;
    (window as any).RevealTest.revealContent(el, true);
    return { overflow: el.style.overflow, hidden: el.hidden, revealing: el.classList.contains('is-revealing') };
  });
  assert.deepEqual(result, { overflow: '', hidden: false, revealing: false });
});

test('an exploration call awaiting permission displays its pending state', { skip: skipChromium }, async (t: TestContext) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const bundle = buildSync({
    stdin: {
      contents: `export { renderThreadActivity } from './src/client/ui/thread-tool-activity.ts'; export { presentThread } from './src/shared/thread-presentation.ts';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      sourcefile: 'exploration-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'ExploreTest',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  const result = await page.evaluate(() => {
    const api = (window as any).ExploreTest;
    const entry = { id: 'read-1', seq: 1, role: 'assistant', kind: 'tool', name: 'Read', input: JSON.stringify({ file_path: '/repo/a.ts' }) };
    const row = api.presentThread([entry], true).find((r: any) => r.kind === 'activity');
    const node = document.createElement('article');
    document.getElementById('root')!.append(node);
    api.renderThreadActivity(node, row, new Map([[entry.id, entry]]), false, {
      owner: { id: 'worker' },
      userToggles: new Map(),
      thought: () => document.createElement('div'),
      live: () => ({ phase: 'waiting_permission' }),
    });
    return { state: node.querySelector('[data-testid="explore-row"]')?.className, label: node.querySelector('.wt-tr-state')?.textContent };
  });
  assert.match(result.state ?? '', /is-pending/);
  assert.equal(result.label, 'Pending review');
});

test('real Chromium DOM renders rich Thread Markdown, MathML, Mermaid LRU & Zoom, email cards, path links, and File Preview modal', { skip: skipChromium }, async (t: TestContext) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const entrySource = `
    export { threadMarkdown, threadUserMarkdown } from './src/client/ui/thread-markdown.ts';
    export { renderThreadMermaid, renderMermaidSvg } from './src/client/ui/diagram.ts';
    export { openFilePreviewModal } from './src/client/ui/file-preview.ts';
    export { closeTopModal, modalOpen } from './src/client/ui/dom.ts';
  `;

  const bundle = buildSync({
    stdin: {
      contents: entrySource,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      sourcefile: 'rich-md-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'RichMD',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;

  await page.setContent('<!doctype html><div id="root"></div><div id="modal-root"></div><div id="toasts" data-single></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });

  const result = await page.evaluate(async () => {
    const w = window as any;
    const openedRefs: any[] = [];
    const mdSource = [
      'Price is $100, formula is $x^2 + y^2 = z^2$, and block math:',
      '',
      '$$\\frac{a_1 + b_1}{2}$$',
      '',
      'Inspect `src/client/ui/dom.ts:12-14` and `package.json`; prose ref src/server/server.ts:88 stays plain (not https://factory.ai/guild).',
      '',
      '<script>window.__xss = true;</script><button style="color:red">Injected</button>',
      '',
      '```email',
      'To: nik@factory.ai',
      'Subject: Ship It',
      '',
      'Ready for review.',
      '```',
      '',
      '<json-render>{"root":"m","elements":{"m":{"type":"Metric","props":{"label":"Tests","value":"100%","trend":"up"},"children":[]}}}</json-render>',
    ].join('\n');

    const el = w.RichMD.threadMarkdown(mdSource, {
      onOpenPath: (ref: any) => openedRefs.push(ref),
    }) as HTMLElement;
    document.getElementById('root')!.append(el);

    const fileButtons = [...el.querySelectorAll<HTMLButtonElement>('.wt-file-link')];
    for (const btn of fileButtons) btn.click();

    // User markdown check
    const userEl = w.RichMD.threadUserMarkdown('Hello **team**\n<script>window.__xss2=1</script>\n```ts\nconst n = 1;\n```') as HTMLElement;
    document.getElementById('root')!.append(userEl);

    const waitUntil = (check: () => boolean) =>
      check()
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              obs.disconnect();
              reject(new Error('Timed out waiting for rich Markdown rendering'));
            }, 10_000);
            const obs = new MutationObserver(() => {
              if (check()) {
                clearTimeout(timer);
                obs.disconnect();
                resolve();
              }
            });
            obs.observe(document.body, { childList: true, subtree: true, attributes: true });
          });

    // Mermaid valid + cached re-render + invalid fallback check
    const validMermaid = 'flowchart LR\n  A[Parse] --> B[Render]';
    const card1 = w.RichMD.renderThreadMermaid(validMermaid) as HTMLElement;
    document.getElementById('root')!.append(card1);
    await waitUntil(() => Boolean(card1.querySelector('.wt-mermaid-stage svg')));

    // Second render must hit synchronous LRU cache immediately.
    const card2 = w.RichMD.renderThreadMermaid(validMermaid) as HTMLElement;
    const cachedImmediateSvg = Boolean(card2.querySelector('.wt-mermaid-stage svg'));

    // The corner menu and clicking the picture open Factory's actions and pan/zoom viewer.
    card1.querySelector<HTMLButtonElement>('.wt-mermaid-more')!.click();
    const actionsOpen = !card1.querySelector<HTMLElement>('.wt-mermaid-menu')!.hidden;
    card1.querySelector<HTMLButtonElement>('.wt-mermaid-more')!.click();
    card1.querySelector<HTMLElement>('.wt-mermaid-stage')!.click();
    const zoomModalOpen = Boolean(document.querySelector('.wt-diagram-lightbox svg'));
    w.RichMD.closeTopModal();

    // Invalid Mermaid falls back to an ordinary code block without broken SVG.
    const brokenSource = 'flowchart LR\n  A -->';
    const brokenCard = w.RichMD.renderThreadMermaid(brokenSource) as HTMLElement;
    document.getElementById('root')!.append(brokenCard);
    const brokenRejected = await w.RichMD.renderMermaidSvg(brokenSource).then(
      () => false,
      () => true,
    );
    await waitUntil(() => Boolean(brokenCard.querySelector('.wt-md-code')));
    const brokenStaysSource = brokenCard.querySelector('.wt-md-code-lang')?.textContent === 'mermaid' && !brokenCard.querySelector('.wt-mermaid-stage svg');

    // File Preview modal fetch, target line highlight & scrollIntoView
    let scrolledLine = -1;
    let resolveScrolled: (() => void) | undefined;
    const scrolledPromise = new Promise<void>((r) => (resolveScrolled = r));
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      scrolledLine = Number((this as HTMLElement).getAttribute('data-line') ?? -1);
      resolveScrolled?.();
    };
    window.fetch = async () =>
      new Response(
        JSON.stringify({
          path: 'src/client/ui/dom.ts',
          content: Array.from({ length: 30 }, (_, idx) => `export const line${idx + 1} = ${idx + 1};`).join('\n'),
          truncated: true,
          size: 8192,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    w.RichMD.openFilePreviewModal({
      floor: 'main',
      workerId: 'nibble',
      workerName: 'Nibble',
      path: 'src/client/ui/dom.ts',
      line: 12,
      endLine: 14,
    });
    await scrolledPromise;
    Element.prototype.scrollIntoView = origScroll;

    const targetRows = [...document.querySelectorAll('.wt-file-line.is-target')].map((r) => Number(r.getAttribute('data-line')));
    const hasTruncatedBanner = Boolean(document.querySelector('.wt-file-banner'));
    w.RichMD.closeTopModal();

    return {
      xss: Boolean(w.__xss || w.__xss2),
      injectedButtons: [...el.querySelectorAll('button')].some((b) => b.textContent === 'Injected'),
      anyStyleAttrInMath: [...el.querySelectorAll('.wt-math, .wt-math *')].some((n) => n.hasAttribute('style')),
      inlineMathCount: el.querySelectorAll('.wt-math-inline math').length,
      blockMathCount: el.querySelectorAll('.wt-math-block math').length,
      currencyPreserved: (el.textContent ?? '').includes('Price is $100'),
      emailCodeLang: el.querySelector('.wt-md-code-lang')?.textContent ?? '',
      emailFormCount: el.querySelectorAll('.wt-md-email').length,
      metricValue: el.querySelector('.jr-metric-value')?.textContent ?? '',
      openedRefs,
      userHasCodeCopy: Boolean(userEl.querySelector('.wt-md-code-copy')),
      cachedImmediateSvg,
      brokenRejected,
      actionsOpen,
      zoomModalOpen,
      brokenStaysSource,
      targetRows,
      scrolledLine,
      hasTruncatedBanner,
      modalClosedCleanly: !w.RichMD.modalOpen(),
    };
  });

  assert.deepEqual(pageErrors, []);
  assert.equal(result.xss, false);
  assert.equal(result.injectedButtons, false);
  assert.equal(result.anyStyleAttrInMath, false);
  assert.equal(result.inlineMathCount, 1);
  assert.equal(result.blockMathCount, 1);
  assert.equal(result.currencyPreserved, true);
  assert.equal(result.emailCodeLang, 'email');
  assert.equal(result.emailFormCount, 0);
  assert.equal(result.metricValue, '100%');
  assert.deepEqual(result.openedRefs, [{ path: 'src/client/ui/dom.ts', line: 12, endLine: 14 }, { path: 'package.json' }]);
  assert.equal(result.userHasCodeCopy, true);
  assert.equal(result.cachedImmediateSvg, true);
  assert.equal(result.brokenRejected, true);
  assert.equal(result.actionsOpen, true);
  assert.equal(result.zoomModalOpen, true);
  assert.equal(result.brokenStaysSource, true);
  assert.deepEqual(result.targetRows, [12, 13, 14]);
  assert.equal(result.scrolledLine, 12);
  assert.equal(result.hasTruncatedBanner, true);
  assert.equal(result.modalClosedCleanly, true);
});

test('real Chromium points Thread Markdown images of files on the office machine at the workspace picture route', { skip: skipChromium }, async (t: TestContext) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const bundle = buildSync({
    stdin: { contents: `export { threadMarkdown } from './src/client/ui/thread-markdown.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'md-images-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'iife',
    globalName: 'RichMD',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });

  const { pointed, plain } = await page.evaluate(() => {
    const w = window as any;
    const src = [
      '### 2. Cozy Cinema & Media Den',
      '',
      '![Cozy Cinema and Media Den](/Users/nik/Pictures/chaise-room-designs/02-cozy-media-den.png)',
      '',
      '![chart](docs/chart.png) ![tmp](file:///tmp/a%20b.png) ![web](https://example.com/a.png)',
    ].join('\n');
    const url = (path: string) => `/api/thread/file?${new URLSearchParams({ floor: 'home', worker: 'byte', path, raw: 'image' })}`;
    const srcs = (el: HTMLElement) => [...el.querySelectorAll('img')].map((img) => [img.getAttribute('alt'), img.getAttribute('src')]);
    return { pointed: srcs(w.RichMD.threadMarkdown(src, { imageUrl: url })), plain: srcs(w.RichMD.threadMarkdown(src)) };
  });

  assert.deepEqual(pointed, [
    ['Cozy Cinema and Media Den', '/api/thread/file?floor=home&worker=byte&path=%2FUsers%2Fnik%2FPictures%2Fchaise-room-designs%2F02-cozy-media-den.png&raw=image'],
    ['chart', '/api/thread/file?floor=home&worker=byte&path=docs%2Fchart.png&raw=image'],
    ['tmp', '/api/thread/file?floor=home&worker=byte&path=%2Ftmp%2Fa+b.png&raw=image'],
    ['web', 'https://example.com/a.png'],
  ]);
  assert.deepEqual(
    plain.map(([alt, src]) => [alt, src]),
    [
      ['Cozy Cinema and Media Den', '/Users/nik/Pictures/chaise-room-designs/02-cozy-media-den.png'],
      ['chart', 'docs/chart.png'],
      ['tmp', null],
      ['web', 'https://example.com/a.png'],
    ],
    'without imageUrl, images keep their own src (and the sanitizer drops file: URLs)',
  );
  assert.deepEqual(pageErrors, []);
});
