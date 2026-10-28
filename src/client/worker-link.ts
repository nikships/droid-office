// A link that opens a worker's terminal: `#worker=<id>&floor=<id>` on the office's address. The Mac app's
// menu bar and its notifications use it (src/desktop/tray-model.ts `workerHash`); main.ts goes to the
// worker's floor first when it is on another one.

export interface WorkerLink {
  worker: string;
  floor?: string;
  view?: 'thread';
}

const ID_MAX = 200;

/** The worker a page's address asks to open, if it asks for one. */
export function parseWorkerLink(hash: string): WorkerLink | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const worker = params.get('worker')?.trim();
  if (!worker || worker.length > ID_MAX) return undefined;
  const floor = params.get('floor')?.trim();
  return { worker, ...(floor && floor.length <= ID_MAX ? { floor } : {}), ...(params.get('view') === 'thread' ? { view: 'thread' as const } : {}) };
}

/** Where the office is now, for a link to act on. */
export interface LinkPlace {
  floor: string | null;
  hasWorker: (id: string) => boolean;
  hasFloor: (id: string) => boolean;
}

/** Open the terminal here, go to the worker's floor first, or say it's gone (sent home, or its floor left the building). */
export function linkStep(link: WorkerLink, here: LinkPlace): 'open' | 'go' | 'gone' {
  if (here.hasWorker(link.worker)) return 'open';
  if (link.floor && link.floor !== here.floor && here.hasFloor(link.floor)) return 'go';
  return 'gone';
}
