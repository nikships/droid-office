// A floor's Jira epic as a kanban board (see server/jira.ts): the shapes the office and the browser
// share, and the pure logic behind them, from Atlassian Document Format to the board's columns.

import { forgeWords, type Forge } from './floors.js';

/** Jira's own buckets for a status, whatever the workflow calls it. */
export type JiraCategory = 'new' | 'indeterminate' | 'done';

/** A ticket on the Jira tab: one of the epic's direct children. */
export interface JiraTicket {
  key: string;
  summary: string;
  /** Story, Bug, Task… */
  type: string;
  /** Empty when the project doesn't use priorities. */
  priority: string;
  /** Display name; missing when nobody is assigned. */
  assignee?: string;
  status: string;
  statusId: string;
  category: JiraCategory;
  /** The ticket's page in Jira. */
  url: string;
  /** ISO time. */
  updated: string;
}

/** A column of the project's Jira board, and the statuses that sit in it. */
export interface JiraColumn {
  name: string;
  statusIds: string[];
}

/** The Jira tab of a floor's issue board. */
export interface JiraBoardState {
  /** The epic whose children these are, e.g. EDP-168. */
  epic: string;
  columns: JiraColumn[];
  items: JiraTicket[];
  fetchedAt: number;
  loading: boolean;
  error?: string;
}

/** A way a ticket can move from its current status, through Jira's workflow. */
export interface JiraTransition {
  id: string;
  name: string;
  /** The status it lands in. */
  to: string;
  toCategory: JiraCategory;
}

export interface JiraComment {
  id: string;
  author: string;
  /** Converted from Atlassian Document Format to markdown. */
  body: string;
  created: string;
}

/** Everything the ticket window shows beyond the card: GET /api/jira/ticket?key=… */
export interface JiraTicketDetail extends JiraTicket {
  /** Markdown, converted from Atlassian Document Format. */
  description: string;
  reporter?: string;
  created: string;
  comments: JiraComment[];
  transitions: JiraTransition[];
  /** Who the office is connected to Jira as: who comments, moves and assigns from here. */
  viewer: string;
}

/** Who the office is connected to Jira as. Never the token. */
export interface JiraConnection {
  /** https://<site>.atlassian.net */
  site: string;
  email: string;
  /** The account's display name. */
  name: string;
  by: string;
  at: number;
}

/** The epic a floor maps to, and the board whose columns its tab uses. */
export interface JiraEpic {
  key: string;
  summary: string;
  project: string;
  boardId: number;
  boardName: string;
  by: string;
  at: number;
}

/** A board an admin picks between when the epic's project has more than one. */
export interface JiraBoardChoice {
  id: number;
  name: string;
  type: string;
}

/** Jira on the floor you're on: the office's connection, and this floor's epic. */
export interface JiraFloorState {
  connection?: JiraConnection;
  epic?: JiraEpic;
}

/** Jira turns away comments longer than this. */
export const JIRA_COMMENT_MAX = 32767;

const KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

/** EDP-168, in capitals; undefined when it isn't a Jira issue key. */
export function jiraKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const k = value.trim().toUpperCase();
  return k.length <= 40 && KEY.test(k) ? k : undefined;
}

/** Every issue key in a pull request's title or branch (`office/edp-12-pixel`), in capitals. */
export function keysIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)(?![A-Za-z0-9_])/g)) out.add(m[1].toUpperCase());
  return [...out];
}

// ---- Atlassian Document Format -------------------------------------------------------------------

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case 'text': {
      let t = n.text ?? '';
      let link = '';
      for (const m of n.marks ?? []) {
        if (m.type === 'code') t = `\`${t}\``;
        else if (m.type === 'strong') t = `**${t}**`;
        else if (m.type === 'em') t = `*${t}*`;
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link') link = str(m.attrs?.href);
      }
      return link ? `[${t}](${link})` : t;
    }
    case 'hardBreak':
      return '  \n';
    case 'mention':
      return `@${str(n.attrs?.text).replace(/^@/, '') || 'someone'}`;
    case 'emoji':
      return str(n.attrs?.text) || str(n.attrs?.shortName);
    case 'inlineCard':
      return str(n.attrs?.url);
    case 'date': {
      const ms = Number(n.attrs?.timestamp);
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
    }
    case 'status':
      return `[${str(n.attrs?.text)}]`;
    default:
      return n.content ? inline(n.content) : (n.text ?? '');
  }
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n');
}

