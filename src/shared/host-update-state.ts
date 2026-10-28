import type { HostUpdateState } from './host-update.js';

/** A bad/older response must never turn an unreadable status into an install control. */
export function isHostUpdateState(value: unknown): value is HostUpdateState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.supported === 'boolean' &&
    typeof s.currentVersion === 'string' &&
    typeof s.phase === 'string' &&
    typeof s.title === 'string' &&
    typeof s.busy === 'boolean' &&
    typeof s.canInstall === 'boolean' &&
    (s.detail === undefined || typeof s.detail === 'string') &&
    (s.version === undefined || typeof s.version === 'string') &&
    (s.progress === undefined || (typeof s.progress === 'number' && Number.isFinite(s.progress) && s.progress >= 0 && s.progress <= 1)) &&
    (!s.canInstall || (s.supported && !s.busy && typeof s.version === 'string' && s.version.length > 0))
  );
}
