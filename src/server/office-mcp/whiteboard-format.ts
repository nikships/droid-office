import type { Anchor, Author, PieceRef, Tombstone } from '../../shared/whiteboard.js';
import type { CardOut, ReadOut } from '../whiteboard-agent.js';

/** Board authors must not be able to inject terminal control characters into readable output. */
export function printable(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const who = (author: Author) => (author.kind === 'worker' ? author.name : 'the owner');
const quote = (value: string, max = 80) => {
  const one = value.replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
};
const indent = (text: string, by: string) =>
  text
    .split('\n')
    .map((line) => by + line)
    .join('\n');

function anchorText(anchor: Anchor): string {
  if (anchor.kind === 'point') return `at ${anchor.point.x},${anchor.point.y}`;
  const element = anchor.wbId ? `[data-wb-id="${anchor.wbId}"]` : anchor.selector;
  return `on ${element}${anchor.quote ? ` ${quote(anchor.quote, 40)}` : ''}${anchor.offset && (anchor.offset.x || anchor.offset.y) ? ` +${anchor.offset.x},${anchor.offset.y}` : ''}`;
}

function pieceText(piece: PieceRef): string {
  switch (piece.kind) {
    case 'title':
      return 'the title';
    case 'content':
      return 'the content';
    case 'state':
      return `state ${piece.path.join('.') || '(root)'}`;
    case 'thread':
      return `comment thread ${piece.id}`;
    case 'message':
      return `comment ${piece.thread}/${piece.id}`;
    case 'sticky':
    case 'picture':
      return `${piece.kind} ${piece.id}`;
  }
}

function changesText(changes: PieceRef[]): string[] {
  const groups = new Map<string, string[]>();
  for (const piece of changes) {
    const key = piece.kind === 'state' ? 'state' : pieceText(piece);
    const fields = groups.get(key) ?? [];
    if (piece.kind === 'thread') fields.push(piece.field === 'resolved' ? 'open or resolved' : 'place');
    else if (piece.kind === 'sticky' || piece.kind === 'picture') fields.push(piece.field === 'box' ? 'position or size' : piece.field === 'anchor' ? 'place' : piece.field);
    else if (piece.kind === 'state') fields.push(piece.path.join('.') || '(root)');
    groups.set(key, fields);
  }
  return [...groups].map(([key, fields]) => (key === 'state' ? `state ${fields.join(', ')}` : fields.length ? `${key} (${fields.join(', ')})` : key));
}

function removedText(tombstone: Tombstone, now: number): string {
  const what = tombstone.kind === 'state' ? `state ${JSON.parse(tombstone.id).join('.')}` : tombstone.kind === 'message' ? `comment ${tombstone.parent}/${tombstone.id}` : `${tombstone.kind} ${tombstone.id}`;
  return `${what} removed by ${who(tombstone.author)} ${ago(tombstone.at, now)}`;
}

interface FormatOptions {
  now: number;
  full: boolean;
  onlyChanged?: boolean;
  peek?: boolean;
  pngs?: Map<string, string>;
}

function formatCard(card: CardOut, { now, full, pngs }: FormatOptions): string {
  const lines: string[] = [];
  const mark = (changed: boolean) => (changed ? '  ← CHANGED' : '');
  const changes = card.changes;
  const kindLabel = card.format === 'html' || card.format === 'canvas' ? card.kind : `${card.kind}:${card.format}`;
  lines.push(`${card.id} ${quote(card.title)} (${kindLabel}, by ${who(card.author)}, updated ${ago(card.updatedAt, now)})${card.changed ? ' — CHANGED' : ''}`);
  if (card.changed) lines.push(`  Changed for you: ${[...changesText(changes), ...card.removed.map((t) => removedText(t, now))].join('; ')}`);
  if (card.link) lines.push(`  Linked to ${card.link.path}${card.link.dir ? ' (folder)' : ''}: ${card.link.status === 'ok' ? 'following it' : `BROKEN — ${card.link.reason ?? 'unreadable'}`}`);
  if (card.content) {
    const page = card.content.files[card.content.entry];
    const others = Object.keys(card.content.files).filter((name) => name !== card.content!.entry);
    lines.push(`  Page: ${card.content.entry}${page ? ` (${page.size} B) ${page.file}` : ''}`);
    if (others.length) lines.push('  Files:', ...others.map((name) => `    ${name}: ${card.content!.files[name].file}`));
    for (const missing of card.content.missing ?? []) lines.push(`  Not collected: ${missing.ref} (${missing.reason})`);
    if (full && card.content.markdown !== undefined) lines.push('  Markdown:', indent(card.content.markdown.replace(/\s+$/, ''), '    | '));
    else if (full && card.content.html !== undefined) lines.push('  HTML:', indent(card.content.html.replace(/\s+$/, ''), '    | '));
  }
  const state = JSON.stringify(card.state);
  if (state !== '{}') lines.push(`  State${mark(changes.some((piece) => piece.kind === 'state'))}: ${state}`);
  if (card.threads.length) {
    lines.push('  Comments:');
    for (const thread of card.threads) {
      lines.push(`    ${thread.id} ${anchorText(thread.anchor)}${thread.detached ? ' (detached)' : ''} [${thread.resolved ? 'resolved' : 'open'}]${mark(changes.some((piece) => piece.kind === 'thread' && piece.id === thread.id))}`);
      for (const message of thread.messages)
        lines.push(
          `      ${message.id} ${who(message.author)}, ${ago(message.at, now)}: ${message.text.includes('\n') ? `\n${indent(message.text, '        ')}` : message.text}${mark(changes.some((piece) => piece.kind === 'message' && piece.id === message.id && piece.thread === thread.id))}`,
        );
    }
  }
  for (const sticky of card.stickies) {
    const changed = changes.flatMap((piece) => (piece.kind === 'sticky' && piece.id === sticky.id ? [piece.field] : []));
    lines.push(
      `  Sticky ${sticky.id} (${sticky.color}, ${sticky.box.w}×${sticky.box.h} at ${sticky.box.x},${sticky.box.y}, anchored ${anchorText(sticky.anchor)}${sticky.detached ? ', detached' : ''}): ${sticky.text}${changed.length ? `  ← CHANGED (${changed.join(', ')})` : ''}`,
    );
  }
  for (const picture of card.pictures) {
    const changed = changes.flatMap((piece) => (piece.kind === 'picture' && piece.id === picture.id ? [piece.field] : []));
    lines.push(
      `  Picture ${picture.id} (${picture.file.mime}, ${picture.box.w}×${picture.box.h} at ${picture.box.x},${picture.box.y}, anchored ${anchorText(picture.anchor)}${picture.detached ? ', detached' : ''}): ${picture.file.file}${changed.length ? `  ← CHANGED (${changed.join(', ')})` : ''}`,
    );
  }
  const shot = pngs?.get(card.id);
  if (shot) lines.push(`  PNG: ${shot}`);
  else if (card.png && !card.png.ok) lines.push(`  PNG: none — ${card.png.error}${card.png.last ? ` The last image is of revision ${card.png.last.rev}, ${ago(card.png.last.at, now)}.` : ''} Your read point for this card wasn't moved.`);
  return lines.join('\n');
}

export function formatRead(out: ReadOut, options: FormatOptions): string {
  const selection = out.selection.kind === 'card' ? `card ${out.selection.id}` : 'the grid';
  const changed = out.cards.filter((card) => card.changed).length;
  const peekNote = options.peek ? ' (peek — read points unchanged)' : '';
  const lines = [
    `Whiteboard on ${out.floor.name}, revision ${out.rev}. The wall shows ${selection}.${peekNote}`,
    `${out.cards.length} card${out.cards.length === 1 ? '' : 's'}${changed ? `, ${changed} changed for you` : ''}.${out.renderer.available ? '' : ` Renders: unavailable (${out.renderer.reason ?? 'no renderer'}).`}`,
  ];
  for (const card of out.cards) lines.push('', formatCard(card, options));
  if (out.removed.length) lines.push('', 'Removed:', ...out.removed.map((tombstone) => `  ${removedText(tombstone, options.now)}`));
  if (out.unknown.length) lines.push('', `No such card: ${out.unknown.join(', ')}`);
  if (!out.cards.length && !out.removed.length && !out.unknown.length) {
    lines.push('', options.onlyChanged && out.totalCards > 0 ? 'No cards changed for you since your last read.' : 'The board is empty. Create a card with whiteboard_card.');
  }
  return lines.join('\n');
}
