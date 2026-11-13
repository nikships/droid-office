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

const PERF_BLOCK_RE = /"PerformanceStatistics" = \{([^}]*)\}/g;
const DEVICE_RE = /"Device Utilization %"=(\d+)/;
const RENDERER_RE = /"Renderer Utilization %"=(\d+)/;
const TILER_RE = /"Tiler Utilization %"=(\d+)/;

const stat = (block: string, re: RegExp): number | null => {
  const m = re.exec(block);
  return m ? Number(m[1]) : null;
};

/** `ioreg -c IOAccelerator` output to the busiest GPU's load. A Mac with two GPUs lists both. */
export function parseIoreg(text: string): GpuStats | null {
  let best: GpuStats | null = null;
  for (const m of text.matchAll(PERF_BLOCK_RE)) {
    const device = stat(m[1], DEVICE_RE);
    if (device === null) continue;
    const s = { device, renderer: stat(m[1], RENDERER_RE) ?? device, tiler: stat(m[1], TILER_RE) ?? 0 };
    if (!best || s.device > best.device) best = s;
  }
  return best;
}

/** How long one reading is reused, so several tabs polling don't each run ioreg. */
const FRESH_MS = 500;
let last: { at: number; stats: Promise<GpuStats | null> } | null = null;
/** Once we discover which accelerator class reports stats on this Mac, avoid spawning both ioreg queries every poll. */
let activeClass: 'AGXAccelerator' | 'IOAccelerator' | null = null;

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
  const stats = activeClass
    ? query(activeClass).then(parseIoreg)
    : Promise.all([query('AGXAccelerator'), query('IOAccelerator')]).then(([agx, io]) => {
        const agxStats = parseIoreg(agx);
        const ioStats = parseIoreg(io);
        if (agxStats && !ioStats) activeClass = 'AGXAccelerator';
        else if (ioStats && !agxStats) activeClass = 'IOAccelerator';
        else if (agxStats && process.arch === 'arm64') activeClass = 'AGXAccelerator';
        if (!agxStats) return ioStats;
        if (!ioStats) return agxStats;
        return ioStats.device > agxStats.device ? ioStats : agxStats;
      });
  last = { at: now, stats };
  return stats;
}
