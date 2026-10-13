import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, LanguageDescription, type LanguageSupport, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { isDocPath } from '../../shared/docs';

// CodeMirror 6 wrapper for the Bookshelf file editor (ui/bookshelf.ts): dark office theme matching
// style.css tokens, lazy language loading across project file types, search/replace panel, and
// Mod-S / Mod-F keybindings.

export interface CodeEditorCursor {
  line: number;
  col: number;
  selected: number;
  lines: number;
}

export interface CodeEditorOptions {
  parent: HTMLElement;
  path: string;
  text: string;
  onChange?: (text: string, dirty: boolean) => void;
  onSave?: () => void;
  onCursor?: (cursor: CodeEditorCursor) => void;
  onScroll?: () => void;
}

export interface CodeEditor {
  readonly view: EditorView;
  getText(): string;
  /** Marks `text` (or the current buffer when omitted) as the saved baseline. */
  setSavedText(text?: string): void;
  /** Reverts the buffer to the last saved baseline. */
  discard(): void;
  /** Loads a file path and text into the editor with a clean undo history and syntax mode. */
  loadFile(path: string, text: string): void;
  isDirty(): boolean;
  focus(): void;
  goToLine(line: number): void;
  openSearch(): void;
  closeSearch(): boolean;
  languageName(): string;
  destroy(): void;
}

const ALIAS_FILENAME: Record<string, string> = {
  jsonc: 'file.json',
  mjs: 'file.js',
  cjs: 'file.js',
  mts: 'file.ts',
  cts: 'file.ts',
  mdx: 'file.md',
  env: 'file.sh',
  gitignore: 'file.sh',
  dockerignore: 'file.sh',
};

function matchLanguage(path: string): LanguageDescription | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const direct = LanguageDescription.matchFilename(languages, base);
  if (direct) return direct;
  const lower = base.toLowerCase();
  if (lower.startsWith('.env')) return LanguageDescription.matchFilename(languages, 'file.sh');
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const alias = ALIAS_FILENAME[lower.slice(dot + 1)];
    if (alias) return LanguageDescription.matchFilename(languages, alias);
  }
  return null;
}

/** Human-readable language label for a project path ("Markdown", "TypeScript", "JSON", …). */
export function languageLabel(path: string): string {
  if (isDocPath(path)) return 'Markdown';
  return matchLanguage(path)?.name ?? 'Plain text';
}

const officeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#ee6018', fontWeight: '500' },
  { tag: [tags.definitionKeyword, tags.modifier], color: '#ef6f2e' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: '#5aa9e6' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.macroName], color: '#f2b84b' },
  { tag: [tags.string, tags.special(tags.string), tags.inserted], color: '#3ccf91' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.null, tags.self], color: '#f2b84b' },
  { tag: [tags.regexp, tags.escape, tags.meta, tags.annotation, tags.processingInstruction], color: '#c084fc' },
  { tag: [tags.propertyName, tags.attributeName], color: '#9cdcfe' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: '#eeeeee' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: '#b4b4b4' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#8c8c8c', fontStyle: 'italic' },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: '#ee6018', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#ef6f2e', fontWeight: '600' },
  { tag: [tags.emphasis], fontStyle: 'italic', color: '#eeeeee' },
  { tag: [tags.strong], fontWeight: '600', color: '#ffffff' },
  { tag: [tags.link, tags.url], color: '#5aa9e6', textDecoration: 'underline' },
  { tag: [tags.monospace], color: '#3ccf91' },
  { tag: [tags.deleted, tags.invalid], color: '#ef4444' },
]);

const officeEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      fontFamily: 'var(--font-mono)',
      fontSize: '13px',
      lineHeight: '1.6',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': {
      padding: '16px 0 48px',
      caretColor: 'var(--accent)',
    },
    '.cm-line': {
      padding: '0 20px 0 12px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--accent)',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(238, 96, 24, 0.24) !important',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.03)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(90, 169, 230, 0.2)',
      outline: '1px solid rgba(90, 169, 230, 0.4)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(242, 184, 75, 0.24)',
      outline: '1px solid rgba(242, 184, 75, 0.5)',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(238, 96, 24, 0.42)',
      outline: '1px solid var(--accent)',
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(60, 207, 145, 0.22)',
      outline: '1px solid rgba(60, 207, 145, 0.55)',
      color: '#ffffff',
    },
    '&.cm-focused .cm-nonmatchingBracket': {
      backgroundColor: 'rgba(239, 68, 68, 0.25)',
      outline: '1px solid var(--danger)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-raised)',
      color: 'var(--text-tertiary)',
      borderRight: '1px solid var(--border)',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 14px',
      minWidth: '42px',
      fontSize: '11.5px',
    },
    '.cm-foldGutter .cm-gutterElement': {
      padding: '0 4px',
      cursor: 'pointer',
      color: 'var(--text-secondary)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(238, 96, 24, 0.1)',
      color: 'var(--text)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--surface-raised)',
      color: 'var(--text)',
      borderBottom: '1px solid var(--border)',
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
    },
    '.cm-panel.cm-search': {
      padding: '8px 12px',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
    },
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
      fontFamily: 'var(--font-mono)',
      fontSize: '11.5px',
      margin: '0',
    },
    '.cm-panel.cm-search input[type=text], .cm-panel.cm-search input:not([type])': {
      width: '180px',
      minHeight: '26px',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius)',
      padding: '3px 8px',
      outline: 'none',
    },
    '.cm-panel.cm-search label': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      margin: '0 4px',
      color: 'var(--text-secondary)',
      cursor: 'pointer',
      textTransform: 'uppercase',
    },
    '.cm-panel.cm-search input[type=checkbox]': {
      width: 'auto',
      minHeight: '0',
      margin: '0',
      accentColor: 'var(--accent)',
    },
    '.cm-panel.cm-search br': {
      display: 'none',
    },
    '.cm-panel.cm-search input:focus': {
      borderColor: 'var(--accent)',
    },
    '.cm-panel.cm-search button': {
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius)',
      padding: '3px 8px',
      cursor: 'pointer',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    },
    '.cm-panel.cm-search button:hover': {
      backgroundColor: 'var(--surface-hover)',
    },
    '.cm-panel.cm-search button[name=close]': {
      marginLeft: 'auto',
      border: 'none',
      background: 'transparent',
      color: 'var(--text-secondary)',
      fontSize: '14px',
      padding: '2px 6px',
    },
  },
  { dark: true },
);

