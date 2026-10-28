/** A picture chosen for a prompt: going up to the office, or up and waiting to be sent. */
export interface StagedImage<F> {
  /** Local and opaque: what drafts keep, valid only in this page. */
  readonly handle: string;
  readonly file: F;
  /** Where the office keeps it. */
  readonly floor: string;
  /** The office's id, once it's up. */
  id?: string;
  /** Resolves once the upload settles, whether it worked or not. */
  readonly settled: Promise<void>;
}

interface Entry<F> extends StagedImage<F> {
  removed: boolean;
  /** A draft outside any mounted box holds it: only the draft's owner takes it out. */
  kept: boolean;
}

export interface StagingApi<F> {
  upload(floor: string, file: F): Promise<string>;
  /** Takes a staged picture out on the office. Best effort. */
  forget(floor: string, id: string): void;
}

/**
 * Pictures by local handle, so a draft keeps a picture across remounts and floor switches even
 * while it's still going up. Taking one out before its id arrives takes it out once the id does.
 */
export class ImageStaging<F> {
  private entries = new Map<string, Entry<F>>();
  private next = 0;

  constructor(private api: StagingApi<F>) {}

  stage(floor: string, file: F, onFail?: (error: Error) => void): StagedImage<F> {
    const handle = `img-${++this.next}`;
    let entry!: Entry<F>;
    const settled = this.api.upload(floor, file).then(
      (id) => {
        if (entry.removed) return this.api.forget(floor, id);
        entry.id = id;
      },
      (err: Error) => {
        if (entry.removed) return;
        this.entries.delete(handle);
        onFail?.(err);
      },
    );
    entry = { handle, file, floor, settled, removed: false, kept: false };
    this.entries.set(handle, entry);
    return entry;
  }

  get(handle: string): StagedImage<F> | undefined {
    return this.entries.get(handle);
  }

  /** The box showing it is going away but its draft lives on. */
  keep(handle: string) {
    const entry = this.entries.get(handle);
    if (entry) entry.kept = true;
  }

  /** A box shows it again. */
  adopt(handle: string): StagedImage<F> | undefined {
    const entry = this.entries.get(handle);
    if (entry) entry.kept = false;
    return entry;
  }

  /** Thrown away: never sent. */
  remove(handle: string) {
    const entry = this.entries.get(handle);
    if (!entry) return;
    entry.removed = true;
    this.entries.delete(handle);
    if (entry.id) this.api.forget(entry.floor, entry.id);
  }

  /** Sent with a prompt: the office owns it now. */
  take(handle: string): string | undefined {
    const entry = this.entries.get(handle);
    this.entries.delete(handle);
    return entry?.id;
  }

  /** The connection was lost: every picture a draft kept goes. */
  removeKept() {
    for (const entry of [...this.entries.values()]) if (entry.kept) this.remove(entry.handle);
  }

  get size() {
    return this.entries.size;
  }
}
