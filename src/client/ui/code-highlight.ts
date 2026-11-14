import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight';
import { h } from './dom';

// Lightweight Lezer token highlighter and code-frame builder for Thread messages, inline diffs,
// and file previews. Language parsers load once on demand and cache in memory without spinning up
// a CodeMirror EditorView per code block.

export const MAX_HIGHLIGHT_CHARS = 40_000;
const COPY_FEEDBACK_MS = 1_500;

type CodeParser = LanguageSupport['language']['parser'];

export interface CodeToken {
  text: string;
  cls: string;
}

const tokenHighlighter = tagHighlighter([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], class: 'tok-kw' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], class: 'tok-fn' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.macroName], class: 'tok-type' },
  { tag: [tags.string, tags.special(tags.string), tags.character, tags.monospace], class: 'tok-str' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.null, tags.self], class: 'tok-num' },
  { tag: [tags.propertyName, tags.attributeName], class: 'tok-prop' },
  { tag: [tags.operator, tags.punctuation, tags.separator], class: 'tok-op' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'tok-cmt' },
  { tag: [tags.regexp, tags.escape, tags.meta, tags.annotation, tags.processingInstruction, tags.heading, tags.link, tags.url], class: 'tok-meta' },
  { tag: [tags.deleted, tags.invalid], class: 'tok-del' },
  { tag: [tags.inserted], class: 'tok-ins' },
]);

const PLAIN_NAMES = new Set(['plain', 'plaintext', 'text', 'txt', 'none', 'raw', 'output']);

const FENCE_ALIAS: Record<string, string> = {
  golang: 'go',
  shellscript: 'sh',
  console: 'sh',
  terminal: 'sh',
  zsh: 'sh',
  env: 'sh',
  dotenv: 'sh',
  gitignore: 'sh',
  dockerignore: 'sh',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  mts: 'ts',
  cts: 'ts',
  mjs: 'js',
  cjs: 'js',
  mdx: 'md',
  kts: 'kt',
  patch: 'diff',
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  objc: 'objective-c',
  'obj-c': 'objective-c',
  gql: 'graphql',
  py3: 'py',
  python3: 'python',
  csharp: 'c#',
};

const EXT_ALIAS_FILE: Record<string, string> = {
  jsonc: 'file.json',
  jsonl: 'file.json',
  mjs: 'file.js',
  cjs: 'file.js',
  mts: 'file.ts',
  cts: 'file.ts',
  mdx: 'file.md',
  kts: 'file.kt',
  patch: 'file.diff',
  env: 'file.sh',
  gitignore: 'file.sh',
  dockerignore: 'file.sh',
};

const parserCache = new Map<LanguageDescription, CodeParser>();
const loadingCache = new Map<LanguageDescription, Promise<CodeParser | null>>();

