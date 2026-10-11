#!/usr/bin/env node
// office-whiteboard: the floor's Whiteboard for an agent working in Droid Office (docs/whiteboard.md).
// The office writes this onto every worker's PATH; it talks to the office's loopback hook server
// (src/server/whiteboard-agent.ts) as the worker whose terminal it runs in. Every command is a
// shortcut for one batch of operations sent with `apply`. Plain Node, no dependencies.

import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-whiteboard whoami
  office-whiteboard read [<card>…] [--png <dir>]
  office-whiteboard push --title "…" [--file f | --dir d [--entry e] | --link f | --image f | --canvas] [<<'EOF' html EOF]
  office-whiteboard update <card> [--file f | --dir d [--entry e] | --title "…"] [<<'EOF' html EOF]
  office-whiteboard link <card> <file or folder> [--entry e]
  office-whiteboard unlink <card>
  office-whiteboard rm <card>
  office-whiteboard state <card> [get [<path>] | set [<path>] <json> | merge [<path>] <json> | del <path>]
  office-whiteboard comment <card> add [anchor] [--text "…"] | reply <thread> | edit <thread> <message> | resolve <thread> | reopen <thread> | rm <thread> [<message>] | reattach <thread> [anchor]
  office-whiteboard sticky <card> add [anchor] [--color c] [--size w,h] [--text "…"] | edit <id> [--text "…"] [--color c] | move <id> [--at x,y] [--size w,h] | reattach <id> [anchor] | rm <id>
  office-whiteboard picture <card> add <image> [anchor] [--size w,h] | file <id> <image> | move <id> [--at x,y] [--size w,h] | reattach <id> [anchor] | rm <id>
  office-whiteboard show [<card> | --grid]
  office-whiteboard apply <<'EOF' [ops…] EOF
  office-whiteboard help

  anchor: --on <data-wb-id> | --selector <css> [--quote "…"] [--offset x,y], and --at x,y (the point on the page)
  Every command takes --json for exact structures. Text for comments and stickies comes from --text or stdin.
  office-whiteboard help shows the whole guide.`;

const GUIDE = `office-whiteboard: the Whiteboard on your floor of Droid Office.

The Whiteboard is a wall of cards that the owner and every worker on this floor share. A card is an
HTML page (an artifact) or an empty canvas. The owner opens a card in a sandboxed frame, uses it
(buttons, forms) and marks it up with comment threads, stickies and pictures. You read all of it back
here, and change anything on it.

READING
  office-whiteboard read                 the whole board as you see it
  office-whiteboard read c-1a2b c-3c4d   just these cards, with each one's HTML printed in full
  office-whiteboard read --json          exact structures (every field below)
  office-whiteboard read c-1a2b --png out/   also writes a PNG of each card, marks drawn on top

  A read shows each card's title, author, link, files (with where each is on disk, to open read-only),
  state, comment threads, stickies and pictures. Pieces marked CHANGED were changed by someone else
  (usually the owner) since you last read that card; removals show too. After a read has printed
  everything (and written every PNG), your read point moves to that read's revision for the cards it
  returned, and only those: reading one card never hides news on another. A read that fails moves
  nothing, and a card whose PNG couldn't be made keeps its read point. Renders may be unavailable in
  this office: the read says so, with the reason and the age of the last image, never a stale image.

MAKING AND CHANGING CARDS
  push --title "Plan" <<'EOF'            a card from HTML on stdin; prints its id
  push --title "Plan" --file plan.html   from a file, with the local files it references (images,
                                         stylesheets, scripts, fonts, url() in CSS) as its assets
  push --title "App" --dir site/ [--entry index.html]
                                         a whole folder, for pages that load files at run time
                                         (ES module imports, fetch('./data.json'))
  push --title "Plan" --link plan.html   linked: the card follows the file (or folder) as it changes
  push --title "Screenshot" --image shot.png
  push --title "Sketch" --canvas         an empty canvas for stickies and pictures
  update <card> --file plan.html | --dir site/ | --title "New title" | <<'EOF' html EOF
                                         replaces the card's content (or title) in place; comments
                                         and stickies stay and re-attach to their elements
  link <card> <file or folder>           links an existing card; unlink <card> keeps its content
                                         and stops following the file
  rm <card>                              deletes a card

  Assets keep their relative paths and the card is served from its folder, so the HTML needs no
  rewriting. Remote URLs stay as they are. A reference that can't be collected (outside the folder,
  too large, missing) is listed. A linked card refuses an update of its content until you unlink it:
  edit the file instead. If a linked file disappears, the card keeps its last content and its link
  shows broken; it recovers when the file is back.

STATE
  Every card has a JSON state object: the owner's form answers (state.fields, by each field's name
  or id), button presses (state.actions.<name> = { name, data, at }) and anything the page's script
  keeps there. Paths are dotted: fields.email.
  state <card>                           the whole state;  state <card> get fields.email
  state <card> set '{"a":1}'             replaces the whole state
  state <card> set fields.email '"x@y.z"'   sets one value (JSON)
  state <card> merge '{"fields":{"name":"Ada"}}'   sets each leaf it's given, recursing into objects,
                                         replacing arrays whole
  state <card> del fields.email          removes a path
  Each leaf has its own stamp: two writers to different leaves never collide; the same leaf is last
  writer wins. Give "-" as the JSON to read it from stdin.

