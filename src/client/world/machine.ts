import type { MachineState } from '../../shared/protocol';

// What the compute wall (world/factory-computers.ts) and the hire dialog say about the office's machine.

/** Green while there's room, amber when it's getting full, red from where hiring gets a warning. */
export function loadColor(pct: number): string {
  return pct >= 90 ? '#ef4444' : pct >= 70 ? '#f2b84b' : '#3ccf91';
}

export function fmtGb(bytes: number): string {
  const gb = bytes / 2 ** 30;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/** The office has as many droids as it takes. */
export function officeFull(s: MachineState): boolean {
  return s.limit !== undefined && s.workers >= s.limit;
}

/** What the hire dialog says while the machine is under pressure. */
export function pressureNote(s: MachineState): string | undefined {
  return s.pressure ? `⚠️ This machine is under pressure: ${s.pressure}. Another droid may slow down the ones already working.` : undefined;
}