export function createCodeEditor(opts: CodeEditorOptions): CodeEditor {
  const langCompartment = new Compartment();
  let currentPath = opts.path;
  let savedText = opts.text;
  let loadSeq = 0;

  const cursorOf = (state: EditorState): CodeEditorCursor => {
    const main = state.selection.main;
    const ln = state.doc.lineAt(main.head);
    return {
      line: ln.number,
      col: main.head - ln.from + 1,
      selected: main.empty ? 0 : Math.abs(main.to - main.from),
      lines: state.doc.lines,
    };
  };

  const initialLang = (path: string): Extension => {
    if (isDocPath(path)) return markdown({ codeLanguages: languages });
    const desc = matchLanguage(path);
    return desc?.support ?? [];
  };

  const loadAsyncLang = (path: string) => {
    const seq = ++loadSeq;
    if (isDocPath(path)) return;
    const desc = matchLanguage(path);
    if (!desc || desc.support) return;
    void desc
      .load()
      .then((support: LanguageSupport) => {
        if (seq !== loadSeq) return;
        view.dispatch({ effects: langCompartment.reconfigure(support) });
      })
      .catch(() => {
        // Keep plain text editing when a grammar fails to load.
      });
  };

  const makeState = (path: string, text: string): EditorState =>
    EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        EditorView.lineWrapping,
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(officeHighlight, { fallback: true }),
        officeEditorTheme,
        langCompartment.of(initialLang(path)),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              opts.onSave?.();
              return true;
            },
          },
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
        ]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            const now = update.state.doc.toString();
            opts.onChange?.(now, now !== savedText);
          }
          if (update.selectionSet || update.docChanged) {
            opts.onCursor?.(cursorOf(update.state));
          }
        }),
        EditorView.domEventHandlers({
          scroll: () => {
            opts.onScroll?.();
          },
        }),
      ],
    });

  const view = new EditorView({
    state: makeState(currentPath, opts.text),
    parent: opts.parent,
  });
  loadAsyncLang(currentPath);
  opts.onCursor?.(cursorOf(view.state));

  return {
    view,
    getText() {
      return view.state.doc.toString();
    },
    setSavedText(text?: string) {
      if (text !== undefined && text !== view.state.doc.toString()) {
        savedText = text;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
      } else {
        savedText = view.state.doc.toString();
        opts.onChange?.(savedText, false);
      }
    },
    discard() {
      const now = view.state.doc.toString();
      if (now !== savedText) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: savedText },
        });
      }
      opts.onChange?.(savedText, false);
    },
    loadFile(path: string, text: string) {
      currentPath = path;
      savedText = text;
      view.setState(makeState(path, text));
      loadAsyncLang(path);
      opts.onChange?.(text, false);
      opts.onCursor?.(cursorOf(view.state));
    },
    isDirty() {
      return view.state.doc.toString() !== savedText;
    },
    focus() {
      view.focus();
    },
    goToLine(line: number) {
      const doc = view.state.doc;
      const clamped = Math.max(1, Math.min(doc.lines, Math.floor(line)));
      const info = doc.line(clamped);
      view.dispatch({
        selection: { anchor: info.from },
        effects: EditorView.scrollIntoView(info.from, { y: 'center' }),
      });
      view.focus();
    },
    openSearch() {
      openSearchPanel(view);
    },
    closeSearch() {
      if (!searchPanelOpen(view.state)) return false;
      return closeSearchPanel(view);
    },
    languageName() {
      return languageLabel(currentPath);
    },
    destroy() {
      loadSeq++;
      view.destroy();
    },
  };
}
