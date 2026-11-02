import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readerOf, stateAt, type Anchor, type Op } from '../../shared/whiteboard.js';
import { readBoard, workerAuthor } from '../whiteboard-agent.js';
import { formatRead, printable } from './whiteboard-format.js';
import { officeAccess, officeError, officeResult, record, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `The Whiteboard is the floor's shared wall of HTML artifacts and canvases. Use it for reviewable screenshots, mockups, diagrams, reports, plans, decisions, options and forms. Plain progress and short answers stay in your terminal. After creating a card, name its title and id in your terminal so the owner can find it. Read feedback with whiteboard_read before changing an existing card, and answer the owner's comments, stickies, form answers and button presses. CHANGED means someone else changed that piece since your last read of that card.
Good artifacts have stable data-wb-id anchors on sections, options and steps, and a layout 1280 pixels wide (any height). Never put secrets in an artifact: its sandbox has network access. Pages run on an opaque origin without shared cookies or localStorage; keep persistent data in the card's JSON state.
The injected window.whiteboard API: state.get(path?) returns a copy; state.set(value) replaces the object, set(path,value) sets a leaf; state.merge(obj) or merge(path,obj) recursively merges leaves and replaces arrays; state.del(path) removes it. Paths are dotted strings or key arrays. on('state',fn) observes own and remote changes; on('ready',fn) and ready indicate state arrival; on('mode',fn) and mode are 'use' or 'markup'. action(name,data?) records state.actions[name] = {name,data,at}; card is {id,title,author}. rendering is true during image capture: writes are dropped, so skip external side effects then. Without JavaScript, fields with a name or id save/restore state.fields, buttons with data-wb-action and optional JSON data-wb-data record actions, and form submission records 'submit'. Typing is not overwritten mid-edit.
File sources resolve against your working folder, never the office server's. A file collects its markup/CSS assets inside its folder; a dir includes runtime-loaded files (modules, fetch), except hidden files and node_modules. Outside references, missing files and limits are reported, never silently included; folder entries and symlink assets cannot escape the folder. Remote URLs stay remote. Linked cards follow their source file/folder: edit that source, or unlink before replacing content. A missing linked source keeps its last good content and reports a broken link until it recovers.
The floor stores board.json, its key and content-addressed blobs under .droid-office/whiteboard/. File paths returned by reads are read-only blob paths: never edit them. Use whiteboard_state for answers and application data, whiteboard_marks for feedback, and whiteboard_apply for atomic batches.`;

const point = z.object({ x: z.number(), y: z.number() });
const anchor = z.union([
  z.object({ on: z.string(), at: point.optional(), offset: point.optional() }).strict(),
  z.object({ selector: z.string(), quote: z.string().optional(), at: point.optional(), offset: point.optional() }).strict(),
  z.object({ at: point }).strict(),
]);
const source = z.union([
  z.object({ html: z.string() }).strict(),
  z.object({ file: z.string() }).strict(),
  z.object({ dir: z.string(), entry: z.string().optional() }).strict(),
  z.object({ image: z.string() }).strict(),
  z.object({ link: z.string(), entry: z.string().optional() }).strict(),
  z.object({ canvas: z.literal(true) }).strict(),
]);
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
  const store = caller.floor.whiteboard;
  const out = store.apply({ epoch: store.issueEpoch(), seq: 1, ops: resolvePaths(ops, caller.cwd) }, workerAuthor(caller.worker), 'agent');
  if (out.kind !== 'ack') return officeError(out.reason === 'invalid' ? printable(out.error.message) : 'The batch expired. Read the board before retrying.');
  return officeResult(`Done at revision ${out.rev}.${extra.card ? ` Card: ${extra.card}.` : ''}${extra.id ? ` Mark: ${extra.id}.` : ''}`, { ok: true, rev: out.rev, ...extra });
}

function anchorOf(value?: z.infer<typeof anchor>): Anchor {
  const fallback = value && 'at' in value && value.at ? value.at : { x: 40, y: 40 };
  if (value && ('on' in value || 'selector' in value)) {
    return { kind: 'element', ...('on' in value ? { wbId: value.on } : { selector: value.selector, ...(value.quote === undefined ? {} : { quote: value.quote }) }), point: fallback, offset: value.offset ?? { x: 0, y: 0 } };
  }
  return { kind: 'point', point: fallback };
}

