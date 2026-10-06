import { isAgentEffort } from '../shared/protocol.js';

export const DROID_MODEL_MAX = 256;

/** Droid model ids are settings values, so reject anything that could be ambiguous or unsafe. */
export function isValidDroidModel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > DROID_MODEL_MAX) return false;
  if (/[\s\p{Cc}\p{Cf}]/u.test(value)) return false;
  return true;
}

export function validateWorkerModel(kind: 'agent' | 'shell', model: unknown): string | undefined {
  if (model === undefined) return undefined;
  if (kind === 'shell') return 'Shell workers do not have an agent model';
  return isValidDroidModel(model) ? undefined : 'Invalid Droid model (expected a model id without whitespace)';
}

export function validateWorkerEffort(kind: 'agent' | 'shell', effort: unknown): string | undefined {
  if (effort === undefined) return undefined;
  if (kind === 'shell') return 'Shell workers do not have a reasoning effort';
  return isAgentEffort(effort) ? undefined : 'Invalid effort (expected low, medium, high, xhigh or max)';
}