MARKS
  Anchors attach a mark to the page:
    --on <id>          the element with data-wb-id="<id>" (best: survives rewrites)
    --selector <css>   an element by CSS selector, with --quote "…" (some of its text) to find it
                       again after the page changes
    --offset x,y       from that element's top-left;   --at x,y   the point on the page (canonical
                       px at 1280 wide) the mark falls back to, and the only anchor on a canvas
  comment <card> add --on option-a --text "Why this one?"     prints the thread id
  comment <card> reply <thread> --text "…"; edit <thread> <message> --text "…"
  comment <card> resolve <thread>; reopen <thread>; rm <thread> [<message>]; reattach <thread> --on …
  sticky <card> add --at 40,60 [--color yellow|pink|blue|green|purple|orange] [--size 200,160] --text "…"
  sticky <card> edit <id> --text "…" [--color …]; move <id> --at x,y [--size w,h]; reattach; rm
  picture <card> add shot.png --at 0,0 [--size w,h]; file <id> new.png; move; reattach; rm
  A mark whose element can't be found any more shows as detached until it is reattached.

THE WALL
  show <card>    the wall shows that card;   show --grid   the wall shows the grid of cards

APPLY: ANY OPERATIONS, ALL OR NOTHING
  office-whiteboard apply <<'EOF'
  [ { "op": "card.create", "card": "c-plan", "kind": "html", "title": "Plan",
      "content": { "load": { "file": "docs/plan.html" } } },
    { "op": "comment.add", "card": "c-plan", "thread": "t-1", "message": "m-1",
      "anchor": { "kind": "element", "wbId": "step-2", "point": { "x": 0, "y": 0 } },
      "text": "Start here" } ]
  EOF
  Ids for new cards and marks are yours to choose: 1-64 letters, digits, _ or -. The batch is applied
  in full or not at all; a failure says which operation and why, and changes nothing.
  Operations: card.create { card, kind: html|canvas, title, content? }, card.title { card, title },
  card.content { card, content }, card.rm { card }, card.linkTo { card, path, dir?, entry? },
  card.unlink { card }, card.view { card, view: {x,y,w,h} | null },
  state.set { card, path: [keys], value }, state.merge { card, path, value: {…} }, state.del { card, path },
  state.action { card, name, data? },
  comment.add { card, thread, message, anchor, text }, comment.reply { card, thread, message, text },
  comment.edit { card, thread, message, text }, comment.resolve|comment.reopen { card, thread },
  comment.reattach { card, thread, anchor }, comment.rm { card, thread, message? },
  sticky.add { card, id, anchor, box?, text?, color? }, sticky.edit { card, id, text?, color? },
  sticky.move { card, id, box }, sticky.reattach { card, id, anchor }, sticky.rm { card, id },
  picture.add { card, id, file, anchor, box? }, picture.file { card, id, file },
  picture.move { card, id, box }, picture.reattach { card, id, anchor }, picture.rm { card, id },
  show { selection: { kind: "grid" } | { kind: "card", id } }, read { cards, rev }.
  Content and files come from this machine: content is { "load": { "html": "…" } | { "file": f } |
  { "dir": d, "entry"?: e } | { "image": f } | { "link": f, "entry"?: e } } (link: a new card that
  follows the file or folder), and a picture's file is { "load": "shot.png" }.
  Relative paths are from the current folder.

THE ARTIFACT JAVASCRIPT API
  The office injects window.whiteboard into every card's page:
    whiteboard.state.get(path?)          a copy of the state, or the value at a path ("a.b" or ["a","b"])
    whiteboard.state.set(value)          replaces the whole state;  set(path, value) sets one value
    whiteboard.state.merge(obj)          merges leaves;  merge(path, obj) under a path
    whiteboard.state.del(path)           removes a path
    whiteboard.on('state', fn)           fn(state, changes) when the owner or an agent changes it
    whiteboard.on('ready', fn), whiteboard.ready   once the state has arrived
    whiteboard.on('mode', fn), whiteboard.mode     'use', or 'markup' while the owner marks up
    whiteboard.action(name, data?)       records the press in state.actions[name] = { name, data, at }
    whiteboard.card                      { id, title, author }
    whiteboard.rendering                 true when the renderer loaded the page: writes are dropped,
                                         so skip side effects (analytics, one-time network calls)
  With no script at all: form fields with a name or id are saved into state.fields and restored on
  load; <button data-wb-action="approve" data-wb-data='{"option":"a"}'> records a press; a form's
  submit records the "submit" action. Typing is never overwritten mid-edit.

GOOD ARTIFACTS
  - Put data-wb-id on the elements people will comment on (sections, options, steps).
  - Lay the page out for 1280 px wide; it can be as tall as it needs.
  - Never put secrets in an artifact: it has network access.
  - The page runs sandboxed on an opaque origin: no cookies, no localStorage the office can see, no
    access to other cards. Keep what it needs in its state.

