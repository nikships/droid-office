/** Where the update window is in its one flow: check, offer, download, install. */
export type UpdatePhase =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; transferred: number; total: number }
  | { kind: 'preparing'; version: string }
  | { kind: 'restarting'; version: string }
  | { kind: 'latest' }
  | { kind: 'error'; during: 'check'; message: string }
  | { kind: 'error'; during: 'download'; version: string; message: string }
  | { kind: 'unpackaged' };

export type UpdateAction = 'install' | 'later' | 'cancel' | 'retry' | 'close';

export const UPDATE_ACTIONS: readonly UpdateAction[] = ['install', 'later', 'cancel', 'retry', 'close'];

export interface UpdateButton {
  action: UpdateAction;
  label: string;
  primary?: boolean;
}

/** What the window's page draws; it has no logic of its own. */
export interface UpdateView {
  title: string;
  detail?: string;
  /** A fraction from 0 to 1, `'indeterminate'` for a busy bar, or no bar. */
  progress?: number | 'indeterminate';
  buttons: UpdateButton[];
  /** What Escape does; nothing while the update can't be stopped. */
  escape?: UpdateAction;
}

/**
 * An error short enough for the window: electron-updater's HTTP errors run on with response
 * headers and bodies, which the updates log keeps in full.
 */
export function briefError(message: string, max = 240): string {
  const first =
    message
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? 'Unknown error';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function updateView(phase: UpdatePhase, current: string): UpdateView {
  switch (phase.kind) {
    case 'checking':
      return { title: 'Checking for updates…', progress: 'indeterminate', buttons: [{ action: 'close', label: 'Cancel' }], escape: 'close' };
    case 'available':
      return {
        title: `Droid Office ${phase.version} is available`,
        detail: `You have ${current}. Installing restarts the app. Workers keep running, and the office picks them back up.`,
        buttons: [
          { action: 'later', label: 'Later' },
          { action: 'install', label: 'Install and Restart', primary: true },
        ],
        escape: 'later',
      };
    case 'downloading': {
      const fraction = phase.total > 0 ? Math.min(1, phase.transferred / phase.total) : 0;
      return {
        title: `Downloading Droid Office ${phase.version}…`,
        detail: phase.total > 0 ? `${megabytes(phase.transferred)} of ${megabytes(phase.total)} (${Math.floor(fraction * 100)}%)` : 'Starting the download…',
        progress: fraction,
        buttons: [{ action: 'cancel', label: 'Cancel' }],
        escape: 'cancel',
      };
    }
    case 'preparing':
      return { title: `Installing Droid Office ${phase.version}…`, detail: 'Checking the signature and getting the update ready.', progress: 'indeterminate', buttons: [] };
    case 'restarting':
      return { title: 'Restarting…', detail: 'Stopping the office. Your workers keep running.', progress: 'indeterminate', buttons: [] };
    case 'latest':
      return { title: "You're up to date", detail: `Droid Office ${current} is the newest version.`, buttons: [{ action: 'close', label: 'OK', primary: true }], escape: 'close' };
    case 'error':
      return {
        title: phase.during === 'check' ? "Couldn't check for updates" : `Droid Office ${phase.version} didn't install`,
        detail: phase.message,
        buttons: [
          { action: 'close', label: 'Close' },
          { action: 'retry', label: 'Try Again', primary: true },
        ],
        escape: 'close',
      };
    case 'unpackaged':
      return { title: 'Updates come with the packaged app', detail: 'This one runs from a checkout, so it runs whatever the checkout has.', buttons: [{ action: 'close', label: 'OK', primary: true }], escape: 'close' };
  }
}

/** True while the flow is doing something the window has to wait for. */
export function updateBusy(phase: UpdatePhase): boolean {
  return phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'preparing' || phase.kind === 'restarting';
}
