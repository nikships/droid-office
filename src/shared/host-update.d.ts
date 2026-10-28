/** The packaged host's updater, not the Android app's own APK updater. */
export interface HostUpdateState {
  supported: boolean;
  currentVersion: string;
  phase: string;
  title: string;
  detail?: string;
  progress?: number;
  version?: string;
  busy: boolean;
  canInstall: boolean;
}

export type HostUpdateCommand = { action: 'status' | 'check' } | { action: 'install'; version: string };

export interface HostUpdateRequest {
  t: 'host.update';
  id: string;
  command: HostUpdateCommand;
}

export interface HostUpdateResponse {
  t: 'host.update.result';
  id: string;
  state?: HostUpdateState;
  error?: string;
}