Output is short text; --json prints exact structures. Exit codes: 0 done, 1 the office refused or
failed (the message says why and what to do), 2 a mistake in the command.`;

/** A mistake in how the command was called: the usage is shown with it. */
export class UsageError extends Error {}

const ENV = ['DROID_OFFICE_HOOK_URL', 'DROID_OFFICE_WORKER_ID', 'DROID_OFFICE_HOOK_TOKEN'];
/** How long a request is retried while the office can't be reached (restarting, or gone mid-answer). */
const RETRY_MS = 15_000;
const TIMEOUT_MS = 150_000;
const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];

const ANCHOR = { '--on': true, '--selector': true, '--quote': true, '--offset': true, '--at': true };
const OPTIONS = {
  whoami: {},
  read: { '--png': true },
  push: { '--title': true, '--file': true, '--dir': true, '--entry': true, '--link': true, '--image': true, '--canvas': false },
  update: { '--title': true, '--file': true, '--dir': true, '--entry': true },
  link: { '--entry': true },
  unlink: {},
  rm: {},
  state: {},
  comment: { ...ANCHOR, '--text': true },
  sticky: { ...ANCHOR, '--text': true, '--color': true, '--size': true },
  picture: { ...ANCHOR, '--size': true },
  show: { '--grid': false },
  apply: {},
};
const ALIASES = { who: 'whoami', ls: 'read', new: 'push', add: 'push', delete: 'rm', remove: 'rm', ops: 'apply' };

/**
 * What the command line asks for: { cmd, args, opts }, or { cmd: 'help' }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (first === undefined || first === 'help' || help(first) || rest.some(help)) return { cmd: 'help', full: first === undefined || first === 'help' || help(first) };
  const cmd = ALIASES[first] ?? first;
  const allowed = OPTIONS[cmd];
  if (!allowed) throw new UsageError(`Unknown command: ${first}`);
  /** @type {string[]} */
  const args = [];
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--') || arg === '--') {
      if (arg === '--') args.push(...rest.slice(i + 1));
      else args.push(arg);
      if (arg === '--') break;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === '--json') {
      opts['--json'] = true;
      continue;
    }
    if (!(flag in allowed)) throw new UsageError(`Unknown option for ${cmd}: ${flag}`);
    if (!allowed[flag]) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      opts[flag] = true;
      continue;
    }
    if (eq > 0) opts[flag] = arg.slice(eq + 1);
    else if (i + 1 < rest.length) opts[flag] = rest[++i];
    else throw new UsageError(`${flag} needs a value`);
  }
  const sources = ['--file', '--dir', '--link', '--image', '--canvas'].filter((f) => opts[f] !== undefined);
  if (sources.length > 1) throw new UsageError(`Pick one of ${sources.join(', ')}`);
  if (opts['--entry'] !== undefined && opts['--dir'] === undefined && cmd !== 'link' && opts['--link'] === undefined) throw new UsageError('--entry is the page of a --dir folder');
  if (typeof opts['--color'] === 'string' && !COLORS.includes(opts['--color'])) throw new UsageError(`--color is one of ${COLORS.join(', ')} (got ${opts['--color']})`);
  return { cmd, args, opts };
}

/**
 * The office's address and this agent's id and token, from the environment.
 * @param {Record<string, string | undefined>} env
 */
export function officeEnv(env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-whiteboard only works inside Droid Office, from the terminal of one of its agents.`);
  }
  return { url: env.DROID_OFFICE_HOOK_URL.replace(/\/+$/, ''), worker: env.DROID_OFFICE_WORKER_ID, token: env.DROID_OFFICE_HOOK_TOKEN };
}

/** A fresh id for a card or a mark: `c-…`, `t-…`. */
export function newId(prefix) {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

/** "x,y" as numbers. */
function pair(v, flag) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,x×]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(v));
  if (!m) throw new UsageError(`${flag} takes two numbers, like ${flag} 120,80 (got ${v})`);
  return [Number(m[1]), Number(m[2])];
}

/** The anchor the options describe: an element (--on, --selector) or a point (--at). */
export function anchorOf(opts) {
  const [x, y] = opts['--at'] !== undefined ? pair(opts['--at'], '--at') : [40, 40];
  const point = { x, y };
  if (opts['--on'] === undefined && opts['--selector'] === undefined) {
    if (opts['--quote'] !== undefined || opts['--offset'] !== undefined) throw new UsageError('--quote and --offset go with --on or --selector');
    return { kind: 'point', point };
  }
  const [ox, oy] = opts['--offset'] !== undefined ? pair(opts['--offset'], '--offset') : [0, 0];
  return {
    kind: 'element',
    ...(typeof opts['--on'] === 'string' ? { wbId: opts['--on'] } : {}),
    ...(typeof opts['--selector'] === 'string' ? { selector: opts['--selector'] } : {}),
    ...(typeof opts['--quote'] === 'string' ? { quote: opts['--quote'] } : {}),
    offset: { x: ox, y: oy },
    point,
  };
}

const hasAnchor = (opts) => ['--on', '--selector', '--at', '--quote', '--offset'].some((f) => opts[f] !== undefined);

/** A box from --at and --size; only what's given. */
function boxOf(opts) {
  const box = {};
  if (opts['--at'] !== undefined) [box.x, box.y] = pair(opts['--at'], '--at');
  if (opts['--size'] !== undefined) [box.w, box.h] = pair(opts['--size'], '--size');
  return box;
}

