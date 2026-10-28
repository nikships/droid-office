/** A worker waiting on the owner, as `GET /api/status` names it (src/server/office-status.ts). */
export interface StatusWaiting {
  id: string;
  name: string;
  status: 'needs_input' | 'done';
  floor: string;
  floorName: string;
  task?: string;
  since: number;
}

/** What the office's `GET /api/status` answers (src/server/office-status.ts). */
export interface OfficeStatus {
  workers: number;
  working: number;
  needsInput: number;
  done: number;
  phones: number;
  browsers: number;
  floors: number;
  waiting: StatusWaiting[];
}

export type TrayOfficeState = 'starting' | 'running' | 'stopped';

export interface TrayView {
  state: TrayOfficeState;
  /** Unset when the office didn't answer, or is older than the status route. */
  status?: OfficeStatus;
  /** The app's open office and companion pages, included in the server's browser count. */
  ownWindows: number;
  /** The app is showing an office it didn't start (a terminal's `npm start`), which quitting leaves running. */
  external: boolean;
  /** Whether the app notifies while its window is closed and a worker starts to wait on the owner. */
  notify: boolean;
  /** The app's version, for Check for Updates. */
  version: string;
  /** The office's address, for Open Office Companion. */
  url?: string;
}

export type TrayAction = 'open' | 'companion' | 'worker' | 'restart' | 'updates' | 'log' | 'notify' | 'quit' | 'quitStoppingWorkers';

/** Which worker a click opens: the office goes to its floor and opens its terminal (see src/client/worker-link.ts). */
export interface WorkerLink {
  worker: string;
  floor: string;
}

/** The pictures beside a waiting worker: a question to answer, or a finished turn to look at. */
export type TrayIcon = 'needsInput' | 'done';

export type TrayItem = { type: 'separator' } | { type: 'header'; label: string } | { label: string; enabled: boolean; sublabel?: string; action?: TrayAction; link?: WorkerLink; icon?: TrayIcon; checked?: boolean };

/** How many waiting workers the menu names; the rest are one "more" line that opens the office. */
export const TRAY_WAITING_MAX = 6;
const NAME_MAX = 60;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plain = (v: unknown, max: number) => (typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : '');
const natural = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function parseWaiting(raw: unknown): StatusWaiting | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = plain(r.id, 200);
  const floor = plain(r.floor, 200);
  if (!id || !floor || (r.status !== 'needs_input' && r.status !== 'done') || !natural(r.since)) return undefined;
  const task = plain(r.task, NAME_MAX);
  return { id, name: plain(r.name, NAME_MAX) || 'A worker', status: r.status, floor, floorName: plain(r.floorName, NAME_MAX), ...(task ? { task } : {}), since: r.since };
}

/**
 * Reads what the office sent. The counts every office has sent since the menu bar icon came are required;
 * `done`, `floors` and `waiting` came later, so an older office that is already running still shows its counts.
 */
