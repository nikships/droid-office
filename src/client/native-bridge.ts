/** The Mac app's line from the page to its native Metal presenter (`droidOfficeNative`, exposed by `src/desktop/page-preload.cts`). Absent in a browser. */
interface NativePresenterBridge {
  stats(reset: boolean, plannedMs: number): Promise<unknown>;
  setHdr(on: boolean): void;
}

function bridge(): NativePresenterBridge | null {
  if (typeof window === 'undefined') return null;
  const native = (window as unknown as { droidOfficeNative?: { presenter?: NativePresenterBridge } }).droidOfficeNative;
  return native?.presenter ?? null;
}

let reportedHdr: boolean | null = null;

/** Tells the presenter whether the page is putting out brighter-than-white pixels, so the display only gives headroom then. */
export function reportHdr(on: boolean) {
  if (on === reportedHdr) return;
  reportedHdr = on;
  bridge()?.setHdr(on);
}

/** What the presenter measured on its side (present times, latency from the paint, dropped frames), or null in a browser. */
export async function presenterStats(reset: boolean, plannedMs: number): Promise<unknown | null> {
  const native = bridge();
  return native ? await native.stats(reset, plannedMs) : null;
}
