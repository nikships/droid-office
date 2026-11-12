// What the Whiteboard dialogs need that is not a mark: the Ping a worker rows, and the media types
// and file list of a folder upload.

import { forgeWords, type ForgeWords } from '../../shared/floors';
import type { WorkerInfo } from '../../shared/protocol';
import { pingEligibility, type PingHow } from '../../shared/whiteboard-ping';

export interface PingRow {
  id: string;
  name: string;
  color: string;
  /** What it is on: its task card's title, else the prompt it was hired with. Unset while it has neither. */
  task?: string;
  /** Where that work lives: its branch and pull request. */
  where?: string;
  /** The status word, as the rest of the office says it. */
  status: string;
  statusClass: string;
  ok: boolean;
  how?: PingHow;
  /** What pressing Ping does, or why it can't. */
  note: string;
  busy?: boolean;
  /** It made the card the picker was opened from. */
  author?: boolean;
}

const HOW_NOTE: Record<PingHow, string> = {
  type: 'Types the line into its terminal now',
  resume: 'Wakes it up with the line',
  queue: 'Queues the line behind its current turn',
};

const TASK_CHARS = 80;

/** What a worker is on, so the owner can pick it without knowing its name. */
export function pingTask(w: WorkerInfo): string | undefined {
  const name = w.task?.name.trim();
  if (name) return name;
  const line = w.prompt
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > TASK_CHARS ? `${line.slice(0, TASK_CHARS - 1).trimEnd()}…` : line;
}

/** Its branch (the one it made, else its worktree's) and its pull request, as one line. */
export function pingWhere(w: WorkerInfo, words: ForgeWords = forgeWords(undefined)): string | undefined {
  const branch = w.worktree?.made ?? w.worktree?.branch;
  const parts = [branch, w.pr && `${words.pr} ${words.ref(w.pr.number)}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The picker's rows: every worker on the floor with whether it can be pinged now and why not. The
 * worker that made the open card (`author`, a worker id) comes first, then the ones that can be pinged,
 * then A to Z.
 */
export function pingRows(workers: Iterable<WorkerInfo>, statusLabel: Record<string, string>, words: ForgeWords = forgeWords(undefined), author?: string): PingRow[] {
  const rows = [...workers].map((w): PingRow => {
    const e = pingEligibility(w);
    const status = statusLabel[w.status] ?? w.status;
    const task = pingTask(w);
    const where = pingWhere(w, words);
    const base = {
      id: w.id,
      name: w.name,
      color: w.color,
      ...(task ? { task } : {}),
      ...(where ? { where } : {}),
      status,
      statusClass: w.status,
      ...(author && w.id === author ? { author: true } : {}),
    };
    return e.ok ? { ...base, ok: true, how: e.how, note: HOW_NOTE[e.how] } : { ...base, ok: false, note: e.reason, ...(e.busy ? { busy: true } : {}) };
  });
  const rank = (r: PingRow) => {
    if (r.author) return -1;
    if (r.ok) return 0;
    return r.busy ? 1 : 2;
  };
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** What a ping that went in did, for the row. */
export function pingedText(name: string, how: PingHow | undefined): string {
  if (how === 'queue') return `Queued for ${name} after its turn`;
  if (how === 'resume') return `Woke ${name} up with it`;
  return `Typed it into ${name}'s terminal`;
}

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
};

/** Classifies a single uploaded or dropped file into a Whiteboard card format, or undefined when unsupported. */
export function droppedCardKind(name: string, browserType = ''): 'markdown' | 'video' | 'image' | 'html' | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const type = browserType.toLowerCase();
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return 'markdown';
  if (ext === 'mp4' || ext === 'm4v' || ext === 'webm' || ext === 'mov' || ext === 'ogv' || type.startsWith('video/')) return 'video';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif' || ext === 'svg' || /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/.test(type)) return 'image';
  if (ext === 'html' || ext === 'htm' || type === 'text/html') return 'html';
  return undefined;
}

/** The media type a file of a folder upload is served as: from its extension, else what the browser said. */
export function mimeFor(name: string, browserType = ''): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || browserType || 'application/octet-stream';
}

/**
 * The files of an uploaded folder, by their path inside it (the folder's own name dropped), and the
 * page to open: index.html at the top if there is one, else the shallowest .html. Hidden files and
 * folders (.git, .DS_Store) and node_modules are left out.
 */
export function folderFiles<T extends { path: string }>(files: T[]): { files: { rel: string; file: T }[]; entry?: string; skipped: number } {
  const out: { rel: string; file: T }[] = [];
  let skipped = 0;
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    const rel = (parts.length > 1 ? parts.slice(1) : parts).join('/');
    if (!rel || rel.split('/').some((p) => p.startsWith('.') || p === 'node_modules')) {
      skipped++;
      continue;
    }
    out.push({ rel, file: f });
  }
  const pages = out.map((f) => f.rel).filter((r) => /\.html?$/i.test(r));
  const entry = pages.find((r) => /^index\.html?$/i.test(r)) ?? pages.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  return { files: out, entry, skipped };
}
