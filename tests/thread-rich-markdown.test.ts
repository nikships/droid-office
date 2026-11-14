import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { attachCopyFeedback, codeLanguageLabel, highlightCodeBlock, highlightLine, MAX_HIGHLIGHT_CHARS, preloadCodeLanguage, renderCodeFrame, resolveCodeLanguage, tokenizeCode } from '../src/client/ui/code-highlight.js';
import { drawDiagram, renderMermaidSvg, renderThreadMermaid } from '../src/client/ui/diagram.js';
import { formatFilePreviewBytes, normalizeFilePreviewResponse, openFilePreviewModal, threadFilePreviewUrl } from '../src/client/ui/file-preview.js';
import { buildMailtoHref, extractMathSegments, parseEmailDraft, parseWorkspacePathRefs, renderMathToMathMl, threadMarkdown, threadUserMarkdown } from '../src/client/ui/thread-markdown.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

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

test('parseEmailDraft and buildMailtoHref parse RFC headers and encode mailto query parameters with %20', () => {
  const raw = [
    'To: Alice Smith <alice@example.com>, bob@example.com',
    'Cc: lead@example.com',
    'Bcc: archive@example.com',
    'In-Reply-To: <msg-99@example.com>',
    'Subject: Phase A Rich Markdown Ready',
    '',
    'Hi Alice,',
    '',
    'All 18 widgets and MathML checks are green.',
  ].join('\n');

  const draft = parseEmailDraft(raw);
  assert.ok(draft);
  assert.equal(draft.to, 'Alice Smith <alice@example.com>, bob@example.com');
  assert.equal(draft.cc, 'lead@example.com');
  assert.equal(draft.bcc, 'archive@example.com');
  assert.equal(draft.inReplyTo, '<msg-99@example.com>');
  assert.equal(draft.subject, 'Phase A Rich Markdown Ready');
  assert.equal(draft.body, 'Hi Alice,\n\nAll 18 widgets and MathML checks are green.');

  const href = buildMailtoHref(draft);
  assert.ok(href.startsWith('mailto:alice@example.com,bob@example.com?'));
  assert.match(href, /subject=Phase%20A%20Rich%20Markdown%20Ready/);
  assert.match(href, /cc=lead%40example\.com/);
  assert.match(href, /bcc=archive%40example\.com/);
  assert.match(href, /in-reply-to=%3Cmsg-99%40example\.com%3E/);
  assert.match(href, /body=Hi%20Alice%2C%0A%0AAll%2018%20widgets/);
  assert.doesNotMatch(href, /\+/);

  // Non-email content returns null so it stays a normal code block.
  assert.equal(parseEmailDraft('just some arbitrary note without headers'), null);
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
});

const status = browserStatus();
const skipChromium = status.installed ? false : `Chromium is not installed in ${status.path}`;

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
      'Inspect `src/client/ui/dom.ts:12-14`, `package.json`, and prose ref src/server/server.ts:88 (not https://factory.ai/guild).',
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
        : new Promise<void>((resolve) => {
            const obs = new MutationObserver(() => {
              if (check()) {
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
    await waitUntil(() => Boolean(card1.querySelector('.wt-diagram-stage svg')));

    // Second render must hit synchronous LRU cache immediately!
    const card2 = w.RichMD.renderThreadMermaid(validMermaid) as HTMLElement;
    const cachedImmediateSvg = Boolean(card2.querySelector('.wt-diagram-stage svg'));

    // Toggle Source <-> Diagram and open Zoom modal
    const toggleBtn = card1.querySelector<HTMLButtonElement>('.wt-diagram-toggle')!;
    toggleBtn.click();
    const showingSourceAfterToggle = !card1.querySelector<HTMLElement>('.wt-diagram-source')!.hidden;
    toggleBtn.click();

    card1.querySelector<HTMLButtonElement>('.wt-diagram-zoom')!.click();
    const zoomModalOpen = Boolean(document.querySelector('.wt-diagram-modal svg'));
    w.RichMD.closeTopModal();

    // Invalid streaming Mermaid stays as highlighted source without broken SVG
    const brokenSource = 'flowchart LR\n  A -->';
    const brokenCard = w.RichMD.renderThreadMermaid(brokenSource) as HTMLElement;
    document.getElementById('root')!.append(brokenCard);
    await w.RichMD.renderMermaidSvg(brokenSource).catch(() => {});
    const brokenStaysSource = !brokenCard.querySelector<HTMLElement>('.wt-diagram-source')!.hidden && brokenCard.querySelector<HTMLElement>('.wt-diagram-stage')!.hidden;

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
      emailMailto: el.querySelector<HTMLAnchorElement>('.wt-email-open')?.getAttribute('href') ?? '',
      metricValue: el.querySelector('.jr-metric-value')?.textContent ?? '',
      openedRefs,
      userHasCodeCopy: Boolean(userEl.querySelector('.wt-code-copy')),
      cachedImmediateSvg,
      showingSourceAfterToggle,
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
  assert.equal(result.emailMailto, 'mailto:nik@factory.ai?subject=Ship%20It&body=Ready%20for%20review.');
  assert.equal(result.metricValue, '100%');
  assert.deepEqual(result.openedRefs, [{ path: 'src/client/ui/dom.ts', line: 12, endLine: 14 }, { path: 'package.json' }, { path: 'src/server/server.ts', line: 88 }]);
  assert.equal(result.userHasCodeCopy, true);
  assert.equal(result.cachedImmediateSvg, true);
  assert.equal(result.showingSourceAfterToggle, true);
  assert.equal(result.zoomModalOpen, true);
  assert.equal(result.brokenStaysSource, true);
  assert.deepEqual(result.targetRows, [12, 13, 14]);
  assert.equal(result.scrolledLine, 12);
  assert.equal(result.hasTruncatedBanner, true);
  assert.equal(result.modalClosedCleanly, true);
});
