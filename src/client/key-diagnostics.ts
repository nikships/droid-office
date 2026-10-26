// The terminal key report (Settings → Workers): for a short while, every key the page sees, what the
// worker terminal's key handler did with it, the bytes it sent, the screen after each Enter, and in
// the Mac app that process's own key steps. Saved by the office for an agent to read (see
// shared/key-report.ts and the guide's "Terminal key report").

import { KEY_REPORT_MS, KeyRecorder, visibleBytes } from '../shared/key-report';
import { store } from './state';
import { withToken } from './token';
import { toast } from './ui/dom';

type MacShim = { keyTrace?(on: boolean): void };

const recorder = new KeyRecorder();
const screens = new Map<string, () => string[]>();
let startedAt = 0;
let timer = 0;
let offListeners: (() => void)[] = [];
let ending: Promise<KeyReportResult> | null = null;
let last: KeyReportResult | null = null;
const changeListeners = new Set<(recording: boolean) => void>();

export interface KeyReportResult {
  path?: string;
  error?: string;
}

const macShim = (): MacShim | undefined => (window as unknown as Record<symbol, MacShim | undefined>)[Symbol.for('droid-office.shim')];

/** An element as a short selector: `textarea.xterm-helper-textarea`. */
function describe(t: EventTarget | null): string {
  if (!(t instanceof Element)) return t === window ? 'window' : t === document ? 'document' : String(t);
  const cls = typeof t.className === 'string' && t.className.trim() ? `.${t.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  return `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ''}${cls}`;
}

/** What a report keeps of a key event. */
export function keyFields(e: KeyboardEvent): Record<string, unknown> {
  return {
    type: e.type,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
    composing: e.isComposing,
    repeat: e.repeat,
    prevented: e.defaultPrevented,
  };
}

export function keyRecording(): boolean {
  return recorder.active;
}

/** Whoever shows that a recording is on (the Settings card). */
export function onKeyRecording(fn: (recording: boolean) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** One step of the key's way, while a recording is on. */
export function noteKey(step: string, fields: Record<string, unknown>): void {
  if (recorder.active) recorder.add(step, fields, performance.now());
}

/** The bytes a terminal sent its PTY, or why it didn't. */
export function noteSent(workerId: string, data: string, dropped?: string): void {
  if (recorder.active) noteKey('xterm.data', { worker: workerId, bytes: visibleBytes(data), ...(dropped ? { dropped } : {}) });
}

/** A worker terminal that is open, so the report can show its screen. */
export function registerTerminalScreen(workerId: string, rows: () => string[]): () => void {
  screens.set(workerId, rows);
  return () => {
    if (screens.get(workerId) === rows) screens.delete(workerId);
  };
}

/** Its screen now, in the report. */
export function noteScreen(workerId: string, why: string): void {
  const rows = screens.get(workerId);
  if (recorder.active && rows) noteKey('screen', { worker: workerId, why, rows: rows() });
}

function listen<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture: boolean) {
  window.addEventListener(type, fn, capture);
  offListeners.push(() => window.removeEventListener(type, fn, capture));
}

export function startKeyRecording(): void {
  if (recorder.active || ending) return;
  startedAt = Date.now();
  recorder.start(performance.now());
  const at = (e: Event) => ({ target: describe(e.target), focus: describe(document.activeElement) });
  // Capture sees the key before any handler of the page; bubble sees whether it got to the end, and who prevented it.
  for (const type of ['keydown', 'keyup'] as const) {
    listen(type, (e) => noteKey('dom.capture', { ...keyFields(e), ...at(e) }), true);
    listen(type, (e) => noteKey('dom.bubble', { ...keyFields(e), ...at(e) }), false);
  }
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend'] as const) listen(type, (e) => noteKey('dom.composition', { type, data: e.data, ...at(e) }), true);
  listen('focus', () => noteKey('window', { focus: true }), false);
  listen('blur', () => noteKey('window', { focus: false }), false);
  const vis = () => noteKey('document', { visibility: document.visibilityState });
  document.addEventListener('visibilitychange', vis);
  offListeners.push(() => document.removeEventListener('visibilitychange', vis));
  noteKey('start', { focus: describe(document.activeElement), hasFocus: document.hasFocus(), macApp: !!macShim()?.keyTrace });
  for (const id of screens.keys()) noteScreen(id, 'start');
  macShim()?.keyTrace?.(true);
  timer = window.setTimeout(() => void stopKeyRecording(), KEY_REPORT_MS);
  for (const fn of changeListeners) fn(true);
}

/** The Mac app's own key steps, or null outside it or when it doesn't answer. */
function macTrace(): Promise<string[] | null> {
  const shim = macShim();
  if (!shim?.keyTrace) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (lines: string[] | null) => {
      window.removeEventListener('droid-office-key-trace', onLines);
      clearTimeout(wait);
      resolve(lines);
    };
    const onLines = (e: Event) => done(((e as CustomEvent).detail as string[]) ?? []);
    const wait = window.setTimeout(() => done(null), 3000);
    window.addEventListener('droid-office-key-trace', onLines);
    shim.keyTrace?.(false);
  });
}

/** Ends the recording and has the office save it; resolves to where it is. */
export function stopKeyRecording(): Promise<KeyReportResult> {
  if (ending) return ending;
  if (!recorder.active) return Promise.resolve({ error: 'Nothing is being recorded' });
  ending = finish()
    .then((r) => {
      last = r;
      toast(r.path ? `Terminal key report saved to ${r.path}` : (r.error ?? 'The report was not saved'), r.path ? 'info' : 'warn');
      return r;
    })
    .finally(() => {
      ending = null;
      for (const fn of changeListeners) fn(false);
    });
  return ending;
}

/** How the last recording of this page ended. */
export function lastKeyReport(): KeyReportResult | null {
  return last;
}

async function finish(): Promise<KeyReportResult> {
  clearTimeout(timer);
  for (const id of screens.keys()) noteScreen(id, 'end');
  for (const off of offListeners) off();
  offListeners = [];
  const { events, ms, dropped } = recorder.stop(performance.now());
  const mac = await macTrace();
  const ids = new Set<string>(screens.keys());
  for (const e of events) if (typeof e.worker === 'string') ids.add(e.worker);
  const report = {
    kind: 'droid-office terminal key report',
    startedAt: new Date(startedAt).toISOString(),
    ms,
    droppedEvents: dropped,
    page: { userAgent: navigator.userAgent, macApp: mac !== null || !!macShim(), floor: store.floor },
    workers: [...ids].map((id) => {
      const w = store.workers.get(id);
      return w ? { id, name: w.name, kind: w.kind, status: w.status, guest: !!w.guest, open: w.open } : { id };
    }),
    events,
    macTrace: mac,
  };
  try {
    const res = await fetch(withToken(`/api/diagnostics/keys?floor=${encodeURIComponent(store.floor ?? '')}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    const r = (await res.json().catch(() => ({}))) as KeyReportResult;
    return res.ok && r.path ? { path: r.path } : { error: r.error ?? 'The office could not save the report' };
  } catch {
    return { error: 'Disconnected. The report was not saved.' };
  }
}
