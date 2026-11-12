import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FACTORY_ARTIFACT_CSS, FACTORY_HTML_STARTER, FACTORY_LOGOS, FACTORY_TOKENS, GUIDE_TOPICS, formatWhiteboardGuide } from '../../shared/whiteboard-design.js';
import { extractMarkdownTitle } from '../../shared/whiteboard-markdown.js';
import { readerOf, stateAt, type Anchor, type Op } from '../../shared/whiteboard.js';
import { readBoard, workerAuthor } from '../whiteboard-agent.js';
import { formatRead, printable } from './whiteboard-format.js';
import { officeAccess, officeError, officeResult, ownFloor, record, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `The Whiteboard holds reviewable screenshots, recordings, mockups, diagrams, plans, decisions, and forms (keep short answers in your terminal). Prefer dedicated sources in whiteboard_card (markdown, markdownFile, video, image, or link) before hand-writing HTML; call whiteboard_guide first when building custom HTML or using Factory brand marks. Pass show: true on create/update/link to display on the 3D wall, and after creating a card, name its title and id in your terminal. Read feedback with whiteboard_read (onlyChanged: true for unread only, peek: true without advancing reads) before editing a card (CHANGED marks updates since your last read). Use stable data-wb-id anchors and a 1280px-wide layout. Never put secrets in cards (opaque-origin sandbox has network access; persist data in card JSON state).
window.whiteboard API: state.get(path?), state.set([path,]val), state.merge([path,]obj), state.del(path), on('state'|'ready'|'mode'|'seek',fn), action(name,data?), card {id,title,author}, rendering (skip side effects when true). Plain inputs save to state.fields; data-wb-action buttons record state.actions[name]. Decision buttons that notify you need data-wb-ping="message" (e.g. <button data-wb-action="accept" data-wb-ping="Approved">Approve</button>): pressing types into the last HTML editor's terminal, sets state.pinged[name], and disables the button (data-wb-ping-state="ready"|"sent"|"unavailable") until re-armed via whiteboard_state del pinged.<name>.
Disk paths resolve against your working folder. Linked cards follow their local file (.html, .md, image, video) or folder until unlinked. Board state lives in .droid-office/whiteboard/board.json with read-only blob paths; mutate only via whiteboard_* tools.`;

// Each argument is one flat, closed object checked by the handler, never a union of closed objects: Droid validates
// Script tool calls with Ajv removeAdditional, which strips keys while trying each anyOf branch and empties the value.
const point = z.object({ x: z.number(), y: z.number() });
const anchor = z
  .object({
    on: z.string().optional().describe('A data-wb-id.'),
    selector: z.string().optional().describe('A CSS selector, instead of on.'),
    quote: z.string().optional().describe('Text inside the selected element.'),
    at: point.optional().describe('Page position, the fallback when the element is missing.'),
    offset: point.optional().describe('From the element top-left, with on or selector.'),
  })
  .strict();
const actionButton = z
  .object({
    action: z.string().describe('Action name recorded in state.actions.<action>.'),
    label: z.string().describe('Button words shown on the card.'),
    ping: z.string().optional().describe('Message typed into your terminal when the owner presses this button.'),
    primary: z.boolean().optional().describe('Style as the primary inverted Factory CTA.'),
  })
  .strict();
const SOURCES = ['html', 'markdown', 'markdownFile', 'file', 'dir', 'video', 'image', 'link', 'canvas'] as const;
const source = z
  .object({
    html: z.string().optional().describe('Inline HTML (1280px wide; call whiteboard_guide for Factory CSS).'),
    markdown: z.string().optional().describe('Inline GitHub-Flavored Markdown rendered in Factory design.'),
    markdownFile: z.string().optional().describe('A local .md file; relative images inside its folder are collected.'),
    file: z.string().optional().describe('An HTML file; its referenced assets are collected.'),
    dir: z.string().optional().describe('A folder package, shown from entry.'),
    video: z.string().optional().describe('A local MP4, WebM, MOV or Ogg video file.'),
    poster: z.string().optional().describe('With video: optional local poster image (PNG/JPEG/WebP/GIF/SVG).'),
    image: z.string().optional().describe('A PNG, JPEG, GIF, WebP or SVG file.'),
    caption: z.string().optional().describe('With video or image: optional caption shown on the card.'),
    theme: z.enum(['dark', 'light']).optional().describe('With markdown, markdownFile, video or image: dark (default) or light Factory mood.'),
    actions: z.array(actionButton).optional().describe('With markdown or markdownFile: decision/ping buttons rendered at the bottom of the document.'),
    link: z.string().optional().describe('A file (.html, .md, image, video) or folder the card follows live.'),
    entry: z.string().optional().describe('With dir or link: the page inside the folder, default index.html.'),
    canvas: z.literal(true).optional().describe('Create only: a blank canvas.'),
  })
  .strict();
type Source = z.infer<typeof source>;
type SourceKind = (typeof SOURCES)[number];
const box = z.object({ x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional() });
const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
const dotted = (value?: string) => (!value || value === '.' ? [] : value.split('.'));

/** Resolve relative disk sources against the caller's working folder, leaving package entries and URLs as given. */
function resolvePaths(ops: Record<string, unknown>[], cwd: string): Op[] {
  const absolute = (value: unknown) => (typeof value === 'string' ? path.resolve(cwd, value) : value);
  return ops.map((original) => {
    const op = { ...original };
    if (record(op.content) && record(op.content.load)) {
      const load = { ...op.content.load };
      for (const key of ['file', 'markdownFile', 'dir', 'video', 'poster', 'image', 'link']) {
        if (key in load && load[key] !== undefined) load[key] = absolute(load[key]);
      }
      op.content = { ...op.content, load };
    }
    if (record(op.file) && typeof op.file.load === 'string') op.file = { ...op.file, load: absolute(op.file.load) };
    if (op.op === 'card.linkTo') op.path = absolute(op.path);
    return op as unknown as Op;
  });
}

function apply(caller: OfficeMcpCaller, ops: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const floor = ownFloor(caller);
  const store = floor.whiteboard;
  const out = store.apply({ epoch: store.issueEpoch(), seq: 1, ops: resolvePaths(ops, caller.cwd ?? floor.dir) }, workerAuthor(caller.worker), 'agent');
  if (out.kind !== 'ack') return officeError(out.reason === 'invalid' ? printable(out.error.message) : 'The batch expired. Read the board before retrying.');
  return officeResult(`Done at revision ${out.rev}.${extra.card ? ` Card: ${extra.card}.` : ''}${extra.id ? ` Mark: ${extra.id}.` : ''}`, { ok: true, rev: out.rev, ...extra });
}

/** The one kind of content a source names, and the load it becomes, or what is wrong with it. */
function sourceOf(value: Source): { kind: SourceKind; load: Record<string, unknown> } | string {
  const given = SOURCES.filter((key) => value[key] !== undefined);
  const list = 'html, markdown, markdownFile, file, dir, video, image, link or canvas';
  if (given.length !== 1) {
    const example = 'for example {"markdown": "# Plan\\n..."}, {"video": "demo.mp4"}, {"dir": "artifacts/report", "entry": "index.html"} or {"file": "report.html"}';
    return given.length ? `source takes exactly one of ${list}, not ${given.join(' and ')}.` : `source needs one of ${list}, ${example}.`;
  }
  const kind = given[0];
  if (value.entry !== undefined && kind !== 'dir' && kind !== 'link') return `entry goes with dir or link, not ${kind}. Use {"dir": "folder", "entry": "page.html"} for a page inside a folder.`;
  if (value.poster !== undefined && kind !== 'video') return `poster goes with video, not ${kind}.`;
  if (value.caption !== undefined && kind !== 'video' && kind !== 'image') return `caption goes with video or image, not ${kind}.`;
  if (value.theme !== undefined && !['markdown', 'markdownFile', 'video', 'image'].includes(kind)) return `theme goes with markdown, markdownFile, video or image, not ${kind}.`;
  if (value.actions !== undefined && kind !== 'markdown' && kind !== 'markdownFile') return `actions goes with markdown or markdownFile, not ${kind}.`;
  const load: Record<string, unknown> = { [kind]: value[kind] };
  if (value.entry !== undefined) load.entry = value.entry;
  if (value.poster !== undefined) load.poster = value.poster;
  if (value.caption !== undefined) load.caption = value.caption;
  if (value.theme !== undefined) load.theme = value.theme;
  if (value.actions !== undefined) load.actions = value.actions;
  return { kind, load };
}

function inferTitle(explicit: string | undefined, picked: { kind: SourceKind; load: Record<string, unknown> } | undefined, cwd: string): string {
  if (explicit !== undefined) return explicit.trim();
  if (!picked) return '';
  if (picked.kind === 'markdown' && typeof picked.load.markdown === 'string') return extractMarkdownTitle(picked.load.markdown) ?? '';
  if (picked.kind === 'markdownFile' && typeof picked.load.markdownFile === 'string') {
    const abs = path.resolve(cwd, picked.load.markdownFile);
    try {
      const text = readFileSync(abs, 'utf8');
      const h1 = extractMarkdownTitle(text);
      if (h1) return h1;
    } catch {
      // let loadMarkdownFile report missing/unreadable files
    }
    return path.basename(abs, path.extname(abs));
  }
  if ((picked.kind === 'video' || picked.kind === 'image') && typeof picked.load[picked.kind] === 'string') {
    const raw = String(picked.load[picked.kind]);
    return path.basename(raw, path.extname(raw));
  }
  return '';
}

function exportBrandLogos(rawDir: string, baseDir: string): { dir: string; files: string[] } | string {
  const trimmed = rawDir.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return 'exportLogosTo must be a relative folder path inside your working folder.';
  const realBase = realpathSync(baseDir);
  const target = path.resolve(realBase, trimmed);
  const rel = path.relative(realBase, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'exportLogosTo must stay inside your working folder.';
  const segments = rel.split(path.sep);
  if (segments.includes('.git') || segments.includes('.droid-office')) {
    return 'exportLogosTo cannot write into .git or .droid-office.';
  }
  let probe = realBase;
  for (const seg of segments) {
    probe = path.join(probe, seg);
    if (existsSync(probe)) {
      const realProbe = realpathSync(probe);
      if (realProbe !== realBase && !realProbe.startsWith(realBase + path.sep)) {
        return 'exportLogosTo cannot traverse a symlink outside your working folder.';
      }
    }
  }
  mkdirSync(target, { recursive: true });
  const files: string[] = [];
  for (const [name, logo] of Object.entries(FACTORY_LOGOS)) {
    const dest = path.join(target, name);
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) return `Refusing to overwrite symlink ${name}.`;
    writeFileSync(dest, logo.svg, 'utf8');
    files.push(path.join(rel, name).split(path.sep).join('/'));
  }
  return { dir: target, files };
}

function anchorProblem(value: z.infer<typeof anchor>): string | undefined {
  if (value.on !== undefined && value.selector !== undefined) return 'An anchor takes on or selector, not both.';
  if (value.on === undefined && value.selector === undefined) {
    if (!value.at) return 'An anchor needs on (a data-wb-id), selector or at {x,y}.';
    if (value.offset) return 'offset goes with on or selector; use at alone for a page position.';
  }
  if (value.quote !== undefined && value.selector === undefined) return 'quote goes with selector.';
  return undefined;
}

function anchorOf(value?: z.infer<typeof anchor>): Anchor {
  const fallback = value?.at ?? { x: 40, y: 40 };
  if (value?.on !== undefined || value?.selector !== undefined) {
    const target = value.on !== undefined ? { wbId: value.on } : { selector: value.selector, ...(value.quote === undefined ? {} : { quote: value.quote }) };
    return { kind: 'element', ...target, point: fallback, offset: value.offset ?? { x: 0, y: 0 } };
  }
  return { kind: 'point', point: fallback };
}

export function register(server: OfficeMcpServer, _deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'whiteboard_guide',
      description: 'Fetch Factory design rules, 1280px CSS starter, tokens, interactive ping/state patterns, and official SVG brand marks. Call before crafting custom HTML/CSS or using Factory brand logos.',
      inputSchema: z.object({
        topic: z.enum(GUIDE_TOPICS).optional().describe('Section: all (default), design, tokens, css, interactive, artifacts, or brand.'),
        exportLogosTo: z.string().optional().describe('Relative directory inside your working folder to write the 6 official Factory SVG marks.'),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    officeAccess.worker,
    (args, caller) => {
      const floor = ownFloor(caller);
      const topic = args.topic ?? 'all';
      let exported: string[] | undefined;
      if (args.exportLogosTo !== undefined) {
        const res = exportBrandLogos(args.exportLogosTo, caller.cwd ?? floor.dir);
        if (typeof res === 'string') return officeError(res);
        exported = res.files;
      }
      const guideText = formatWhiteboardGuide(topic);
      const suffix = exported ? `\n\nExported official Factory SVG marks:\n${exported.map((f) => `- ${f}`).join('\n')}` : '';
      return officeResult(guideText + suffix, {
        topic,
        logos: Object.keys(FACTORY_LOGOS),
        ...(exported ? { exported } : {}),
        ...(topic === 'tokens' || topic === 'all' ? { tokens: FACTORY_TOKENS } : {}),
        ...(topic === 'css' ? { css: FACTORY_ARTIFACT_CSS, starterHtml: FACTORY_HTML_STARTER } : {}),
      });
    },
  );
  server.tool(
    {
      name: 'whiteboard_read',
      description:
        'Read board/cards (Markdown/HTML, state, marks, CHANGED pieces). Returned cards advance read points unless peek: true; failed reads do not. Use onlyChanged: true for unread updates only. With png: true, current-snapshot tiles advance reads, cards without images stay unread; older images carry their actual revision and age.',
      inputSchema: z.object({
        cards: z.array(z.string()).optional().describe('Card ids; omit for whole board.'),
        onlyChanged: z.boolean().optional().describe('Return only cards and removals with unread changes since your last read.'),
        peek: z.boolean().optional().describe('Inspect without advancing your read points.'),
        json: z.boolean().optional().describe('Format text output as JSON.'),
        png: z.boolean().optional().describe('Include rendered PNG tiles with marks.'),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    officeAccess.worker,
    async (args, caller, signal) => {
      const floor = ownFloor(caller);
      const out = await readBoard(floor.whiteboard, readerOf(workerAuthor(caller.worker)), { id: floor.id, name: floor.name }, { cards: args.cards, onlyChanged: args.onlyChanged, png: args.png, signal });
      const result = officeResult('');
      result.content = [];
      const pngs = new Map<string, string>();
      for (const card of out.cards) {
        if (!card.png?.ok) continue;
        const { tiles, ...metadata } = card.png;
        pngs.set(
          card.id,
          `${tiles.length} image tile(s), ${metadata.width}×${metadata.height}, revision ${metadata.rev}, ${metadata.ageMs}ms old; ${metadata.current ? 'current' : 'card changed since snapshot'}${metadata.capped ? `; cut off at ${metadata.capped.capPx}px` : ''}`,
        );
        tiles.forEach((data, index) => {
          const label = { type: 'text' as const, text: `${card.id}, PNG tile ${index + 1}/${tiles.length} (top to bottom).` };
          result.content.push(label, { type: 'image', data, mimeType: 'image/png' });
        });
      }
      // Do not duplicate base64 tiles in JSON text or structuredContent.
      const structured = { ...out, cards: out.cards.map((card) => (card.png?.ok ? { ...card, png: { ...card.png, tiles: undefined, tileCount: card.png.tiles.length } } : card)) };
      const text = args.json ? JSON.stringify(structured, null, 2) : printable(formatRead(out, { now: Date.now(), full: !!args.cards, onlyChanged: args.onlyChanged, peek: args.peek, pngs }));
      result.content.unshift({ type: 'text', text });
      result.structuredContent = structured;
      // Build the complete response before recording a read. Rendering failures stay unread.
      if (signal.aborted) return officeError('The read was cancelled before its result reached you, so nothing was marked read.');
      if (!args.peek) {
        const returned = out.returned.filter((id) => !args.png || !out.cards.some((card) => card.id === id && !card.png?.ok));
        if (returned.length) {
          const moved = apply(caller, [{ op: 'read', cards: returned, rev: out.rev }]);
          if (moved.isError) return moved;
        }
      }
      return result;
    },
  );
  server.tool(
    {
      name: 'whiteboard_card',
      description:
        'Create, update, link/unlink, remove, or show a Markdown, video, image, HTML, or canvas card. Create needs source (title inferred from # Heading or filename for markdown/video/image when omitted); update needs title and/or non-canvas source and preserves marks/state. Unlink linked content before replacing it. Pass show: true on create/update/link to select on the 3D wall; action: "show" with grid: true selects the grid.',
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'link', 'unlink', 'remove', 'show']),
        card: z.string().optional().describe('Card id (optional on create).'),
        title: z.string().optional(),
        source: source.optional().describe('Object with one of html, markdown, markdownFile, file, dir, video, image, link, or canvas (create only), plus optional entry, poster, caption, theme, or actions.'),
        show: z.boolean().optional().describe('With create/update/link: select this card on the 3D wall in the same batch.'),
        grid: z.boolean().optional().describe('Show only: true selects the card grid (omit card).'),
      }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    async (args, caller) => {
      const card = args.card ?? (args.action === 'create' ? newId('c') : undefined);
      if (args.action === 'show') {
        if (args.grid && card) return officeError('Choose a card or grid:true, not both.');
        return apply(caller, [{ op: 'show', selection: card ? { kind: 'card', id: card } : { kind: 'grid' } }]);
      }
      if (!card) return officeError('Give the card id. whiteboard_read lists cards.');
      const picked = args.source ? sourceOf(args.source) : undefined;
      if (typeof picked === 'string') return officeError(picked);
      const content = picked && picked.kind !== 'canvas' ? { load: picked.load } : undefined;
      const floor = ownFloor(caller);
      const cwd = caller.cwd ?? floor.dir;
      if (args.action === 'create') {
        const title = inferTitle(args.title, picked, cwd);
        if (!title || !picked) return officeError('Create needs a nonempty title and a source: html, markdown, markdownFile, file, dir, video, image, link or canvas.');
        const ops: Record<string, unknown>[] = [{ op: 'card.create', card, title, kind: picked.kind === 'canvas' ? 'canvas' : 'html', ...(content ? { content } : {}) }];
        if (args.show) ops.push({ op: 'show', selection: { kind: 'card', id: card } });
        const result = apply(caller, ops, { card, ...(args.show ? { shown: true } : {}) });
        if (!result.isError) {
          const created = await readBoard(floor.whiteboard, caller.worker.id, floor, { cards: [card] });
          const details = created.cards[0];
          const warnings = [...(details?.content?.missing ?? []).map((missing) => `Not collected: ${missing.ref} (${missing.reason})`), ...(details?.link?.status === 'broken' ? [`The link is broken: ${details.link.reason}`] : [])];
          if (warnings.length) result.content.push({ type: 'text', text: printable(warnings.join('\n')) });
        }
        return result;
      }
      if (args.action === 'update') {
        if (picked?.kind === 'canvas' || picked?.kind === 'link') {
          return officeError('Update takes html, markdown, markdownFile, file, dir, video or image. Use the link action to link a source; canvas is only for create.');
        }
        const ops: Record<string, unknown>[] = [];
        if (args.title !== undefined) ops.push({ op: 'card.title', card, title: args.title.trim() });
        if (content) ops.push({ op: 'card.content', card, content });
        if (!ops.length) return officeError('Update needs a title or source.');
        if (args.show) ops.push({ op: 'show', selection: { kind: 'card', id: card } });
        return apply(caller, ops, { card, ...(args.show ? { shown: true } : {}) });
      }
      if (args.action === 'link') {
        if (picked?.kind !== 'link') return officeError('Link needs source: {link: "file-or-folder", entry?: "index.html"}.');
        const ops: Record<string, unknown>[] = [{ op: 'card.linkTo', card, path: picked.load.link, ...(picked.load.entry === undefined ? {} : { entry: picked.load.entry }) }];
        if (args.show) ops.push({ op: 'show', selection: { kind: 'card', id: card } });
        return apply(caller, ops, { card, ...(args.show ? { shown: true } : {}) });
      }
      return apply(caller, [{ op: args.action === 'remove' ? 'card.rm' : 'card.unlink', card }], { card });
    },
  );
  server.tool(
    {
      name: 'whiteboard_state',
      description:
        'Get, set, merge, or delete a dotted state path (e.g. fields.email, pinged.accept; omit for root). Merge recursively writes leaves and replaces arrays; same-leaf writes are last-writer-wins. Reading state does not mark feedback read.',
      inputSchema: z.object({ card: z.string(), op: z.enum(['get', 'set', 'merge', 'del']), path: z.string().optional(), value: z.json().optional().describe('JSON value for set/merge (root set and merge require an object).') }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    async (args, caller) => {
      const path = dotted(args.path);
      if (args.op === 'get') {
        const floor = ownFloor(caller);
        const out = await readBoard(floor.whiteboard, caller.worker.id, floor, { cards: [args.card] });
        const card = out.cards[0];
        if (!card) return officeError(`No such card: ${args.card}. Use whiteboard_read to list cards.`);
        const value = stateAt(card.state, path);
        return value === undefined ? officeError(`${args.card} has nothing at ${args.path ?? '(root)'}.`) : officeResult(JSON.stringify(value, null, 2), { card: args.card, path, value });
      }
      if (args.op !== 'del' && args.value === undefined) return officeError('Give a JSON value for set or merge.');
      return apply(caller, [{ op: `state.${args.op}`, card: args.card, path, ...(args.op === 'del' ? {} : { value: args.value }) }]);
    },
  );
  server.tool(
    {
      name: 'whiteboard_marks',
      description: 'Add or modify a comment thread (add/reply/edit/resolve/reopen/reattach/remove), sticky (add/edit/move/reattach/remove), or picture (add/file/move/reattach/remove) on a card.',
      inputSchema: z.object({
        card: z.string(),
        kind: z.enum(['comment', 'sticky', 'picture']),
        op: z.enum(['add', 'reply', 'edit', 'resolve', 'reopen', 'move', 'file', 'reattach', 'remove']),
        id: z.string().optional().describe('Existing mark id (generated on add).'),
        message: z.string().optional().describe('Comment message id for edit or single-message remove.'),
        text: z.string().optional().describe('Comment or sticky text.'),
        anchor: anchor.optional().describe('on (data-wb-id), selector (+ optional quote), or at {x,y} at 1280px width.'),
        box: box.optional().describe('Position x,y and/or size w,h.'),
        color: z.enum(['yellow', 'pink', 'blue', 'green', 'purple', 'orange']).optional(),
        file: z.string().optional().describe('Local image path for picture add/file.'),
      }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    (args, caller) => {
      const allowed = { comment: ['add', 'reply', 'edit', 'resolve', 'reopen', 'reattach', 'remove'], sticky: ['add', 'edit', 'move', 'reattach', 'remove'], picture: ['add', 'file', 'move', 'reattach', 'remove'] };
      if (!allowed[args.kind].includes(args.op)) return officeError(`${args.kind} supports ${allowed[args.kind].join(', ')}.`);
      if (args.op !== 'add' && !args.id) return officeError('Give the existing mark id. Read the card to find it.');
      if (args.op === 'reattach' && !args.anchor) return officeError('Reattach needs an anchor: on, selector or at.');
      const badAnchor = args.anchor && anchorProblem(args.anchor);
      if (badAnchor) return officeError(badAnchor);
      if (args.op === 'move' && !Object.keys(args.box ?? {}).length && !args.anchor?.at) return officeError('Move needs a box position/size or anchor.at.');
      if (args.kind === 'comment' && ['add', 'reply', 'edit'].includes(args.op) && !args.text?.trim()) return officeError('Give nonempty text for the comment.');
      if (args.kind === 'comment' && args.op === 'edit' && !args.message) return officeError('Editing a comment needs its message id.');
      if (args.kind === 'picture' && ['add', 'file'].includes(args.op) && !args.file) return officeError('Give the local picture file path.');
      const id = args.op === 'add' ? newId({ comment: 't', sticky: 's', picture: 'p' }[args.kind]) : args.id!;
      const op: Record<string, unknown> = { op: `${args.kind}.${args.op === 'remove' ? 'rm' : args.op}`, card: args.card, ...(args.kind === 'comment' ? { thread: id } : { id }) };
      if (args.text !== undefined) op.text = args.text;
      if (args.color !== undefined) op.color = args.color;
      if (args.op === 'add' || args.op === 'reattach') op.anchor = anchorOf(args.anchor);
      if (args.box !== undefined) op.box = args.box;
      if (args.op === 'move' && args.anchor?.at) op.box = { ...args.box, ...args.anchor.at };
      if (args.kind === 'picture' && args.file !== undefined) op.file = { load: args.file };
      if (args.kind === 'comment') {
        if (args.op === 'add' || args.op === 'reply') op.message = newId('m');
        else if (args.message !== undefined) op.message = args.message;
      }
      return apply(caller, [op], { card: args.card, id, ...(typeof op.message === 'string' ? { message: op.message } : {}) });
    },
  );
  server.tool(
    {
      name: 'whiteboard_apply',
      description: `Apply an atomic batch, all or nothing; errors name the failed operation. New ids are yours to choose (1–64 letters/digits/_/-).
Operations: card.create {card,kind:html|canvas,title,content?}; card.title {card,title}; card.content {card,content}; card.rm {card}; card.linkTo {card,path,dir?,entry?}; card.unlink {card}; card.view {card,view:{x,y,w,h}|null}.
state.set|merge {card,path:[keys],value}; state.del {card,path}; state.action {card,name,data?}.
comment.add {card,thread,message,anchor,text}; comment.reply|edit {card,thread,message,text}; comment.resolve|reopen {card,thread}; comment.reattach {card,thread,anchor}; comment.rm {card,thread,message?}.
sticky.add {card,id,anchor,box?,text?,color?}; sticky.edit {card,id,text?,color?}; sticky.move {card,id,box}; sticky.reattach {card,id,anchor}; sticky.rm {card,id}.
picture.add {card,id,file,anchor,box?}; picture.file {card,id,file}; picture.move {card,id,box}; picture.reattach {card,id,anchor}; picture.rm {card,id}.
show {selection:{kind:"grid"}|{kind:"card",id}}; read {cards:[ids],rev}.
Content: {load:{html}|{markdown,theme?,actions?}|{markdownFile,theme?,actions?}|{file}|{dir,entry?}|{video,poster?,caption?,theme?}|{image,caption?,theme?}|{link,entry?}}. Picture file: {load:"path"}. Disk inputs resolve against your working folder, package entries stay inside their folder. Batch anchors use the stored form {kind:"point",point:{x,y}} or {kind:"element",wbId?,selector?,quote?,offset?:{x,y},point:{x,y}}, not whiteboard_marks shorthand. Use the focused tools for ordinary work.`,
      inputSchema: z.object({ ops: z.array(z.record(z.string(), z.unknown())).describe('Ordered operations; any invalid op rejects the whole batch.') }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    (args, caller) => apply(caller, args.ops),
  );
}
