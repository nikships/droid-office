import type { WorkerAsk } from '../../shared/protocol.js';

/** The pending ask for a permission prompt about `tool` called with `input` (see WorkerInfo.ask). */
export function permissionAsk(tool: string, input: unknown, sub: boolean): Extract<WorkerAsk, { kind: 'permission' }> {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const command = str(i.command, 2000);
  const file = str(i.file_path ?? i.path, 1000);
  const risk = str(i.riskLevel ?? i.risk_level, 20);
  // Office MCP calls carry a title rather than a summary: the ask line names what is being approved.
  const summary = str(i.summary ?? i.description ?? i.title, 300);
  return { kind: 'permission', tool, ...(command ? { command } : {}), ...(file ? { file } : {}), ...(risk ? { risk } : {}), ...(summary ? { summary } : {}), ...(sub ? { sub: true as const } : {}) };
}

export function describeTool(payload: any): string {
  const name = payload?.tool_name ?? 'tool';
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? '';
  return truncate(detail ? `${name}: ${detail}` : String(name), 80);
}

export function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
