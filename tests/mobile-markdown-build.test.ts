import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { transformSync } from '@babel/core';
import { isExternalUrl } from '../src/shared/companion-tools.js';
import { type MdBlock, parseMarkdown } from '../src/mobile/markdown.js';

const require = createRequire(import.meta.url);
const configFile = fileURLToPath(new URL('../babel.config.cjs', import.meta.url));

/** Run the same transforms as Metro, not only the untransformed parser that Node sees. */
function nativeModule(path: string, resolve: (id: string) => unknown = require): Record<string, unknown> {
  const file = new URL(path, import.meta.url);
  const transformed = transformSync(readFileSync(file, 'utf8'), { filename: fileURLToPath(file), configFile });
  assert.ok(transformed?.code);
  const module = { exports: {} };
  new Function('module', 'exports', 'require', transformed.code)(module, module.exports, resolve);
  return module.exports;
}

const marked = nativeModule('../node_modules/marked/lib/marked.esm.js');
const native = nativeModule('../src/mobile/markdown.ts', (id: string) => {
  if (id === 'marked') return marked;
  if (id === '../shared/companion-tools') return { isExternalUrl };
  return require(id);
});
const parseNative = native.parseMarkdown as typeof parseMarkdown;

// Trimmed from the actual verification worker's reply that exposed the Android rendering bug.
const checklist = '- [ ] **Keyboard Shortcut Hints (`div.dash-keys`)**: Footer displaying `↑↓`, `Esc`, `N`, `P`, `B` keys.\n- [x] **Multi-Pane Container & Sizing (`.cw-panes`, `.cw-pane`)**:\n  - Side-by-side flex layout.';

test('the Android build preserves bold labels containing inline code in real task-list replies', () => {
  const actual = parseNative(checklist);
  assert.deepEqual(actual, parseMarkdown(checklist));
  const list = actual[0] as Extract<MdBlock, { kind: 'list' }>;
  assert.equal(list.items[0].checked, false);
  assert.equal(list.items[1].checked, true);
  const label = list.items[0].blocks[0] as Extract<MdBlock, { kind: 'paragraph' }>;
  assert.ok(label.spans.some((span) => span.text === 'Keyboard Shortcut Hints (' && span.bold));
  assert.ok(label.spans.some((span) => span.text === 'div.dash-keys' && span.bold && span.code));
  assert.ok(!JSON.stringify(actual).includes('**'));
  assert.equal(list.items[1].blocks[1].kind, 'list');
});

test('Metro-transformed Markdown retains emphasis, escaped literals and safe-link behavior', () => {
  for (const text of [
    'A **bold `code` label**, *italic `code` label* and ~~old `code` label~~.',
    '**[A `code` link](https://example.com)** and [unsafe](javascript:alert(1)).',
    'Escaped \\*\\*literal\\*\\* and `**literal code**`.',
    '> **Quoted `code`**\n\n| Label |\n| --- |\n| **Cell `code`** |',
    '<img src=x onerror=alert(1)> ![picture](https://example.com/image.png)',
  ])
    assert.deepEqual(parseNative(text), parseMarkdown(text), text);
});
