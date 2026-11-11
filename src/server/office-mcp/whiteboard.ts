import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readerOf, stateAt, type Anchor, type Op } from '../../shared/whiteboard.js';
import { readBoard, workerAuthor } from '../whiteboard-agent.js';
import { formatRead, printable } from './whiteboard-format.js';
import { officeAccess, officeError, officeResult, ownFloor, record, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `The Whiteboard holds reviewable screenshots, mockups, diagrams, plans, decisions, and forms (keep short answers in your terminal). After creating a card, name its title and id in your terminal. Read feedback with whiteboard_read before editing a card (CHANGED marks updates since your last read). Use stable data-wb-id anchors and a 1280px-wide layout. Never put secrets in cards (opaque-origin sandbox has network access; persist data in card JSON state).
window.whiteboard API: state.get(path?), state.set([path,]val), state.merge([path,]obj), state.del(path), on('state'|'ready'|'mode',fn), action(name,data?), card {id,title,author}, rendering (skip side effects when true). Plain inputs save to state.fields; data-wb-action buttons record state.actions[name]. Decision buttons that notify you need data-wb-ping="message" (e.g. <button data-wb-action="accept" data-wb-ping="Approved">Approve</button>): pressing types into the last HTML editor's terminal, sets state.pinged[name], and disables the button (data-wb-ping-state="ready"|"sent"|"unavailable") until re-armed via whiteboard_state del pinged.<name>.
Disk paths resolve against your working folder. Linked cards follow their local file/folder until unlinked. Board state lives in .droid-office/whiteboard/board.json with read-only blob paths; mutate only via whiteboard_* tools.`;

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
const SOURCES = ['html', 'file', 'dir', 'image', 'link', 'canvas'] as const;
const source = z
  .object({
    html: z.string().optional().describe('Inline HTML.'),
    file: z.string().optional().describe('An HTML file; its referenced assets are collected.'),
    dir: z.string().optional().describe('A folder package, shown from entry.'),
    image: z.string().optional().describe('A PNG, JPEG, GIF or WebP file.'),
    link: z.string().optional().describe('A file or folder the card follows.'),
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
      for (const key of ['file', 'dir', 'image', 'link']) if (key in load) load[key] = absolute(load[key]);
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
  if (given.length !== 1) {
    const example = 'for example {"dir": "artifacts/report", "entry": "index.html"} or {"file": "report.html"}';
    return given.length ? `source takes exactly one of html, file, dir, image, link or canvas, not ${given.join(' and ')}.` : `source needs one of html, file, dir, image, link or canvas, ${example}.`;
  }
  const kind = given[0];
  if (value.entry !== undefined && kind !== 'dir' && kind !== 'link') return `entry goes with dir or link, not ${kind}. Use {"dir": "folder", "entry": "page.html"} for a page inside a folder.`;
  return { kind, load: { [kind]: value[kind], ...(value.entry === undefined ? {} : { entry: value.entry }) } };
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
      name: 'whiteboard_read',
      description:
        'Read board/cards (HTML, state, marks, CHANGED pieces). Returned cards advance read points; failed reads do not. With png: true, current-snapshot tiles advance reads, cards without images stay unread; older images carry their actual revision and age.',
      inputSchema: z.object({
        cards: z.array(z.string()).optional().describe('Card ids; omit for whole board.'),
        json: z.boolean().optional().describe('Format text output as JSON.'),
        png: z.boolean().optional().describe('Include rendered PNG tiles with marks.'),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    officeAccess.worker,
    async (args, caller, signal) => {
      const floor = ownFloor(caller);
      const out = await readBoard(floor.whiteboard, readerOf(workerAuthor(caller.worker)), { id: floor.id, name: floor.name }, { ...args, signal });
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
      const text = args.json ? JSON.stringify(structured, null, 2) : printable(formatRead(out, { now: Date.now(), full: !!args.cards, pngs }));
      result.content.unshift({ type: 'text', text });
      result.structuredContent = structured;
      // Build the complete response before recording a read. Rendering failures stay unread.
      if (signal.aborted) return officeError('The read was cancelled before its result reached you, so nothing was marked read.');
      const returned = out.returned.filter((id) => !args.png || !out.cards.some((card) => card.id === id && !card.png?.ok));
      if (returned.length) {
        const moved = apply(caller, [{ op: 'read', cards: returned, rev: out.rev }]);
        if (moved.isError) return moved;
      }
      return result;
    },
  );
  server.tool(
    {
      name: 'whiteboard_card',
      description:
        'Create, update, link/unlink, remove, or show a Whiteboard card. Create needs title/source; update needs title and/or non-canvas source and preserves marks/state. Unlink linked content before replacing it. show with grid: true selects the grid.',
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'link', 'unlink', 'remove', 'show']),
        card: z.string().optional().describe('Card id (optional on create).'),
        title: z.string().optional(),
        source: source.optional().describe('Object with one of html, file, dir, image, link, or canvas (create only), plus optional entry with dir/link.'),
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
      if (args.action === 'create') {
        if (!args.title?.trim() || !picked) return officeError('Create needs a nonempty title and a source: html, file, dir, image, link or canvas.');
        const result = apply(caller, [{ op: 'card.create', card, title: args.title.trim(), kind: picked.kind === 'canvas' ? 'canvas' : 'html', ...(content ? { content } : {}) }], { card });
        if (!result.isError) {
          const floor = ownFloor(caller);
          const created = await readBoard(floor.whiteboard, caller.worker.id, floor, { cards: [card] });
          const details = created.cards[0];
          const warnings = [...(details?.content?.missing ?? []).map((missing) => `Not collected: ${missing.ref} (${missing.reason})`), ...(details?.link?.status === 'broken' ? [`The link is broken: ${details.link.reason}`] : [])];
          if (warnings.length) result.content.push({ type: 'text', text: printable(warnings.join('\n')) });
        }
        return result;
      }
      if (args.action === 'update') {
        if (picked?.kind === 'canvas' || picked?.kind === 'link') return officeError('Update takes html, file, dir or image. Use the link action to link a source; canvas is only for create.');
        const ops: Record<string, unknown>[] = [];
        if (args.title !== undefined) ops.push({ op: 'card.title', card, title: args.title.trim() });
        if (content) ops.push({ op: 'card.content', card, content });
        return ops.length ? apply(caller, ops, { card }) : officeError('Update needs a title or source.');
      }
      if (args.action === 'link') {
        if (picked?.kind !== 'link') return officeError('Link needs source: {link: "file-or-folder", entry?: "index.html"}.');
        return apply(caller, [{ op: 'card.linkTo', card, path: picked.load.link, ...(picked.load.entry === undefined ? {} : { entry: picked.load.entry }) }], { card });
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
Content: {load:{html}|{file}|{dir,entry?}|{image}|{link,entry?}}. Picture file: {load:"path"}. Disk inputs resolve against your working folder, package entries stay inside their folder. Batch anchors use the stored form {kind:"point",point:{x,y}} or {kind:"element",wbId?,selector?,quote?,offset?:{x,y},point:{x,y}}, not whiteboard_marks shorthand. Use the focused tools for ordinary work.`,
      inputSchema: z.object({ ops: z.array(z.record(z.string(), z.unknown())).describe('Ordered operations; any invalid op rejects the whole batch.') }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    (args, caller) => apply(caller, args.ops),
  );
}