export function parseStatus(raw: unknown): OfficeStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const keys = ['workers', 'working', 'needsInput', 'phones', 'browsers'] as const;
  if (!keys.every((k) => natural(r[k]))) return undefined;
  const waiting = Array.isArray(r.waiting) ? r.waiting.slice(0, 50).flatMap((w) => parseWaiting(w) ?? []) : [];
  return {
    workers: r.workers as number,
    working: r.working as number,
    needsInput: r.needsInput as number,
    done: natural(r.done) ? r.done : 0,
    phones: r.phones as number,
    browsers: r.browsers as number,
    floors: natural(r.floors) ? r.floors : 1,
    waiting,
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many workers wait on the owner: the number beside the menu bar icon and on the Dock icon. */
export function waitingCount(v: Pick<TrayView, 'state' | 'status'>): number {
  return v.state === 'running' && v.status ? v.status.needsInput + v.status.done : 0;
}

/** The menu's first lines, which say what the office is doing. */
export function statusLines(v: TrayView): string[] {
  if (v.state === 'starting') return ['The office is starting…'];
  if (v.state === 'stopped') return ['The office is stopped'];
  const lines: string[] = [];
  const s = v.status;
  if (!s) lines.push('The office is running');
  else {
    const busy = [...(s.working ? [`${s.working} working`] : []), ...(s.needsInput ? [`${count(s.needsInput, 'needs', 'need')} input`] : []), ...(s.done ? [`${s.done} done`] : [])];
    lines.push(!s.workers ? 'No workers' : busy.length ? [count(s.workers, 'worker'), ...busy].join(' · ') : `${count(s.workers, 'worker')}, none busy`);
    const browsers = Math.max(0, s.browsers - v.ownWindows);
    const devices = [...(s.phones ? [count(s.phones, 'phone')] : []), ...(browsers ? [count(browsers, 'browser')] : [])];
    lines.push(devices.length ? `${devices.join(' · ')} connected` : 'No phones or browsers connected');
  }
  if (v.external) lines.push('Started outside the app');
  return lines;
}

export function trayTooltip(v: TrayView): string {
  return ['Droid Office', ...statusLines(v)].join('\n');
}

/** The text beside the menu bar icon: how many workers wait on the owner, or nothing. */
export function trayTitle(v: TrayView): string {
  const n = waitingCount(v);
  return n ? String(n) : '';
}

function waitingLabel(w: StatusWaiting): string {
  return `${w.name} ${w.status === 'needs_input' ? 'needs input' : 'is done'}`;
}

/** "Ada needs input", and under it the task and, in a building of several floors, the floor. */
export function waitingItem(w: StatusWaiting, floors: number): TrayItem {
  const sublabel = [w.task, floors > 1 ? w.floorName : undefined].filter(Boolean).join(' · ');
  return {
    label: waitingLabel(w),
    enabled: true,
    ...(sublabel ? { sublabel } : {}),
    action: 'worker',
    link: { worker: w.id, floor: w.floor },
    icon: w.status === 'needs_input' ? 'needsInput' : 'done',
  };
}

/** Who waits on the owner: each opens that worker's terminal. Empty while nobody does. */
function waitingSection(v: TrayView): TrayItem[] {
  const s = v.status;
  const total = waitingCount(v);
  if (!s || !total) return [];
  const shown = s.waiting.slice(0, TRAY_WAITING_MAX);
  const more = total - shown.length;
  return [
    { type: 'separator' },
    { type: 'header', label: 'Waiting on You' },
    ...shown.map((w) => waitingItem(w, s.floors)),
    // An office older than the waiting list sends only the counts: the line then stands for all of them.
    ...(more > 0 ? [{ label: `${count(more, shown.length ? 'more worker' : 'worker')} waiting…`, enabled: true, action: 'open' as const }] : []),
  ];
}

/** "localhost:4600" for Open Office Companion. */
function address(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function trayMenu(v: TrayView): TrayItem[] {
  const running = v.state === 'running';
  const where = running ? address(v.url) : undefined;
  return [
    ...statusLines(v).map((label): TrayItem => ({ label, enabled: false })),
    ...waitingSection(v),
    { type: 'separator' },
    { label: 'Open Office', enabled: v.state !== 'starting', action: 'open' },
    { label: 'Open Office Companion', enabled: running, ...(where ? { sublabel: where } : {}), action: 'companion' },
    { type: 'separator' },
    { label: v.state === 'stopped' ? 'Start Office' : 'Restart Office', enabled: v.state !== 'starting' && !v.external, action: 'restart' },
    { label: 'Show Office Log', enabled: true, action: 'log' },
    { type: 'separator' },
    { label: 'Notify When Workers Wait on You', enabled: true, sublabel: 'While the office window is closed', checked: v.notify, action: 'notify' },
    { label: 'Check for Updates…', enabled: true, sublabel: `Version ${v.version}`, action: 'updates' },
    { type: 'separator' },
    { label: 'Quit Droid Office', enabled: true, action: 'quit' },
    { label: 'Quit and Stop Workers…', enabled: running && !v.external, action: 'quitStoppingWorkers' },
  ];
}

/** The notification for a worker that started to wait: the same words as the office's own (src/client/notify.ts). */
export function waitingNotice(w: StatusWaiting, floors: number): { title: string; body: string } {
  return { title: waitingLabel(w), body: [w.task, floors > 1 ? `${w.floorName} floor` : undefined].filter(Boolean).join('\n') };
}

/** The status names fewer waiting workers than there are: the rest are cut off by the server's cap. */
export function listCut(status: OfficeStatus): boolean {
  return status.needsInput + status.done > status.waiting.length;
}

/**
 * Which workers started to wait since the last status: the ones to notify about. The first status after the
 * office (re)starts names nobody, since those workers were already waiting before anyone could be told.
 */
export class WaitingWatch {
  private seen: Map<string, number> | undefined;

  next(status: OfficeStatus | undefined): StatusWaiting[] {
    if (!status) return [];
    const before = this.seen;
    this.seen = new Map(status.waiting.map((w) => [w.id, w.since]));
    // Past the server's cap a worker can drop out of the list while still waiting; keep it so it isn't new when it returns.
    if (before && listCut(status)) for (const [id, since] of before) if (!this.seen.has(id)) this.seen.set(id, since);
    return before ? status.waiting.filter((w) => before.get(w.id) !== w.since) : [];
  }

  /** A different office, or none: its workers' waits start over. */
  reset() {
    this.seen = undefined;
  }
}

/** `#worker=<id>&floor=<id>`: what the office page reads to open a worker's terminal (src/client/worker-link.ts). */
export function workerHash(link: WorkerLink): string {
  return `#${new URLSearchParams({ worker: link.worker, floor: link.floor }).toString()}`;
}