/** A dotted state path as a key list: '' is the root. */
export function statePath(s) {
  return s === undefined || s === '' || s === '.' ? [] : String(s).split('.');
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} must be JSON (${e.message}). Quote strings: '"text"'`);
  }
}

/**
 * Relative paths in `{ load }` contents, pictures and links become absolute, from `cwd`: the office
 * reads them, and it runs somewhere else.
 */
export function resolvePaths(ops, cwd) {
  if (!Array.isArray(ops)) return ops;
  const abs = (p) => (typeof p === 'string' ? path.resolve(cwd, p) : p);
  return ops.map((o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    const op = { ...o };
    if (op.content && typeof op.content === 'object' && op.content.load && typeof op.content.load === 'object') {
      const l = { ...op.content.load };
      for (const k of ['file', 'dir', 'image', 'link']) if (k in l) l[k] = abs(l[k]);
      op.content = { ...op.content, load: l };
    }
    if (op.file && typeof op.file === 'object' && typeof op.file.load === 'string') op.file = { ...op.file, load: abs(op.file.load) };
    if (op.op === 'card.linkTo') op.path = abs(op.path);
    return op;
  });
}

/**
 * What a parsed command does: `ops` to apply (and `card`/`id` it made), or a read (`read`), or the
 * state to print (`state`). `text` is what came in on stdin, for a command that takes some.
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {() => Promise<string>} stdin
 * @param {string} cwd
 */
export async function plan(cmd, stdin, cwd) {
  const o = cmd.opts;
  const a = cmd.args;
  const abs = (p) => path.resolve(cwd, p);
  const textOf = async (flag, what) => {
    const t = typeof o[flag] === 'string' ? o[flag] : await stdin();
    const clean = t.replace(/\r\n?/g, '\n').trim();
    if (!clean) throw new UsageError(`Give the ${what} with ${flag} "…" or on stdin (<<'EOF' … EOF)`);
    return clean;
  };
  const need = (n, what) => {
    if (a.length < n) throw new UsageError(`${cmd.cmd} needs ${what}`);
  };
  const most = (n) => {
    if (a.length > n) throw new UsageError(`Unexpected argument: ${a[n]}`);
  };
  const contentOf = async () => {
    if (typeof o['--file'] === 'string') return { load: { file: abs(o['--file']) } };
    if (typeof o['--dir'] === 'string') return { load: { dir: abs(o['--dir']), ...(typeof o['--entry'] === 'string' ? { entry: o['--entry'] } : {}) } };
    if (typeof o['--image'] === 'string') return { load: { image: abs(o['--image']) } };
    const html = await stdin();
    if (!html.trim()) return undefined;
    return { load: { html } };
  };
  switch (cmd.cmd) {
    case 'whoami':
      most(0);
      return { hello: true };
    case 'read':
      return { read: { cards: a.length ? a : undefined, png: typeof o['--png'] === 'string' ? abs(o['--png']) : undefined } };
    case 'push': {
      most(0);
      const title = typeof o['--title'] === 'string' ? o['--title'].trim() : '';
      if (!title) throw new UsageError('A card needs a --title');
      const card = newId('c');
      if (o['--canvas']) return { card, ops: [{ op: 'card.create', card, kind: 'canvas', title }] };
      if (typeof o['--link'] === 'string') {
        return { card, ops: [{ op: 'card.create', card, kind: 'html', title, content: { load: { link: abs(o['--link']), ...(typeof o['--entry'] === 'string' ? { entry: o['--entry'] } : {}) } } }] };
      }
      const content = await contentOf();
      if (!content) throw new UsageError(`Give the card's HTML on stdin, or --file, --dir, --link, --image or --canvas`);
      return { card, ops: [{ op: 'card.create', card, kind: 'html', title, content }] };
    }
    case 'update': {
      need(1, 'the card id');
      most(1);
      const card = a[0];
      const ops = [];
      if (typeof o['--title'] === 'string') ops.push({ op: 'card.title', card, title: o['--title'].trim() });
      const content = o['--title'] !== undefined && o['--file'] === undefined && o['--dir'] === undefined ? undefined : await contentOf();
      if (content) ops.push({ op: 'card.content', card, content });
      if (!ops.length) throw new UsageError(`Give the new HTML on stdin, or --file, --dir or --title`);
      return { card, ops };
    }
    case 'link':
      need(2, 'the card id and the file or folder to link');
      most(2);
      return { card: a[0], ops: [{ op: 'card.linkTo', card: a[0], path: abs(a[1]), ...(typeof o['--entry'] === 'string' ? { entry: o['--entry'] } : {}) }] };
    case 'unlink':
      need(1, 'the card id');
      most(1);
      return { card: a[0], ops: [{ op: 'card.unlink', card: a[0] }] };
    case 'rm':
      need(1, 'the card id');
      return { ops: a.map((card) => ({ op: 'card.rm', card })) };
    case 'show':
      most(1);
      if (o['--grid'] && a.length) throw new UsageError('Pick a card or --grid');
      return { ops: [{ op: 'show', selection: a.length ? { kind: 'card', id: a[0] } : { kind: 'grid' } }] };
    case 'state': {
      need(1, 'the card id');
      const [card, verb = 'get', ...more] = a;
      const json = async (s) => parseJson(s === '-' ? await stdin() : s, 'The value');
      if (verb === 'get') {
        if (more.length > 1) throw new UsageError(`Unexpected argument: ${more[1]}`);
        return { state: { card, path: statePath(more[0]) } };
      }
      if (verb === 'set' || verb === 'merge') {
        if (!more.length || more.length > 2) throw new UsageError(`state ${card} ${verb} [<path>] <json>`);
        const p = more.length === 2 ? statePath(more[0]) : [];
        const value = await json(more[more.length - 1]);
        if (verb === 'merge' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new UsageError('merge takes a JSON object');
        if (verb === 'set' && !p.length && (!value || typeof value !== 'object' || Array.isArray(value))) throw new UsageError('The whole state is an object; give a path to set one value (state <card> set fields.email \'"x@y.z"\')');
        return { card, ops: [{ op: `state.${verb}`, card, path: p, value }] };
      }
      if (verb === 'del') {
        if (more.length !== 1) throw new UsageError(`state ${card} del <path>`);
        return { card, ops: [{ op: 'state.del', card, path: statePath(more[0]) }] };
      }
      throw new UsageError(`state ${card} get, set, merge or del (got ${verb})`);
    }
    case 'comment': {
      need(2, 'the card id and what to do: add, reply, edit, resolve, reopen, rm or reattach');
      const [card, verb, ...more] = a;
      const thread = more[0];
      const needThread = () => {
        if (!thread) throw new UsageError(`comment ${card} ${verb} needs the thread id`);
      };
      switch (verb) {
        case 'add': {
          if (more.length) throw new UsageError(`Unexpected argument: ${more[0]} (give the text with --text or on stdin)`);
          const id = newId('t');
          return { card, id, ops: [{ op: 'comment.add', card, thread: id, message: newId('m'), anchor: anchorOf(o), text: await textOf('--text', 'comment') }] };
        }
        case 'reply':
          needThread();
          return { card, id: thread, ops: [{ op: 'comment.reply', card, thread, message: newId('m'), text: await textOf('--text', 'reply') }] };
        case 'edit':
          if (more.length < 2) throw new UsageError(`comment ${card} edit <thread> <message>`);
          return { card, id: thread, ops: [{ op: 'comment.edit', card, thread, message: more[1], text: await textOf('--text', 'new text') }] };
        case 'resolve':
        case 'reopen':
          needThread();
          return { card, id: thread, ops: [{ op: `comment.${verb}`, card, thread }] };
        case 'rm':
          needThread();
          return { card, id: thread, ops: [{ op: 'comment.rm', card, thread, ...(more[1] ? { message: more[1] } : {}) }] };
        case 'reattach':
          needThread();
          if (!hasAnchor(o)) throw new UsageError('Say where: --on, --selector or --at');
          return { card, id: thread, ops: [{ op: 'comment.reattach', card, thread, anchor: anchorOf(o) }] };
        default:
          throw new UsageError(`comment ${card} add, reply, edit, resolve, reopen, rm or reattach (got ${verb})`);
      }
    }
    case 'sticky': {
      need(2, 'the card id and what to do: add, edit, move, reattach or rm');
      const [card, verb, id] = a;
      const needId = () => {
        if (!id) throw new UsageError(`sticky ${card} ${verb} needs the sticky's id`);
      };
      switch (verb) {
        case 'add': {
          const sid = newId('s');
          const box = o['--size'] !== undefined ? boxOf({ '--size': o['--size'] }) : undefined;
          const text = typeof o['--text'] === 'string' ? o['--text'] : (await stdin()).trim();
          return { card, id: sid, ops: [{ op: 'sticky.add', card, id: sid, anchor: anchorOf(o), ...(box ? { box } : {}), ...(text ? { text } : {}), ...(typeof o['--color'] === 'string' ? { color: o['--color'] } : {}) }] };
        }
        case 'edit': {
          needId();
          const text = typeof o['--text'] === 'string' ? o['--text'] : o['--color'] === undefined ? await textOf('--text', "sticky's text") : undefined;
          return { card, id, ops: [{ op: 'sticky.edit', card, id, ...(text !== undefined ? { text } : {}), ...(typeof o['--color'] === 'string' ? { color: o['--color'] } : {}) }] };
        }
        case 'move': {
          needId();
          const box = boxOf(o);
          if (!Object.keys(box).length) throw new UsageError('Say where with --at x,y and/or --size w,h');
          return { card, id, ops: [{ op: 'sticky.move', card, id, box }] };
        }
        case 'reattach':
          needId();
          if (!hasAnchor(o)) throw new UsageError('Say where: --on, --selector or --at');
          return { card, id, ops: [{ op: 'sticky.reattach', card, id, anchor: anchorOf(o) }] };
        case 'rm':
          needId();
          return { card, id, ops: [{ op: 'sticky.rm', card, id }] };
        default:
          throw new UsageError(`sticky ${card} add, edit, move, reattach or rm (got ${verb})`);
      }
    }
    case 'picture': {
      need(2, 'the card id and what to do: add, file, move, reattach or rm');
      const [card, verb, x, y] = a;
      switch (verb) {
        case 'add': {
          if (!x) throw new UsageError(`picture ${card} add <image>`);
          const pid = newId('p');
          const box = o['--size'] !== undefined ? boxOf({ '--size': o['--size'] }) : {};
          return { card, id: pid, ops: [{ op: 'picture.add', card, id: pid, file: { load: abs(x) }, anchor: anchorOf(o), box }] };
        }
        case 'file':
          if (!x || !y) throw new UsageError(`picture ${card} file <id> <image>`);
          return { card, id: x, ops: [{ op: 'picture.file', card, id: x, file: { load: abs(y) } }] };
        case 'move': {
          if (!x) throw new UsageError(`picture ${card} move <id> --at x,y`);
          const box = boxOf(o);
          if (!Object.keys(box).length) throw new UsageError('Say where with --at x,y and/or --size w,h');
          return { card, id: x, ops: [{ op: 'picture.move', card, id: x, box }] };
        }
        case 'reattach':
          if (!x) throw new UsageError(`picture ${card} reattach <id> --on …`);
          if (!hasAnchor(o)) throw new UsageError('Say where: --on, --selector or --at');
          return { card, id: x, ops: [{ op: 'picture.reattach', card, id: x, anchor: anchorOf(o) }] };
        case 'rm':
          if (!x) throw new UsageError(`picture ${card} rm <id>`);
          return { card, id: x, ops: [{ op: 'picture.rm', card, id: x }] };
        default:
          throw new UsageError(`picture ${card} add, file, move, reattach or rm (got ${verb})`);
      }
    }
    case 'apply': {
      most(0);
      const text = await stdin();
      if (!text.trim()) throw new UsageError(`Give the operations as JSON on stdin (office-whiteboard apply <<'EOF' [ … ] EOF)`);
      const parsed = parseJson(text, 'The operations');
      const ops = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.ops) ? parsed.ops : undefined;
      if (!ops) throw new UsageError('Give a JSON list of operations, or { "ops": [ … ] }');
      return { ops: resolvePaths(ops, cwd) };
    }
    default:
      throw new Error(`Nothing to do for ${cmd.cmd}`);
  }
}