function cleanLangInput(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const first = trimmed.split(/\s+/)[0] ?? '';
  // Strip optional :line or :line-endLine suffixes on paths like src/foo/bar.ts:42-51.
  return first.replace(/:\d+(?:-\d+|:\d+)?$/, '').replace(/#L\d+(?:-L?\d+)?$/i, '');
}

/** Resolves a fence language tag (`ts`, `py`, `kt`) or workspace file path (`src/foo/bar.ts`) to a CodeMirror language description. */
export function resolveCodeLanguage(langOrPath?: string): LanguageDescription | null {
  const token = cleanLangInput(langOrPath);
  if (!token) return null;
  const lower = token.toLowerCase();
  if (PLAIN_NAMES.has(lower)) return null;

  if (token.includes('/') || token.includes('.')) {
    const base = token.slice(token.lastIndexOf('/') + 1);
    const direct = LanguageDescription.matchFilename(languages, base);
    if (direct) return direct;
    const baseLower = base.toLowerCase();
    if (baseLower.startsWith('.env')) return LanguageDescription.matchFilename(languages, 'file.sh');
    if (baseLower === 'containerfile') return LanguageDescription.matchFilename(languages, 'Dockerfile');
    const dot = baseLower.lastIndexOf('.');
    if (dot >= 0) {
      const aliasFile = EXT_ALIAS_FILE[baseLower.slice(dot + 1)];
      if (aliasFile) return LanguageDescription.matchFilename(languages, aliasFile);
    }
    return null;
  }

  const mapped = FENCE_ALIAS[lower] ?? lower;
  const byName = LanguageDescription.matchLanguageName(languages, mapped, false);
  if (byName) return byName;
  const byExt = LanguageDescription.matchFilename(languages, `file.${mapped}`);
  if (byExt) return byExt;
  return LanguageDescription.matchFilename(languages, mapped);
}

/** Short display label for a code block's header (`TypeScript`, `Python`, `Mermaid`, or `'code'`). */
export function codeLanguageLabel(langOrPath?: string): string {
  const desc = resolveCodeLanguage(langOrPath);
  if (desc) return desc.name;
  const cleaned = cleanLangInput(langOrPath);
  if (!cleaned) return 'code';
  if (cleaned.includes('/')) {
    const base = cleaned.slice(cleaned.lastIndexOf('/') + 1);
    return base || 'code';
  }
  return cleaned;
}

function loadParser(desc: LanguageDescription): Promise<CodeParser | null> {
  const cached = parserCache.get(desc);
  if (cached) return Promise.resolve(cached);
  const existing = loadingCache.get(desc);
  if (existing) return existing;
  const pending = desc
    .load()
    .then((support) => {
      const parser = support.language.parser;
      parserCache.set(desc, parser);
      loadingCache.delete(desc);
      return parser;
    })
    .catch(() => {
      loadingCache.delete(desc);
      return null;
    });
  loadingCache.set(desc, pending);
  return pending;
}

/** Preloads and caches the parser for `langOrPath`. Resolves true when a grammar is ready. */
export async function preloadCodeLanguage(langOrPath?: string): Promise<boolean> {
  const desc = resolveCodeLanguage(langOrPath);
  if (!desc) return false;
  return (await loadParser(desc)) !== null;
}

/** Pure Lezer tokenization into coalesced `{ text, cls }` runs (safe in Node without a DOM). */
export function tokenizeWithParser(parser: CodeParser, code: string): CodeToken[] {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return code ? [{ text: code, cls: '' }] : [];
  const tree = parser.parse(code);
  const tokens: CodeToken[] = [];
  const push = (text: string, cls: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.cls === cls) prev.text += text;
    else tokens.push({ text, cls });
  };
  highlightCode(
    code,
    tree,
    tokenHighlighter,
    (text, classes) => push(text, classes),
    () => push('\n', ''),
  );
  return tokens;
}

/** Loads the grammar if needed and tokenizes `code` into `{ text, cls }` runs. */
export async function tokenizeCode(code: string, langOrPath?: string): Promise<CodeToken[]> {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return code ? [{ text: code, cls: '' }] : [];
  const desc = resolveCodeLanguage(langOrPath);
  if (!desc) return [{ text: code, cls: '' }];
  const parser = await loadParser(desc);
  if (!parser) return [{ text: code, cls: '' }];
  return tokenizeWithParser(parser, code);
}

function tokensToChildren(tokens: readonly CodeToken[]): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  for (const tok of tokens) {
    if (!tok.cls) out.push(tok.text);
    else {
      const dotClasses = tok.cls.trim().replace(/\s+/g, '.');
      out.push(h(`span.${dotClasses}` as `span.${string}`, {}, tok.text));
    }
  }
  return out;
}