export function register(server: OfficeMcpServer, _deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'whiteboard_read',
      description:
        'Read the board or selected cards, including HTML, read-only asset paths, state, comments, stickies, pictures, removals and CHANGED pieces. Only returned cards move their read points, to this snapshot revision. A failed read moves nothing. With png, each card returns current-snapshot PNG image tiles or an honest reason and last-image age; cards without images remain unread. Never use an older image as if it showed the current snapshot.',
      inputSchema: z.object({
        cards: z.array(z.string()).optional().describe('Card ids; omit for the whole board.'),
        json: z.boolean().optional().describe('Return exact JSON text instead of readable text; structuredContent is always available.'),
        png: z.boolean().optional().describe('Include MCP PNG image content, labeled by card and tile, with marks drawn on top.'),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    officeAccess.worker,
    async (args, caller, signal) => {
      const out = await readBoard(caller.floor.whiteboard, readerOf(workerAuthor(caller.worker)), { id: caller.floor.id, name: caller.floor.name }, { ...args, signal });
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
        'Create an HTML artifact or canvas, update its title/content in place, link/unlink a local file or folder, remove a card, or choose what the wall shows. Updates keep marks and state. Read feedback before updating. Create needs title and source; update needs title and/or non-canvas source. Link needs source {link,entry?}. A linked card refuses content updates until unlinked. Name the card in your terminal after creating it. show with grid:true shows the grid, not a card.',
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'link', 'unlink', 'remove', 'show']),
        card: z.string().optional().describe('Existing card id, or optional chosen id when creating (1–64 letters, digits, _ or -).'),
        title: z.string().optional(),
        source: source.optional().describe('Exactly one source. Relative disk paths use your working folder; entry stays relative to its folder. Canvas is only for create.'),
        grid: z.boolean().optional().describe('For show: true selects the card grid; do not combine with card.'),
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
      const content = args.source && !('canvas' in args.source) ? { load: args.source } : undefined;
      if (args.action === 'create') {
        if (!args.title?.trim() || !args.source) return officeError('Create needs a nonempty title and a source: html, file, dir, image, link or canvas.');
        const result = apply(caller, [{ op: 'card.create', card, title: args.title.trim(), kind: 'canvas' in args.source ? 'canvas' : 'html', ...(content ? { content } : {}) }], { card });
        if (!result.isError) {
          const created = await readBoard(caller.floor.whiteboard, caller.worker.id, caller.floor, { cards: [card] });
          const details = created.cards[0];
          const warnings = [...(details?.content?.missing ?? []).map((missing) => `Not collected: ${missing.ref} (${missing.reason})`), ...(details?.link?.status === 'broken' ? [`The link is broken: ${details.link.reason}`] : [])];
          if (warnings.length) result.content.push({ type: 'text', text: printable(warnings.join('\n')) });
        }
        return result;
      }
      if (args.action === 'update') {
        if (args.source && ('canvas' in args.source || 'link' in args.source)) return officeError('Update takes HTML, file, dir or image. Use link to link a source; canvas is only for create.');
        const ops: Record<string, unknown>[] = [];
        if (args.title !== undefined) ops.push({ op: 'card.title', card, title: args.title.trim() });
        if (content) ops.push({ op: 'card.content', card, content });
        return ops.length ? apply(caller, ops, { card }) : officeError('Update needs a title or source.');
      }
      if (args.action === 'link') {
        if (!args.source || !('link' in args.source)) return officeError('Link needs source: {link: "file-or-folder", entry?: "index.html"}.');
        return apply(caller, [{ op: 'card.linkTo', card, path: args.source.link, ...(args.source.entry === undefined ? {} : { entry: args.source.entry }) }], { card });
      }
      return apply(caller, [{ op: args.action === 'remove' ? 'card.rm' : 'card.unlink', card }], { card });
    },
  );
  server.tool(
    {
      name: 'whiteboard_state',
      description:
        'Get, set, merge or delete a card state path. Omitted path is the root object. Paths are dotted (fields.email, actions.approve). Merge recursively writes given leaves, replacing arrays whole. Independent leaf writes do not collide; the same leaf is last-writer-wins. Reading state alone does not mark the card feedback read.',
      inputSchema: z.object({ card: z.string(), op: z.enum(['get', 'set', 'merge', 'del']), path: z.string().optional(), value: z.json().optional().describe('JSON value for set/merge. Root set and any merge require an object.') }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    async (args, caller) => {
      const path = dotted(args.path);
      if (args.op === 'get') {
        const out = await readBoard(caller.floor.whiteboard, caller.worker.id, caller.floor, { cards: [args.card] });
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
      description:
        'Add or change a comment thread, sticky or picture. Read before changing feedback. Comments support add/reply/edit/resolve/reopen/reattach/remove; sticky supports add/edit/move/reattach/remove; picture supports add/file/move/reattach/remove. Add generates and returns an id; other operations need id. Comment text uses text, and edit needs message (message id); remove with message removes just that message. Anchors prefer stable data-wb-id (on), else selector/quote, else at. Coordinates and box sizes are canonical pixels at 1280px wide. Missing elements detach marks until reattached.',
      inputSchema: z.object({
        card: z.string(),
        kind: z.enum(['comment', 'sticky', 'picture']),
        op: z.enum(['add', 'reply', 'edit', 'resolve', 'reopen', 'move', 'file', 'reattach', 'remove']),
        id: z.string().optional().describe('Thread, sticky or picture id; returned by add.'),
        message: z.string().optional().describe('Comment message id for edit, or for removing one message rather than its thread.'),
        text: z.string().optional().describe('Comment/reply/new message text, or sticky text.'),
        anchor: anchor.optional().describe('on is a data-wb-id; selector may include a text quote; at is fallback page position (default 40,40); offset is from element top-left.'),
        box: box.optional().describe('Position x,y and/or size w,h for move; optional size for add.'),
        color: z.enum(['yellow', 'pink', 'blue', 'green', 'purple', 'orange']).optional(),
        file: z.string().optional().describe('Local picture path for picture add/file, relative to your working folder; PNG/JPEG/GIF/WebP.'),
      }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    (args, caller) => {
      const allowed = { comment: ['add', 'reply', 'edit', 'resolve', 'reopen', 'reattach', 'remove'], sticky: ['add', 'edit', 'move', 'reattach', 'remove'], picture: ['add', 'file', 'move', 'reattach', 'remove'] };
      if (!allowed[args.kind].includes(args.op)) return officeError(`${args.kind} supports ${allowed[args.kind].join(', ')}.`);
      if (args.op !== 'add' && !args.id) return officeError('Give the existing mark id. Read the card to find it.');
      if (args.op === 'reattach' && !args.anchor) return officeError('Reattach needs an anchor: on, selector or at.');
      if (args.op === 'move' && !Object.keys(args.box ?? {}).length && !(args.anchor && 'at' in args.anchor)) return officeError('Move needs a box position/size or anchor.at.');
      if (args.kind === 'comment' && ['add', 'reply', 'edit'].includes(args.op) && !args.text?.trim()) return officeError('Give nonempty text for the comment.');
      if (args.kind === 'comment' && args.op === 'edit' && !args.message) return officeError('Editing a comment needs its message id.');
      if (args.kind === 'picture' && ['add', 'file'].includes(args.op) && !args.file) return officeError('Give the local picture file path.');
      const id = args.op === 'add' ? newId({ comment: 't', sticky: 's', picture: 'p' }[args.kind]) : args.id!;
      const op: Record<string, unknown> = { op: `${args.kind}.${args.op === 'remove' ? 'rm' : args.op}`, card: args.card, ...(args.kind === 'comment' ? { thread: id } : { id }) };
      if (args.text !== undefined) op.text = args.text;
      if (args.color !== undefined) op.color = args.color;
      if (args.op === 'add' || args.op === 'reattach') op.anchor = anchorOf(args.anchor);
      if (args.box !== undefined) op.box = args.box;
      if (args.op === 'move' && args.anchor && 'at' in args.anchor && args.anchor.at) op.box = { ...args.box, ...args.anchor.at };
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
Content: {load:{html}|{file}|{dir,entry?}|{image}|{link,entry?}}. Picture file: {load:"path"}. Disk inputs resolve against your working folder, package entries stay inside their folder. Batch anchors use the stored form {kind:"point",point:{x,y}} or {kind:"element",wbId?,selector?,quote?,offset?:{x,y},point:{x,y}}, not whiteboard_marks shorthand. Read feedback before changes; prefer the focused tools for ordinary work.`,
      inputSchema: z.object({ ops: z.array(z.record(z.string(), z.unknown())).describe('Operations in order. Any invalid operation or file load rejects the whole batch, leaving the board unchanged.') }),
      annotations: { openWorldHint: false },
    },
    officeAccess.worker,
    (args, caller) => apply(caller, args.ops),
  );
}
