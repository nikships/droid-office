import type { HostUpdateCommand, HostUpdateState } from '../shared/host-update.js';
import { briefError, type UpdateAction, type UpdatePhase, updateBusy, updateView } from './update-view.js';

export interface UpdateBackend {
  enabled: boolean;
  currentVersion: string;
  check: () => Promise<string | undefined>;
  /** Resolves only after the native updater has verified the signature. */
  download: (version: string, preparing: () => void) => { promise: Promise<void>; cancel: () => void };
  beforeInstall: () => Promise<void>;
  quitAndInstall: () => void;
  render: (phase: UpdatePhase, open: boolean) => void;
  close: () => void;
}

/** One updater shared by the native window and authenticated companion clients. */
export class UpdateController {
  private phase?: UpdatePhase;
  private local = false;
  private generation = 0;
  private download?: { cancel: () => void };
  private dismissed = new Set<string>();

  constructor(private readonly backend: UpdateBackend) {}

  get state(): HostUpdateState {
    const phase = this.phase ?? (this.backend.enabled ? undefined : { kind: 'unpackaged' as const });
    const view = phase ? updateView(phase, this.backend.currentVersion) : { title: 'Host desktop app', detail: 'Check for updates to the Mac app that runs this office.' };
    return {
      supported: this.backend.enabled,
      currentVersion: this.backend.currentVersion,
      phase: phase?.kind ?? 'idle',
      title: view.title,
      detail: view.detail,
      progress: 'progress' in view && typeof view.progress === 'number' ? view.progress : undefined,
      version: phase && 'version' in phase ? phase.version : undefined,
      busy: !!phase && updateBusy(phase),
      canInstall: phase?.kind === 'available' || (phase?.kind === 'error' && phase.during === 'download'),
    };
  }

  remote(command: HostUpdateCommand): HostUpdateState {
    if (command.action === 'check') void this.check(true, true);
    else if (command.action === 'install') {
      if (!this.backend.enabled || !this.state.canInstall || this.state.version !== command.version) throw new Error('The offered update changed. Check for updates again before installing.');
      void this.install(command.version);
    }
    return this.state;
  }

  async check(manual: boolean, remote = false) {
    if (this.phase && updateBusy(this.phase)) {
      if (manual && !remote) {
        this.local = true;
        this.show(this.phase);
      }
      return;
    }
    if (!manual && this.local) return;
    if (!remote) this.local = manual;
    if (!this.backend.enabled) {
      if (manual) this.show({ kind: 'unpackaged' });
      return;
    }
    const generation = ++this.generation;
    this.show({ kind: 'checking' });
    try {
      const version = await this.backend.check();
      if (generation !== this.generation) return;
      if (!version) {
        this.show({ kind: 'latest' });
        return;
      }
      if (!manual && this.dismissed.has(version)) {
        this.show({ kind: 'available', version });
        return;
      }
      if (!manual) this.local = true;
      this.show({ kind: 'available', version });
    } catch (err) {
      if (generation === this.generation) this.show({ kind: 'error', during: 'check', message: briefError(String((err as Error)?.message ?? err)) });
    }
  }

  progress(transferred: number, total: number) {
    if (this.phase?.kind === 'downloading') this.show({ ...this.phase, transferred, total });
  }

  act(action: UpdateAction) {
    const phase = this.phase;
    if (!phase) return;
    if (action === 'install' && phase.kind === 'available') void this.install(phase.version);
    else if (action === 'later' && phase.kind === 'available') {
      this.dismissed.add(phase.version);
      this.backend.close();
    } else if (action === 'retry' && phase.kind === 'error') {
      if (phase.during === 'download') void this.install(phase.version);
      else void this.check(true);
    } else if (action === 'cancel' || action === 'close') this.backend.close();
  }

  closed() {
    this.local = false;
    // Native signature verification/restart cannot be cancelled once the download is handed off.
    if (this.phase?.kind === 'preparing' || this.phase?.kind === 'restarting') return;
    ++this.generation;
    this.download?.cancel();
    this.download = undefined;
    if (this.phase?.kind !== 'available' && this.phase?.kind !== 'latest' && this.phase?.kind !== 'error') this.phase = undefined;
  }

  private async install(version: string) {
    const generation = ++this.generation;
    this.show({ kind: 'downloading', version, transferred: 0, total: 0 });
    try {
      const download = this.backend.download(version, () => {
        if (generation === this.generation) this.show({ kind: 'preparing', version });
      });
      this.download = download;
      await download.promise;
      if (generation !== this.generation) return;
      this.download = undefined;
      this.show({ kind: 'restarting', version });
      await this.backend.beforeInstall().catch(() => {});
      this.backend.quitAndInstall();
    } catch (err) {
      if (generation !== this.generation) return;
      this.download = undefined;
      this.show({ kind: 'error', during: 'download', version, message: briefError(String((err as Error)?.message ?? err)) });
    }
  }

  private show(phase: UpdatePhase) {
    this.phase = phase;
    this.backend.render(phase, this.local);
  }
}
