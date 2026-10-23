// The Android app's tablet and foldable overview (android/app/src/main/assets/overview/, built by
// tools/android-overview.mjs): the web companion's 3D floor (office-map.ts) in a WebView the app
// drives. The app hands it the floor, its workers and their screens through the bridge below and
// opens what is tapped. The page never reaches the office itself: the app fetches its props and
// fonts (ui/overview/OverviewPage.kt), so it never sees the office's address or a token.

import { statusWord } from '../shared/guests';
import type { Run, WorkerInfo } from '../shared/protocol';
import { type MapFloor, OfficeMap } from './office-map';
import { previewRows } from './screen-preview';
import { h, STATUS_LABEL } from './ui/dom';
import { doingLine, workerKind } from './worker-words';
import type { ScreenState } from './world/laptop';

/** What the app sends: `window.overview(msg)`. */
export type FromApp =
  | { t: 'floor'; floor: MapFloor }
  | { t: 'workers'; workers: WorkerInfo[]; chips?: Record<string, string>; canHire: boolean }
  | { t: 'screen'; id: string; cols: number; rows: number; lines: Run[][]; cursor: [number, number] }
  | { t: 'drop'; id: string }
  | { t: 'insets'; left: number; bottom: number; top?: number }
  | { t: 'cursor'; id: string }
  | { t: 'open'; id: string }
  | { t: 'back'; id: string }
  | { t: 'home' }
  | { t: 'zoom'; factor: number }
  | { t: 'run'; on: boolean };

/** What the page tells the app, through `OverviewBridge.post(json)`. */
export type ToApp = { t: 'ready' } | { t: 'unsupported' } | { t: 'opened'; id: string } | { t: 'hire'; deskId: string } | { t: 'focused'; id: string } | { t: 'lost' };

declare global {
  interface Window {
    OverviewBridge?: { post(json: string): void };
    overview?: (msg: FromApp) => void;
  }
}

const post = (msg: ToApp) => window.OverviewBridge?.post(JSON.stringify(msg));

const screens = new Map<string, ScreenState>();
let workers: WorkerInfo[] = [];
let chips: Record<string, string> = {};
let floor: MapFloor | undefined;
let canHire = false;
let opening = '';
let version = 0;
/** The app's panels are measured: until then the floor waits, so its first look frames the clear part. */
let insetsKnown = false;

function preview(into: HTMLElement, id: string) {
  const s = screens.get(id);
  if (!s) {
    into.replaceChildren(h('span.dash-preview-none', {}, 'No screen yet'));
    return;
  }
  into.style.setProperty('--cols', String(Math.max(20, s.cols)));
  into.replaceChildren(
    ...previewRows(s.lines, s.rows, 14).map((row) =>
      h(
        'span.dash-preview-row',
        {},
        ...row.map((r) => {
          if (!r.color && !r.background && !r.bold && !r.dim) return r.text;
          const span = h('span', { class: [r.bold ? 'b' : '', r.dim ? 'd' : ''].join(' ').trim() || undefined }, r.text);
          if (r.color) span.style.color = r.color;
          if (r.background) span.style.background = r.background;
          return span;
        }),
      ),
    ),
  );
}

function start() {
  const root = document.getElementById('map');
  if (!root || !OfficeMap.supported()) {
    post({ t: 'unsupported' });
    return;
  }
  const map = new OfficeMap({
    open: (id) => void open(id),
    hire: (deskId) => post({ t: 'hire', deskId }),
    canHire: () => canHire,
    screen: (id) => screens.get(id),
    preview,
    words: (w) => ({ status: statusWord(w, STATUS_LABEL), doing: doingLine(w), kind: workerKind(w), chip: chips[w.id] }),
    focused: (id) => post({ t: 'focused', id }),
    lost: () => post({ t: 'lost' }),
  });
  root.append(map.el);

  async function open(id: string) {
    if (opening) return;
    opening = id;
    try {
      await map.flyTo(id);
    } finally {
      opening = '';
    }
    post({ t: 'opened', id });
  }

  window.overview = (msg) => {
    switch (msg.t) {
      case 'floor':
        floor = msg.floor;
        if (insetsKnown) map.sync(workers, floor);
        break;
      case 'workers':
        workers = msg.workers;
        chips = msg.chips ?? {};
        canHire = msg.canHire;
        if (insetsKnown) map.sync(workers, floor);
        break;
      case 'screen':
        screens.set(msg.id, { cols: msg.cols, rows: msg.rows, lines: msg.lines, cursor: msg.cursor, version: ++version });
        break;
      case 'drop':
        screens.delete(msg.id);
        break;
      case 'insets':
        map.setInsets(msg.left, msg.bottom, msg.top ?? 0);
        if (!insetsKnown) {
          insetsKnown = true;
          map.sync(workers, floor);
        }
        break;
      case 'cursor':
        map.setCursor(msg.id);
        break;
      case 'open':
        void open(msg.id);
        break;
      case 'back':
        map.start();
        void map.returnFrom(msg.id);
        break;
      case 'home':
        void map.home();
        break;
      case 'zoom':
        void map.zoom(msg.factor);
        break;
      case 'run':
        if (msg.on) map.start();
        else map.stop();
        break;
    }
  };
  map.start();
  post({ t: 'ready' });
}

start();
