// Markdown tables for bench.mjs results (one JSON object per scenario run).
const ms = (n) => (n == null ? '-' : `${n.toFixed(1)}`);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One table row per (config, cap, scenario), averaging repeats. */
export function tables(rows) {
  const paced = rows.filter((r) => r.report);
  const key = (r) => `${r.config}|${r.cap}|${r.scenario}`;
  const groups = new Map();
  for (const r of paced) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const lines = ['| Renderer | Cap | Scenario | Frames | p50 ms | p95 ms | p99 ms | max ms | Missed | Repeated | CPU p50 ms | GPU scene+hands ms |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const g of groups.values()) {
    const r = g[0];
    const f = (pick) => mean(g.map((x) => pick(x.report)));
    const gpu = g.every((x) => x.report.gpu.scene != null && x.report.gpu.hands != null) ? `${ms(f((x) => x.gpu.scene))} + ${ms(f((x) => x.gpu.hands))}` : '-';
    lines.push(
      `| ${r.renderer} | ${r.cap} | ${r.scenario} | ${Math.round(f((x) => x.frames))} | ${ms(f((x) => x.frameTime.p50))} | ${ms(f((x) => x.frameTime.p95))} | ${ms(f((x) => x.frameTime.p99))} | ${ms(f((x) => x.frameTime.max))} | ${Math.round(f((x) => x.missed))} | ${Math.round(f((x) => x.repeated))} | ${ms(f((x) => x.cpu.total.p50))} | ${gpu} |`,
    );
  }
  const shown = paced.filter((r) => r.display);
  if (shown.length) {
    lines.push('', '| Renderer | Cap | Scenario | Display frames | Display fps | gap p50 ms | gap p95 ms | gap p99 ms | gap max ms | Late | Extra refreshes |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of shown)
      lines.push(
        `| ${r.renderer} | ${r.cap} | ${r.scenario} | ${r.display.frames} | ${r.display.fps.toFixed(1)} | ${ms(r.display.gap.p50)} | ${ms(r.display.gap.p95)} | ${ms(r.display.gap.p99)} | ${ms(r.display.gap.max)} | ${r.display.missed} | ${r.display.repeated} |`,
      );
  }
  const loads = rows.filter((r) => r.scenario?.startsWith('load-'));
  if (loads.length) {
    lines.push('', '| Renderer | Cap | Load | Page shown s | Warm-up done s | RAF p50 ms | RAF p99 ms | RAF longest ms | Slow frames |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of loads)
      lines.push(
        `| ${r.renderer} | ${r.cap} | ${r.scenario.slice(5)} | ${(r.load.shownMs / 1000).toFixed(1)} | ${(r.load.warmMs / 1000).toFixed(1)} | ${ms(r.raf.gap.p50)} | ${ms(r.raf.gap.p99)} | ${ms(r.raf.longest)} | ${r.raf.over} of ${r.raf.frames} |`,
      );
  }
  return lines.join('\n');
}