// ---- Text output ----

/** e.g. "3m ago" */
export function ago(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const who = (a) => (a?.kind === 'worker' ? a.name : 'the owner');
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const quote = (s, max = 80) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
};
const indent = (text, by) =>
  text
    .split('\n')
    .map((l) => by + l)
    .join('\n');

export function anchorText(a) {
  if (!a) return '';
  if (a.kind === 'point') return `at ${a.point.x},${a.point.y}`;
  const el = a.wbId ? `[data-wb-id="${a.wbId}"]` : a.selector;
  return `on ${el}${a.quote ? ` ${quote(a.quote, 40)}` : ''}${a.offset && (a.offset.x || a.offset.y) ? ` +${a.offset.x},${a.offset.y}` : ''}`;
}

/** One changed piece, in words. */
export function pieceText(p) {
  switch (p.kind) {
    case 'title':
      return 'the title';
    case 'content':
      return 'the content';
    case 'state':
      return `state ${p.path.join('.') || '(root)'}`;
    case 'thread':
      return `comment thread ${p.id} (${p.field === 'resolved' ? 'resolved or reopened' : 'moved'})`;
    case 'message':
      return `comment ${p.thread}/${p.id}`;
    case 'sticky':
      return `sticky ${p.id} ${p.field}`;
    case 'picture':
      return `picture ${p.id} ${p.field}`;
    default:
      return p.kind;
  }
}

