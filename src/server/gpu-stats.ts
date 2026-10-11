import { execFile } from 'node:child_process';

/** The Mac's whole-GPU load, the numbers Activity Monitor's GPU History draws, 0–100. */
export interface GpuStats {
  /** How much of the time the GPU was busy at all. */
  device: number;
  /** The fragment (pixel) side of the GPU. Upscaling lowers this one most. */
  renderer: number;
  /** The vertex and tiling side. */
  tiler: number;
}

const stat = (block: string, name: string): number | null => {
  const m = block.match(new RegExp(`"${name}"=(\\d+)`));
  return m ? Number(m[1]) : null;
};

/** `ioreg -c IOAccelerator` output to the busiest GPU's load. A Mac with two GPUs lists both. */
export function parseIoreg(text: string): GpuStats | null {
  let best: GpuStats | null = null;
  for (const m of text.matchAll(/"PerformanceStatistics" = \{([^}]*)\}/g)) {
    const device = stat(m[1], 'Device Utilization %');
    if (device === null) continue;
    const s = { device, renderer: stat(m[1], 'Renderer Utilization %') ?? device, tiler: stat(m[1], 'Tiler Utilization %') ?? 0 };
    if (!best || s.device > best.device) best = s;
  }
  return best;
}

/** How long one reading is reused, so several tabs polling don't each run ioreg. */
const FRESH_MS = 500;
let last: { at: number; stats: Promise<GpuStats | null> } | null = null;

/** The Mac's GPU load from ioreg (no sudo needed), or null off macOS or if ioreg fails. */
export function readGpuStats(now = Date.now()): Promise<GpuStats | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  if (last && now - last.at < FRESH_MS) return last.stats;
  const query = (cls: string) =>
    new Promise<string>((resolve) => {
      execFile('ioreg', ['-r', '-d', '1', '-w0', '-c', cls], { timeout: 2000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
    });
  // No `-k PerformanceStatistics`: filtered to that key, Apple silicon reports a stale 0 instead of the current load.
  // Apple silicon's GPU is AGXAccelerator. Recent macOS also lists an IOAccelerator compatibility entry for it whose
  // counters mostly read 0; an Intel or AMD GPU only shows up as an IOAccelerator subclass. The busiest reading wins.
  const stats = Promise.all([query('AGXAccelerator'), query('IOAccelerator')]).then((out) => parseIoreg(out.join('\n')));
  last = { at: now, stats };
  return stats;
}
