// Where things sit on the issues wall board's canvas, and what a point on it lands on. Pure, so
// tests can load it in Node (see world/boards.ts for the drawing).

/** Which view the issues wall board shows: the forge's issues, the floor's Jira epic or its Linear team. */
export type WallTab = 'issues' | 'jira' | 'linear';

/** Something on the wall board you can point at other than an issue note. */
export type BoardSpot = { kind: 'tab'; tab: WallTab } | { kind: 'ticket'; key: string };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tab strip across the top of the board, when the floor has a Jira epic or a Linear team. */
export const TAB_H = 64;
const TAB_W = 360;
/** Narrower with three tabs, so the "point at a tab" hint still fits on the right. */
const TAB_W_3 = 280;
const TAB_GAP = 12;
const TAB_PAD = 20;

/** Where each of `tabs` sits in the strip, left to right in the order given. */
export function tabRects(tabs: readonly WallTab[] = ['issues', 'jira']): Partial<Record<WallTab, Rect>> {
  const w = tabs.length > 2 ? TAB_W_3 : TAB_W;
  return Object.fromEntries(tabs.map((tab, i) => [tab, { x: TAB_PAD + i * (w + TAB_GAP), y: 8, w, h: TAB_H - 16 }]));
}

/** A ticket view's columns (Jira's three, Linear's four) and the cards in them, top to bottom, with how many didn't fit. */
export interface JiraLayout {
  columns: { rect: Rect; cards: Rect[]; hidden: number }[];
}

const COL_GAP = 18;
const COL_HEAD = 50;
const CARD_H = 92;
const CARD_GAP = 10;
/** Room under the last card for "+N more". */
const MORE_H = 30;

/** Lays out columns holding `counts[i]` tickets inside the canvas below `top`. */
export function jiraLayout(counts: number[], width: number, height: number, top: number): JiraLayout {
  const n = counts.length;
  const colW = (width - COL_GAP * (n + 1)) / n;
  const colH = height - top - COL_GAP;
  const room = colH - COL_HEAD - 8;
  const fit = Math.max(0, Math.floor((room + CARD_GAP) / (CARD_H + CARD_GAP)));
  return {
    columns: counts.map((count, i) => {
      const x = COL_GAP + i * (colW + COL_GAP);
      const rect = { x, y: top, w: colW, h: colH };
      // All of them if they fit; otherwise one fewer, to leave room for "+N more".
      const shown = count <= fit ? count : Math.max(0, Math.floor((room - MORE_H + CARD_GAP) / (CARD_H + CARD_GAP)));
      const cards = Array.from({ length: shown }, (_, j) => ({ x: x + 10, y: top + COL_HEAD + j * (CARD_H + CARD_GAP), w: colW - 20, h: CARD_H }));
      return { rect, cards, hidden: count - shown };
    }),
  };
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