/** A card's changed pieces in words, one entry per mark with its changed fields together. */
export function changesText(changes) {
  const groups = new Map();
  for (const p of changes) {
    const key = p.kind === 'thread' || p.kind === 'sticky' || p.kind === 'picture' ? `${p.kind} ${p.id}` : p.kind === 'state' ? 'state' : pieceText(p);
    const g = groups.get(key) ?? [];
    if (p.kind === 'thread') g.push(p.field === 'resolved' ? 'open or resolved' : 'place');
    else if (p.kind === 'sticky' || p.kind === 'picture') g.push(p.field === 'box' ? 'position or size' : p.field === 'anchor' ? 'place' : p.field);
    else if (p.kind === 'state') g.push(p.path.join('.') || '(root)');
    groups.set(key, g);
  }
  return [...groups].map(([key, fields]) => (key === 'state' ? `state ${fields.join(', ')}` : fields.length ? `${key.replace(/^thread /, 'comment thread ')} (${fields.join(', ')})` : key));
}

export function removedText(t, now) {
  const what = t.kind === 'state' ? `state ${JSON.parse(t.id).join('.')}` : t.kind === 'message' ? `comment ${t.parent}/${t.id}` : `${t.kind} ${t.id}`;
  return `${what} removed by ${who(t.author)} ${ago(t.at, now)}`;
}

const isPiece = (changes, test) => changes.some(test);

