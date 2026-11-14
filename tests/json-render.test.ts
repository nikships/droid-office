import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { extractJsonRenderBlocks, MAX_JSON_RENDER_DEPTH, parseJsonRenderSpec, renderJsonWidget } from '../src/client/ui/json-render.js';

// Minimal DOM shim for fast in-process Node execution and full V8 test coverage of json-render.ts.
class FakeElement {
  tagName: string;
  namespaceURI: string;
  className = '';
  attrs = new Map<string, string>();
  props = new Map<string, string>();
  children: (FakeElement | string)[] = [];
  parent: FakeElement | null = null;

  style = {
    setProperty: (k: string, v: string) => {
      this.props.set(k, v);
    },
    getPropertyValue: (k: string) => this.props.get(k) ?? '',
  };

  constructor(tag: string, ns = 'http://www.w3.org/1999/xhtml') {
    this.tagName = ns.includes('svg') ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
  }

  get classList() {
    const read = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...tokens: string[]) => {
        const set = new Set(read());
        for (const tok of tokens) if (tok) set.add(tok);
        this.className = [...set].join(' ');
      },
      contains: (tok: string) => read().includes(tok),
    };
  }

  setAttribute(k: string, v: string) {
    if (k === 'class') this.className = v;
    this.attrs.set(k, v);
  }

  getAttribute(k: string): string | null {
    if (k === 'class') return this.className || null;
    return this.attrs.get(k) ?? null;
  }

  addEventListener() {}

  append(...nodes: (FakeElement | string)[]) {
    for (const n of nodes) {
      if (n instanceof FakeElement) n.parent = this;
      this.children.push(n);
    }
  }

  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) {
      if (c instanceof FakeElement) out.push(...c.findAll(pred));
    }
    return out;
  }

  byClass(cls: string): FakeElement[] {
    return this.findAll((el) => el.classList.contains(cls));
  }
}

function installFakeDom(t: TestContext): void {
  const prevNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
    },
  });
  t.after(() => {
    if (prevNode) Object.defineProperty(globalThis, 'Node', prevNode);
    else Reflect.deleteProperty(globalThis, 'Node');
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
  });
}

test('json-render module loads cleanly in Node with no window or document globals', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof extractJsonRenderBlocks, 'function');
  assert.equal(typeof renderJsonWidget, 'function');
});