function block(n: AdfNode): string {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(n.content)}`;
    }
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${indent(listItem(li), '  ')}`).join('\n');
    case 'orderedList': {
      const start = Number(n.attrs?.order) || 1;
      return (n.content ?? []).map((li, i) => `${start + i}. ${indent(listItem(li), '   ')}`).join('\n');
    }
    case 'taskList':
      return (n.content ?? []).map((t) => `- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(t.content)}`).join('\n');
    case 'codeBlock': {
      const lang = str(n.attrs?.language);
      return `\`\`\`${lang}\n${(n.content ?? []).map((t) => t.text ?? '').join('')}\n\`\`\``;
    }
    case 'blockquote':
    case 'panel':
      return blocks(n.content)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '_(attachment: open the ticket in Jira to see it)_';
    case 'blockCard':
    case 'embedCard':
      return str(n.attrs?.url);
    case 'table':
      return table(n);
    case 'expand':
    case 'nestedExpand':
      return [str(n.attrs?.title) ? `**${str(n.attrs?.title)}**` : '', blocks(n.content)].filter(Boolean).join('\n\n');
    default:
      return n.content ? blocks(n.content) : inlineNode(n);
  }
}

function listItem(li: AdfNode): string {
  return (li.content ?? []).map(block).join('\n');
}