/** A card of a read, in words. `full` prints its HTML. */
export function formatCard(c, { now, full, pngs }) {
  const lines = [];
  const mark = (yes) => (yes ? '  ← CHANGED' : '');
  const ch = c.changes ?? [];
  lines.push(`${c.changed ? '●' : '○'} ${c.id} ${quote(c.title)} (${c.kind}, by ${who(c.author)}, updated ${ago(c.updatedAt, now)})${c.changed ? ' — CHANGED' : ''}`);
  if (c.changed) {
    const what = [...changesText(ch), ...(c.removed ?? []).map((t) => removedText(t, now))];
    lines.push(`  Changed for you: ${what.join('; ')}`);
  }
  if (c.link) lines.push(`  Linked to ${c.link.path}${c.link.dir ? ' (folder)' : ''}: ${c.link.status === 'ok' ? 'following it' : `BROKEN — ${c.link.reason ?? 'unreadable'}`}`);
  if (c.content) {
    const page = c.content.files[c.content.entry];
    const others = Object.keys(c.content.files).filter((p) => p !== c.content.entry);
    lines.push(`  Page: ${c.content.entry}${page ? ` (${kb(page.size)}) ${page.file}` : ''}`);
    if (others.length) lines.push(`  Files: ${others.join(', ')}`);
    for (const m of c.content.missing ?? []) lines.push(`  Not collected: ${m.ref} (${m.reason})`);
    if (full && c.content.html !== undefined) lines.push('  HTML:', indent(c.content.html.replace(/\s+$/, ''), '    | '));
  }
  const state = JSON.stringify(c.state);
  if (state !== '{}') lines.push(`  State${mark(isPiece(ch, (p) => p.kind === 'state'))}: ${state.length > 2000 && !full ? `${state.slice(0, 2000)}… (read ${c.id} for all of it)` : state}`);
  if (c.threads.length) {
    lines.push('  Comments:');
    for (const t of c.threads) {
      const moved = isPiece(ch, (p) => p.kind === 'thread' && p.id === t.id);
      lines.push(`    ${t.id} ${anchorText(t.anchor)}${t.detached ? ' (detached)' : ''} [${t.resolved ? 'resolved' : 'open'}]${mark(moved)}`);
      for (const m of t.messages)
        lines.push(`      ${m.id} ${who(m.author)}, ${ago(m.at, now)}: ${m.text.includes('\n') ? `\n${indent(m.text, '        ')}` : m.text}${mark(isPiece(ch, (p) => p.kind === 'message' && p.id === m.id && p.thread === t.id))}`);
    }
  }
  for (const s of c.stickies) {
    const changed = ch.filter((p) => p.kind === 'sticky' && p.id === s.id).map((p) => p.field);
    lines.push(
      `  Sticky ${s.id} (${s.color}, ${s.box.w}×${s.box.h} at ${s.box.x},${s.box.y}, anchored ${anchorText(s.anchor)}${s.detached ? ', detached' : ''}): ${quote(s.text, 400)}${changed.length ? `  ← CHANGED (${changed.join(', ')})` : ''}`,
    );
  }
  for (const p of c.pictures) {
    const changed = ch.filter((x) => x.kind === 'picture' && x.id === p.id).map((x) => x.field);
    lines.push(
      `  Picture ${p.id} (${p.file.mime}, ${p.box.w}×${p.box.h} at ${p.box.x},${p.box.y}, anchored ${anchorText(p.anchor)}${p.detached ? ', detached' : ''}): ${p.file.file}${changed.length ? `  ← CHANGED (${changed.join(', ')})` : ''}`,
    );
  }
  const shot = pngs?.get(c.id);
  if (shot) lines.push(`  PNG: ${shot}`);
  else if (c.png && !c.png.ok) lines.push(`  PNG: none — ${c.png.error}${c.png.last ? ` The last image is of revision ${c.png.last.rev}, ${ago(c.png.last.at, now)}.` : ''} Your read point for this card wasn't moved.`);
  return lines.join('\n');
}

export function formatRead(r, { now, full, pngs }) {
  const out = [];
  const sel = r.selection.kind === 'card' ? `card ${r.selection.id}` : 'the grid';
  const changed = r.cards.filter((c) => c.changed).length;
  out.push(`Whiteboard on ${r.floor.name}, revision ${r.rev}. The wall shows ${sel}.`);
  out.push(`${r.cards.length} card${r.cards.length === 1 ? '' : 's'}${changed ? `, ${changed} changed for you` : ''}.${r.renderer.available ? '' : ` Renders: unavailable (${r.renderer.reason ?? 'no renderer'}).`}`);
  for (const c of r.cards) out.push('', formatCard(c, { now, full, pngs }));
  if (r.removed.length) {
    out.push('', 'Removed:');
    for (const t of r.removed) out.push(`  ${t.id} removed by ${who(t.author)} ${ago(t.at, now)}`);
  }
  if (r.unknown.length) out.push('', `No such card: ${r.unknown.join(', ')}`);
  if (!r.cards.length && !r.removed.length && !r.unknown.length) out.push('', 'The board is empty. Push a card with office-whiteboard push --title "…".');
  return out.join('\n');
}

// ---- Talking to the office ----

/** Why the office turned a request down, in words. */
export function refusal(status, body) {
  const said = typeof body?.error === 'string' ? body.error : typeof body?.error?.message === 'string' ? body.error.message : '';
  if (status === 401) return `The office didn't accept this agent's token (401)${said ? `: ${said}` : ''}. Is this the terminal of a Droid Office worker that's still running?`;
  if (status === 409 && body?.reason === 'expired') return said;
  if (status === 422) return said || 'The office refused the change. Nothing was changed.';
  return `The office said no (${status})${said ? `: ${said}` : ''}.`;
}

const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ETIMEDOUT']);

/**
 * Sends a request, retrying while the office can't be reached or drops the connection mid-answer.
 * That's safe for every action: reads change nothing, and a batch retried in its epoch with its
 * sequence number is applied once.
 */