test('json-render source never passes style attributes to h() and only sets dynamic CSS custom properties', () => {
  const src = readFileSync(new URL('../src/client/ui/json-render.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bh\([^)]*\bstyle\s*:/);
});

test('extractJsonRenderBlocks extracts live blocks while ignoring fenced code and inline backticks', () => {
  const md = [
    'Intro paragraph with `<json-render>{"root":"inline","elements":{}}</json-render>` and ``<json-render>{"root":"double"}</json-render>``.',
    '',
    '```json',
    '<json-render>{"root":"fenced","elements":{}}</json-render>',
    '```',
    '',
    '> ~~~ts',
    '> const s = `<json-render>{"root":"quoted-fence"}</json-render>`;',
    '> ~~~',
    '',
    '<json-render>{"root":"card","elements":{"card":{"type":"Badge","props":{"label":"OK"},"children":[]}}}</json-render>',
    '',
    'Trailing streaming widget:',
    '<json-render>{"root":"partial","elements":{"partial":{"type":"Text"',
  ].join('\n');

  const res = extractJsonRenderBlocks(md);
  assert.equal(res.blocks.length, 2);
  assert.equal(res.blocks[0].complete, true);
  assert.match(res.blocks[0].rawJson, /"Badge"/);
  assert.equal(res.blocks[1].complete, false);
  assert.match(res.blocks[1].rawJson, /"partial"/);
  // Fenced and inline-code examples stay untouched in textWithPlaceholders.
  assert.match(res.textWithPlaceholders, /`<json-render>\{"root":"inline","elements":\{\}\}<\/json-render>`/);
  assert.match(res.textWithPlaceholders, /"fenced"/);
  assert.match(res.textWithPlaceholders, /"quoted-fence"/);
});

test('extractJsonRenderBlocks avoids placeholder collisions when marker text appears in source', () => {
  const md = 'Literal WTJSONRENDERBLOCK text before <json-render>{"root":"a","elements":{"a":{"type":"Spacer","props":{},"children":[]}}}</json-render>';
  const res = extractJsonRenderBlocks(md);
  assert.equal(res.blocks.length, 1);
  assert.notEqual(res.blocks[0].placeholder, 'WTJSONRENDERBLOCK0END');
  assert.ok(res.textWithPlaceholders.includes('Literal WTJSONRENDERBLOCK text'));
  assert.ok(res.textWithPlaceholders.includes(res.blocks[0].placeholder));
});

test('renderJsonWidget renders all 18 layout, data, and display components cleanly without inline style attributes', (t) => {
  installFakeDom(t);

  const payload = JSON.stringify({
    root: 'root',
    elements: {
      root: {
        type: 'Card',
        props: { title: 'Build Summary', padding: 'md' },
        children: ['layoutBox', 'divTitle', 'divPlain', 'nl', 'sp', 'bars', 'spark', 'sparkSingle', 'tbl', 'ulList', 'olList', 'statusOk', 'kv', 'badge', 'prog', 'metricUp', 'metricDown', 'callout', 'timeline'],
      },
      layoutBox: {
        type: 'Box',
        props: { flexDirection: 'row', padding: 2, gap: 'sm', borderStyle: 'dashed' },
        children: ['head1', 'txtBold'],
      },
      head1: {
        type: 'Heading',
        props: { text: 'Phase A', level: 2 },
        children: [],
      },
      txtBold: {
        type: 'Text',
        props: { text: 'All checks green', color: 'success', bold: true },
        children: [],
      },
      divTitle: {
        type: 'Divider',
        props: { title: 'Metrics' },
        children: [],
      },
      divPlain: {
        type: 'Divider',
        props: {},
        children: [],
      },
      nl: {
        type: 'Newline',
        props: {},
        children: [],
      },
      sp: {
        type: 'Spacer',
        props: {},
        children: [],
      },
      bars: {
        type: 'BarChart',
        props: {
          showPercentage: true,
          data: [
            { label: 'Client', value: 60, color: '#ee6018' },
            { label: 'Server', value: 40, color: 'info' },
          ],
        },
        children: [],
      },
      spark: {
        type: 'Sparkline',
        props: { data: [12, 18, 15, 29, 24], color: 'accent' },
        children: [],
      },
      sparkSingle: {
        type: 'Sparkline',
        props: { data: [42], color: 'rgb(60, 207, 145)' },
        children: [],
      },
      tbl: {
        type: 'Table',
        props: {
          headerColor: 'muted',
          columns: [
            { header: 'Suite', key: 'suite', width: 160 },
            { header: 'Pass', key: 'pass', width: '25%' },
          ],
          rows: [
            { suite: 'json-render', pass: 18 },
            { suite: 'rich-markdown', pass: 24 },
          ],
        },
        children: [],
      },
      ulList: {
        type: 'List',
        props: { items: ['KaTeX MathML', 'Mermaid LRU'], ordered: false },
        children: [],
      },
      olList: {
        type: 'List',
        props: { items: ['Lint', 'Typecheck', 'Test'], ordered: true },
        children: [],
      },
      statusOk: {
        type: 'StatusLine',
        props: { text: 'CI pipeline passed', status: 'success' },
        children: [],
      },
      kv: {
        type: 'KeyValue',
        props: { label: 'Branch', value: 'thread-v3-web-rich-md' },
        children: [],
      },
      badge: {
        type: 'Badge',
        props: { label: 'READY', variant: 'success' },
        children: [],
      },
      prog: {
        type: 'ProgressBar',
        props: { progress: 0.75, width: 240, label: 'Rollout' },
        children: [],
      },
      metricUp: {
        type: 'Metric',
        props: { label: 'FPS', value: '120', trend: 'up' },
        children: [],
      },
      metricDown: {
        type: 'Metric',
        props: { label: 'Frame time', value: '4.2ms', trend: 'down' },
        children: [],
      },
      callout: {
        type: 'Callout',
        props: { type: 'warning', title: 'Heads up', content: 'Zero inline style attributes allowed.' },
        children: [],
      },
      timeline: {
        type: 'Timeline',
        props: {
          items: [
            { title: 'Foundation', description: 'Protocol & diffs', status: 'completed' },
            { title: 'Rich Markdown', description: 'Widgets, math, Mermaid', status: 'in_progress' },
            { title: 'Integration', status: 'pending' },
          ],
        },
        children: [],
      },
    },
  });

  const root = renderJsonWidget(payload) as unknown as FakeElement;
  assert.ok(root);
  assert.ok(root.classList.contains('jr-root'));

  // Every rendered element must have zero HTML `style` attributes.
  for (const el of root.findAll(() => true)) {
    assert.equal(el.getAttribute('style'), null, `unexpected style attribute on ${el.tagName}.${el.className}`);
  }

  // Verify all 18 component families produced their semantic structures.
  assert.equal(root.byClass('jr-card').length, 1);
  assert.equal(root.byClass('jr-box').length, 1);
  assert.ok(root.byClass('jr-box')[0].classList.contains('jr-row'));
  assert.ok(root.byClass('jr-box')[0].classList.contains('jr-border-dashed'));
  assert.equal(root.byClass('jr-box')[0].style.getPropertyValue('--jr-pad'), '8px');

  const heading = root.byClass('jr-heading')[0];
  assert.equal(heading.tagName, 'H2');
  assert.equal(heading.textContent, 'Phase A');

  const boldText = root.byClass('jr-text')[0];
  assert.ok(boldText.classList.contains('jr-bold'));
  assert.ok(boldText.classList.contains('jr-tone-success'));

  assert.equal(root.byClass('jr-divider').length, 2);
  assert.equal(root.byClass('jr-newline').length, 1);
  assert.equal(root.byClass('jr-spacer').length, 1);

  const barFills = root.byClass('jr-bar-fill');
  assert.equal(barFills.length, 2);
  assert.equal(barFills[0].style.getPropertyValue('--pct'), '100.00%');
  assert.equal(barFills[1].style.getPropertyValue('--pct'), '66.67%');
  assert.equal(barFills[0].style.getPropertyValue('--jr-color'), '#ee6018');

  const sparks = root.byClass('jr-sparkline-svg');
  assert.equal(sparks.length, 2);
  assert.equal(sparks[0].findAll((el) => el.tagName === 'polyline').length, 1);
  assert.equal(sparks[1].findAll((el) => el.tagName === 'line').length, 1);

  assert.equal(root.byClass('jr-table').length, 1);
  assert.equal(root.byClass('jr-th')[0].style.getPropertyValue('--col-w'), '160px');
  assert.equal(root.byClass('jr-th')[1].style.getPropertyValue('--col-w'), '25%');

  assert.equal(root.byClass('jr-list').length, 2);
  assert.equal(root.byClass('jr-list-ordered')[0].tagName, 'OL');

  assert.ok(root.byClass('jr-status-line')[0].classList.contains('is-success'));
  assert.equal(root.byClass('jr-kv-value')[0].textContent, 'thread-v3-web-rich-md');
  assert.ok(root.byClass('jr-badge')[0].classList.contains('jr-badge-success'));

  const progTrack = root.byClass('jr-progress-track')[0];
  assert.equal(progTrack.getAttribute('aria-valuenow'), '75');
  assert.equal(root.byClass('jr-progress-fill')[0].style.getPropertyValue('--pct'), '75.00%');
  assert.equal(root.byClass('jr-progress')[0].style.getPropertyValue('--jr-width'), '240px');

  assert.equal(root.byClass('jr-metric').length, 2);
  assert.equal(root.byClass('jr-metric-trend')[0].textContent, '↑');
  assert.equal(root.byClass('jr-metric-trend')[1].textContent, '↓');

  assert.ok(root.byClass('jr-callout')[0].classList.contains('warn'));
  assert.equal(root.byClass('jr-timeline-item').length, 3);
});

test('renderJsonWidget shows a quiet loading card for incomplete streaming JSON and null when closed JSON is invalid', (t) => {
  installFakeDom(t);

  const unclosedTag = renderJsonWidget('<json-render>{"root":"a","elements":{"a":{"type":"Text"') as unknown as FakeElement;
  assert.ok(unclosedTag);
  assert.ok(unclosedTag.classList.contains('wt-json-loading'));
  assert.equal(unclosedTag.byClass('spinner').length, 1);
  assert.match(unclosedTag.textContent, /Rendering widget…/);

  const streamingPartial = renderJsonWidget('{"root":"a","elements":{"a":', true) as unknown as FakeElement;
  assert.ok(streamingPartial);
  assert.ok(streamingPartial.classList.contains('wt-json-loading'));

  assert.equal(renderJsonWidget('{"root":"a","elements":{"a":', false), null);
  assert.equal(renderJsonWidget('not json at all', false), null);
  assert.equal(parseJsonRenderSpec('[]'), null);
  assert.equal(parseJsonRenderSpec('{"root":"","elements":{}}'), null);
  assert.equal(parseJsonRenderSpec('{"root":"missing","elements":{}}'), null);
});

test('renderJsonWidget guards against cyclic element IDs, excessive depth, unsafe CSS values, and malformed props', (t) => {
  installFakeDom(t);

  // Mutual cycle: a -> b -> a
  const cyclic = JSON.stringify({
    root: 'a',
    elements: {
      a: { type: 'Box', props: {}, children: ['b'] },
      b: { type: 'Card', props: { title: 'Loop' }, children: ['a'] },
    },
  });
  const cyclicEl = renderJsonWidget(cyclic) as unknown as FakeElement;
  assert.ok(cyclicEl);
  assert.equal(cyclicEl.byClass('jr-card').length, 1);

  // Chain deeper than MAX_JSON_RENDER_DEPTH (45 levels > 32)
  const deepElements: Record<string, unknown> = {};
  for (let i = 0; i < MAX_JSON_RENDER_DEPTH + 12; i++) {
    deepElements[`n${i}`] = {
      type: 'Box',
      props: {},
      children: i < MAX_JSON_RENDER_DEPTH + 11 ? [`n${i + 1}`] : ['leaf'],
    };
  }
  deepElements.leaf = { type: 'Text', props: { text: 'Too deep' }, children: [] };
  const deepEl = renderJsonWidget(JSON.stringify({ root: 'n0', elements: deepElements })) as unknown as FakeElement;
  assert.ok(deepEl);
  // Leaf beyond depth 32 must be pruned rather than overflowing stack.
  assert.equal(deepEl.byClass('jr-text').length, 0);
  assert.ok(deepEl.byClass('jr-box').length <= MAX_JSON_RENDER_DEPTH + 1);

  // Malformed component props and unknown component fallback never throw.
  const messy = JSON.stringify({
    root: 'wrap',
    elements: {
      wrap: {
        type: 'UnknownContainer',
        props: 'not-an-object',
        children: ['badBar', 'badSpark', 'badTable', 'badList', 'badProgress', 'unsafeColor', 'clampHeading'],
      },
      badBar: { type: 'BarChart', props: { data: 'nope' }, children: [] },
      badSpark: { type: 'Sparkline', props: { data: ['nan', null] }, children: [] },
      badTable: { type: 'Table', props: { columns: [{}], rows: 'bad' }, children: [] },
      badList: { type: 'List', props: { items: [] }, children: [] },
      badProgress: { type: 'ProgressBar', props: { progress: 'fifty' }, children: [] },
      unsafeColor: { type: 'Text', props: { text: 'Safe', color: 'url(https://evil.example/x);color:red' }, children: [] },
      clampHeading: { type: 'Heading', props: { text: 'Clamped', level: 99 }, children: [] },
    },
  });
  const messyEl = renderJsonWidget(messy) as unknown as FakeElement;
  assert.ok(messyEl);
  const safeText = messyEl.byClass('jr-text')[0];
  assert.equal(safeText.style.getPropertyValue('--jr-color'), '');
  assert.equal(messyEl.byClass('jr-heading')[0].tagName, 'H6');
});