function tokensToFragment(tokens: readonly CodeToken[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(...tokensToChildren(tokens));
  return frag;
}

/** Highlights a multi-line code block into `<code class="wt-hl">...</code>`, upgrading in place if the language loads asynchronously. */
export function highlightCodeBlock(code: string, langOrPath?: string): HTMLElement {
  const el = h('code.wt-hl');
  if (!code) return el;
  const desc = code.length <= MAX_HIGHLIGHT_CHARS ? resolveCodeLanguage(langOrPath) : null;
  if (!desc) {
    el.textContent = code;
    return el;
  }
  const cached = parserCache.get(desc);
  if (cached) {
    el.append(...tokensToChildren(tokenizeWithParser(cached, code)));
    return el;
  }
  el.textContent = code;
  void loadParser(desc).then((parser) => {
    if (!parser || !el.isConnected) return;
    el.replaceChildren(...tokensToChildren(tokenizeWithParser(parser, code)));
  });
  return el;
}

/** Highlights a single source or diff line, upgrading in place when the grammar finishes loading. */
export function highlightLine(line: string, langOrPath?: string): DocumentFragment | HTMLElement | string {
  if (!line || line.length > MAX_HIGHLIGHT_CHARS) return line;
  const desc = resolveCodeLanguage(langOrPath);
  if (!desc) return line;
  const cached = parserCache.get(desc);
  if (cached) return tokensToFragment(tokenizeWithParser(cached, line));
  const holder = h('span.wt-hl-line', {}, line);
  void loadParser(desc).then((parser) => {
    if (!parser || !holder.isConnected) return;
    holder.replaceWith(tokensToFragment(tokenizeWithParser(parser, line)));
  });
  return holder;
}

/** Wires a keyboard-accessible Copy button that flips to `Copied` for 1,500ms and cleans up its timer. */
export function attachCopyFeedback(btn: HTMLButtonElement, getText: () => string, defaultLabel = 'Copy'): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    btn.classList.remove('copied');
    btn.textContent = defaultLabel;
  };
  btn.addEventListener('click', () => {
    const text = getText();
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip?.writeText) return;
    void clip
      .writeText(text)
      .then(() => {
        if (timer !== undefined) clearTimeout(timer);
        btn.classList.add('copied');
        btn.textContent = 'Copied';
        timer = setTimeout(() => {
          timer = undefined;
          if (btn.isConnected) {
            btn.classList.remove('copied');
            btn.textContent = defaultLabel;
          }
        }, COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  });
  return reset;
}

/** Updates `.wt-code-scroll` overflow classes and `.wt-code-cue` visibility for a scrollable `<pre>` or table container. */
export function syncHorizontalScrollCue(frame: HTMLElement): void {
  const scroller = frame.querySelector<HTMLElement>('.wt-horizontal-content');
  const cue = frame.querySelector<HTMLElement>('.wt-code-cue');
  if (!scroller || !cue) return;
  const overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
  frame.classList.toggle('overflowing', overflowing);
  frame.classList.toggle('at-end', scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1);
  cue.hidden = !overflowing;
}

/** Builds `.wt-code-block` with language header, accessible Copy button, and horizontally scrollable `<pre>`. */
export function renderCodeFrame(code: string, opts?: { lang?: string; copyLabel?: string }): HTMLElement {
  const label = codeLanguageLabel(opts?.lang);
  const copyLabel = opts?.copyLabel ?? 'Copy';
  const copyBtn = h(
    'button.btn.sm.ghost.wt-code-copy',
    {
      type: 'button',
      'aria-label': opts?.copyLabel ?? `Copy ${label} code`,
    },
    copyLabel,
  );
  attachCopyFeedback(copyBtn, () => code, copyLabel);

  const codeEl = highlightCodeBlock(code, opts?.lang);
  const pre = h(
    'pre.wt-horizontal-content',
    {
      tabindex: 0,
      'aria-label': `${label} code block, scroll horizontally`,
    },
    codeEl,
  );
  const cue = h('span.wt-code-cue', { hidden: true }, 'Scroll horizontally ↔');
  const scrollWrap = h('div.wt-code-scroll', {}, pre, cue);
  pre.addEventListener('scroll', () => syncHorizontalScrollCue(scrollWrap));

  return h('div.wt-code-block', {}, h('div.wt-code-head', {}, h('span.wt-code-lang', {}, label), h('div.wt-code-actions', {}, copyBtn)), scrollWrap);
}
