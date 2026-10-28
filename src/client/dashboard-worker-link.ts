import { linkStep, type LinkPlace, type WorkerLink } from './worker-link';

type LinkResult = { step: 'wait' } | { step: 'go' } | { step: 'failed' } | { step: 'open' | 'gone'; link: WorkerLink };

/** A pending companion link survives a reconnect, but never a refused send or a missing target. */
export class DashboardWorkerLink {
  private travelling = false;

  constructor(public pending?: WorkerLink) {}

  set(link: WorkerLink) {
    this.pending = link;
    this.travelling = false;
  }

  arrive() {
    this.travelling = false;
  }

  clear() {
    this.pending = undefined;
    this.travelling = false;
  }

  follow(here: LinkPlace, send: (floor: string) => boolean): LinkResult {
    const link = this.pending;
    if (!link || this.travelling) return { step: 'wait' };
    const step = linkStep(link, here);
    if (step === 'go') {
      this.travelling = true;
      if (send(link.floor!)) return { step: 'go' };
      this.clear();
      return { step: 'failed' };
    }
    this.clear();
    return { step, link };
  }
}
