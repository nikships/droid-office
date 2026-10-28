/** What the office's `GET /api/status` answers (src/server/office-status.ts). */
export interface OfficeStatus {
  workers: number;
  working: number;
  needsInput: number;
  phones: number;
  browsers: number;
}

export type TrayOfficeState = 'starting' | 'running' | 'stopped';

export interface TrayView {
  state: TrayOfficeState;
  /** Unset when the office didn't answer, or is older than the status route. */
  status?: OfficeStatus;
  /** The app's own window has the office open; its page is one of the browsers the office counts. */
  ownWindow: boolean;
  /** The app is showing an office it didn't start (a terminal's `npm start`), which quitting leaves running. */
  external: boolean;
}

export type TrayAction = 'open' | 'browser' | 'restart' | 'updates' | 'log' | 'quit' | 'quitStoppingWorkers';

export type TrayItem = { type: 'separator' } | { label: string; enabled: boolean; action?: TrayAction };

export function parseStatus(raw: unknown): OfficeStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const keys = ['workers', 'working', 'needsInput', 'phones', 'browsers'] as const;
  if (!keys.every((k) => Number.isInteger(r[k]) && (r[k] as number) >= 0)) return undefined;
  return { workers: r.workers as number, working: r.working as number, needsInput: r.needsInput as number, phones: r.phones as number, browsers: r.browsers as number };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The menu's first lines, which say what the office is doing. */
export function statusLines(v: TrayView): string[] {
  if (v.state === 'starting') return ['The office is starting…'];
  if (v.state === 'stopped') return ['The office is stopped'];
  const lines: string[] = [];
  const s = v.status;
  if (!s) lines.push('The office is running');
  else {
    const busy = [...(s.working ? [`${s.working} working`] : []), ...(s.needsInput ? [`${count(s.needsInput, 'needs', 'need')} input`] : [])];
    lines.push(busy.length ? busy.join(' · ') : s.workers ? `${count(s.workers, 'worker')}, none busy` : 'No workers');
    const browsers = Math.max(0, s.browsers - (v.ownWindow ? 1 : 0));
    const devices = [...(s.phones ? [count(s.phones, 'phone')] : []), ...(browsers ? [count(browsers, 'browser')] : [])];
    lines.push(devices.length ? `${devices.join(' · ')} connected` : 'No phones or browsers connected');
  }
  if (v.external) lines.push('Started outside the app');
  return lines;
}

export function trayTooltip(v: TrayView): string {
  return ['Droid Office', ...statusLines(v)].join('\n');
}

export function trayMenu(v: TrayView): TrayItem[] {
  const running = v.state === 'running';
  return [
    ...statusLines(v).map((label): TrayItem => ({ label, enabled: false })),
    { type: 'separator' },
    { label: 'Open Office', enabled: v.state !== 'starting', action: 'open' },
    { label: 'Open in Browser', enabled: running, action: 'browser' },
    { type: 'separator' },
    { label: v.state === 'stopped' ? 'Start Office' : 'Restart Office', enabled: v.state !== 'starting' && !v.external, action: 'restart' },
    { label: 'Check for Updates…', enabled: true, action: 'updates' },
    { label: 'Show Office Log', enabled: true, action: 'log' },
    { type: 'separator' },
    { label: 'Quit Droid Office', enabled: true, action: 'quit' },
    { label: 'Quit and Stop Workers…', enabled: running && !v.external, action: 'quitStoppingWorkers' },
  ];
}
