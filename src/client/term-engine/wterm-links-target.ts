import type { GhosttyCore } from '@wterm/ghostty';
import type { ILink } from '@xterm/xterm';
import { parseTerminalPathRefs } from '../../shared/path-links';
import { type Point, retainedRows } from './wterm-links-lines';

export interface Target {
  kind: 'osc8' | 'web' | 'path';
  text: string;
  label: string;
  range: ILink['range'];
}

// Same boundaries and URL canonicalization check as @xterm/addon-web-links.
const web = /(?:https?|HTTPS?):\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
function validWeb(text: string) {
  const url = URL.parse(text);
  if (!url) return false;
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return text.toLowerCase().startsWith(`${url.protocol}//${auth}${url.host}`.toLowerCase());
}

export function targetAt(core: GhosttyCore, at: Point): Target | undefined {
  const rows = retainedRows(core);
  const y = at.y - 1;
  let x = at.x - 1;
  if (x < 0 || x >= rows.cols || y < 0 || y >= rows.length || core.mouseTracking()) return;
  if (x > 0 && rows.cell(y, x).width === 0) x--;
  const line = rows.logical(y, true);
  if (!line) return;
  const index = line.cells.findIndex((p) => p.x === x + 1 && p.y === at.y);
  if (index < 0) return;
  function target(kind: Target['kind'], text: string, start: number, end: number): Target {
    const last = line!.cells[end - 1];
    return { kind, text, label: line!.text.slice(start, end), range: { start: line!.cells[start], end: { x: last.x + (rows.cell(last.y - 1, last.x - 1).width === 2 ? 1 : 0), y: last.y } } };
  }
  const cell = rows.cell(y, x);
  if (cell.linkUri) {
    const same = (i: number) => {
      const p = line.cells[i];
      if (!p) return false;
      const c = rows.cell(p.y - 1, p.x - 1);
      return c.linkUri === cell.linkUri && c.linkKey === cell.linkKey;
    };
    let start = index,
      end = index + 1;
    while (same(start - 1)) start--;
    while (same(end)) end++;
    return target('osc8', cell.linkUri, start, end);
  }
  for (const m of line.text.matchAll(web)) {
    const end = m.index + m[0].length;
    if (index >= m.index && index < end && validWeb(m[0])) return target('web', m[0], m.index, end);
  }
  for (const m of parseTerminalPathRefs(line.text)) if (index >= m.start && index < m.end) return target('path', m.raw, m.start, m.end);
}
