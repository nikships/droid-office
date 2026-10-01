/** Source reload is a separate HTTP channel so a broken game bundle can still recover. */
export interface HotReloadState {
  available: boolean;
  reason?: string;
  enabled: boolean;
  phase: 'idle' | 'building' | 'error';
  revision: string;
  error?: string;
  restartRequired: boolean;
  lastBuiltAt?: number;
}