async function send(req, fetchImpl, sleep) {
  const until = Date.now() + RETRY_MS;
  for (;;) {
    try {
      const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text.slice(0, 300) };
      }
      return { status: res.status, body };
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      if (RETRYABLE.has(code) && Date.now() < until) {
        await sleep(1000);
        continue;
      }
      throw new Error(`Couldn't reach the office at ${new URL(req.url).origin} (${code ?? err?.message ?? err}). Is it running?`);
    }
  }
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => (data += c));
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

class Refused extends Error {}

/** Writes a read's PNGs: `<dir>/<card>.png`, or `<card>-1.png`, `<card>-2.png`… for a tall page in tiles. */
function writePngs(r, dir) {
  const written = new Map();
  mkdirSync(dir, { recursive: true });
  for (const c of r.cards) {
    if (!c.png?.ok) continue;
    const files = c.png.tiles.map((_, i) => path.join(dir, c.png.tiles.length === 1 ? `${c.id}.png` : `${c.id}-${i + 1}.png`));
    c.png.tiles.forEach((t, i) => writeFileSync(files[i], Buffer.from(t, 'base64')));
    const fresh = c.png.current ? 'it is the card as it is now' : 'the card has changed since';
    written.set(c.id, `${files.join(', ')} (${c.png.width}×${c.png.height}, revision ${c.png.rev}, rendered ${ago(c.png.at, Date.now())}; ${fresh}${c.png.capped ? `; cut off at ${c.png.capped.capPx}px` : ''})`);
    c.png = { ...c.png, tiles: undefined, files };
  }
  return written;
}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number, cwd?: string }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdinStream = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? fetch;
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  const cwd = io.cwd ?? process.cwd();
  let stdinText;
  const stdin = async () => {
    if (stdinText !== undefined) return stdinText;
    stdinText = stdinStream.isTTY ? '' : await readStdin(stdinStream);
    return stdinText;
  };
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(cmd.full ? GUIDE : USAGE);
      return 0;
    }
    const json = cmd.opts['--json'] === true;
    const office = officeEnv(env);
    const todo = await plan(cmd, stdin, cwd);
    const call = async (body) => {
      const url = new URL(`${office.url}/office/whiteboard`);
      url.searchParams.set('worker', office.worker);
      const res = await send({ method: 'POST', url: url.href, headers: { authorization: `Bearer ${office.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, fetchImpl, sleep);
      if (res.status < 200 || res.status >= 300) throw new Refused(refusal(res.status, res.body));
      return res.body;
    };
    const hello = await call({ action: 'hello' });
    let seq = 0;
    const apply = (ops) => call({ action: 'apply', envelope: { epoch: hello.epoch, seq: ++seq, ops } });

    if (todo.hello) {
      if (json) out(JSON.stringify(hello, null, 2));
      else {
        const r = hello.renderer?.available ? 'Cards render to PNGs.' : (hello.renderer?.reason ?? "Cards don't render to PNGs here.");
        out(`You're ${hello.worker.name} (${hello.worker.id}) on the ${hello.floor.name} floor. Its Whiteboard has ${hello.cards} card${hello.cards === 1 ? '' : 's'} (revision ${hello.rev}). ${r}`);
      }
      return 0;
    }
    if (todo.read) {
      const r = await call({ action: 'read', ...(todo.read.cards ? { cards: todo.read.cards } : {}), ...(todo.read.png ? { png: true } : {}) });
      const pngs = todo.read.png ? writePngs(r, todo.read.png) : undefined;
      if (json) out(JSON.stringify(r, null, 2));
      else out(formatRead(r, { now: now(), full: !!todo.read.cards, pngs }));
      // Only once everything is out: a card whose image couldn't be made stays unread.
      const read = r.returned.filter((id) => !todo.read.png || !r.cards.some((c) => c.id === id && !c.png?.ok));
      if (read.length) await apply([{ op: 'read', cards: read, rev: r.rev }]);
      return 0;
    }
    if (todo.state) {
      const r = await call({ action: 'read', cards: [todo.state.card] });
      const card = r.cards[0];
      if (!card) throw new Refused(`There is no card "${todo.state.card}" on the board. office-whiteboard read lists them.`);
      let v = card.state;
      for (const k of todo.state.path) v = v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, k) ? v[k] : undefined;
      if (v === undefined) throw new Refused(`${todo.state.card} has nothing at ${todo.state.path.join('.')}`);
      out(JSON.stringify(v, null, 2));
      return 0;
    }
    const res = await apply(todo.ops);
    if (json) {
      out(JSON.stringify({ ...res, ...(todo.card ? { card: todo.card } : {}), ...(todo.id ? { id: todo.id } : {}) }, null, 2));
      return 0;
    }
    const at = `revision ${res.rev}${res.duplicate ? ', already applied' : ''}`;
    switch (cmd.cmd) {
      case 'push': {
        out(todo.card);
        // What the office couldn't collect is worth knowing now.
        const r = await call({ action: 'read', cards: [todo.card] });
        const c = r.cards[0];
        for (const m of c?.content?.missing ?? []) err(`Not collected: ${m.ref} (${m.reason})`);
        if (c?.link?.status === 'broken') err(`The link is broken: ${c.link.reason}`);
        break;
      }
      case 'comment':
      case 'sticky':
      case 'picture':
        out(cmd.args[1] === 'add' ? todo.id : `Done (${at}).`);
        break;
      default:
        out(`Done (${at}).`);
    }
    return 0;
  } catch (e) {
    err(`office-whiteboard: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));