function table(n: AdfNode): string {
  const rows = (n.content ?? []).map((row) => (row.content ?? []).map((cell) => blocks(cell.content).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function blocks(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map(block)
    .filter((b) => b !== '')
    .join('\n\n');
}

/** A description or comment in Atlassian Document Format, as the office's markdown. A plain string passes through. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (!doc || typeof doc !== 'object') return '';
  const d = doc as AdfNode;
  return (d.type === 'doc' ? blocks(d.content) : block(d)).trim();
}

/** Plain text as an ADF document: blank lines split paragraphs, and links are links. */
export function textToAdf(text: string): { type: 'doc'; version: 1; content: AdfNode[] } {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/);
  const content = paragraphs.map((p) => {
    const parts: AdfNode[] = [];
    p.split('\n').forEach((line, i) => {
      if (i > 0) parts.push({ type: 'hardBreak' });
      let at = 0;
      for (const m of line.matchAll(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g)) {
        if (m.index > at) parts.push({ type: 'text', text: line.slice(at, m.index) });
        parts.push({ type: 'text', text: m[0], marks: [{ type: 'link', attrs: { href: m[0] } }] });
        at = m.index + m[0].length;
      }
      if (at < line.length) parts.push({ type: 'text', text: line.slice(at) });
    });
    return { type: 'paragraph', content: parts };
  });
  return { type: 'doc', version: 1, content };
}

// ---- The board ---------------------------------------------------------------------------------------

/** The columns of a board, from the Agile API's `board/{id}/configuration`. */
export function columnsOf(config: unknown): JiraColumn[] {
  const cols = (config as { columnConfig?: { columns?: unknown[] } } | undefined)?.columnConfig?.columns;
  if (!Array.isArray(cols)) return [];
  return cols
    .map((c) => {
      const col = c as { name?: unknown; statuses?: { id?: unknown }[] };
      return { name: str(col.name) || '?', statusIds: (Array.isArray(col.statuses) ? col.statuses : []).map((s) => String(s?.id ?? '')).filter(Boolean) };
    })
    .filter((c) => c.name);
}

/** Where tickets go on the Jira tab: the board's columns in order, plus one for statuses the board has no column for. */
export function ticketColumns(columns: JiraColumn[], items: JiraTicket[]): { name: string; items: JiraTicket[] }[] {
  const byStatus = new Map<string, number>();
  columns.forEach((c, i) => {
    for (const id of c.statusIds) if (!byStatus.has(id)) byStatus.set(id, i);
  });
  const out = columns.map((c) => ({ name: c.name, items: [] as JiraTicket[] }));
  const other: JiraTicket[] = [];
  for (const t of items) {
    const i = byStatus.get(t.statusId);
    if (i === undefined) other.push(t);
    else out[i].items.push(t);
  }
  if (other.length) out.push({ name: 'Not on the board', items: other });
  return out;
}

// ---- Transitions ---------------------------------------------------------------------------------------

/** What the office moves a ticket to by itself: In Progress when a worker picks it up, review, Done when its PR merges. */
export type JiraStage = 'progress' | 'review' | 'done';

const NOT_DONE = /won'?t|cancel|reject|duplicate|invalid|abandon|obsolete|decline/i;

/**
 * Which transition takes a ticket to `want`: one of the office's stages, or a status or transition as
 * a person or worker named it. Undefined when the workflow has no such move from here.
 */
export function pickTransition(transitions: JiraTransition[], want: JiraStage | string): JiraTransition | undefined {
  const either = (t: JiraTransition, re: RegExp) => re.test(t.to) || re.test(t.name);
  const first = (...tests: ((t: JiraTransition) => boolean)[]) => {
    for (const test of tests) {
      const hit = transitions.find(test);
      if (hit) return hit;
    }
    return undefined;
  };
  if (want === 'progress')
    return first(
      (t) => /^in[\s-]*progress$/i.test(t.to),
      (t) => either(t, /progress/i),
      (t) => t.toCategory === 'indeterminate' && !either(t, /review|block|hold|wait/i),
    );
  if (want === 'review')
    return first(
      (t) => /^in[\s-]*review$/i.test(t.to),
      (t) => either(t, /review/i),
    );
  if (want === 'done') {
    const done = transitions.filter((t) => t.toCategory === 'done' && !either(t, NOT_DONE));
    return done.find((t) => /^done$/i.test(t.to)) ?? done.find((t) => either(t, /done|closed?|resolved?|complete/i)) ?? done[0];
  }
  const w = want.trim().toLowerCase();
  if (!w) return undefined;
  const exact = transitions.find((t) => t.id === want.trim() || t.name.toLowerCase() === w || t.to.toLowerCase() === w);
  if (exact) return exact;
  const partial = transitions.filter((t) => t.name.toLowerCase().includes(w) || t.to.toLowerCase().includes(w));
  return partial.length === 1 ? partial[0] : undefined;
}

// ---- The worker's prompt -----------------------------------------------------------------------------

/** The longest description a worker's prompt carries; the rest is a `office-jira view` away. */
const PROMPT_DESCRIPTION_MAX = 8000;

/** The task a worker gets for a Jira ticket, from the Jira tab or the queue, with the rules for keeping it up to date. */
export function ticketPrompt(t: { key: string; summary: string; description?: string; url?: string }, forge: Forge = 'github'): string {
  const w = forgeWords(forge);
  const pr = w.pr;
  const description = (t.description ?? '').trim();
  const desc = description ? (description.length > PROMPT_DESCRIPTION_MAX ? `${description.slice(0, PROMPT_DESCRIPTION_MAX)}…\n\n(cut short: \`office-jira view\` shows all of it)` : description) : '(No description.)';
  const create = w.cli === 'glab' ? '`glab mr create`' : '`gh pr create`';
  return `Work on Jira ticket ${t.key}: "${t.summary}".

## The ticket${t.url ? ` (${t.url})` : ''}

${desc}

## Keeping ${t.key} up to date

Update the ticket with the \`office-jira\` command on your PATH. It goes through the office and only works for ${t.key}, so don't call Jira's API yourself:
- \`office-jira view\`: the ticket, its status and its comments
- \`office-jira transitions\`: the statuses it can move to from where it is
- \`office-jira transition "In Review"\`: move it
- \`office-jira comment <<'EOF'\` … \`EOF\`: comment on it, with the text in a quoted heredoc

Rules:
- **In Progress:** Move the ticket there when you start, if it isn't there already.
- **Comments:** Comment at real milestones: your plan, a blocker, a question for a person, and a summary when you finish.
- **${w.pull[0].toUpperCase()}${w.pull.slice(1)}s:** Put ${t.key} in the branch name and in the ${pr} title (open it with ${create}). When the ${pr} is open, comment its link on the ticket and move the ticket to the review status (for example "In Review").
- **Done:** If the work needs a ${pr}, leave the ticket in review: the office moves it to Done once the ${pr} merges. If the work needs no ${pr} (an investigation, an answer, a config change outside the repo), move the ticket to Done yourself when the work is finished, with a comment saying what was done.`;
}
