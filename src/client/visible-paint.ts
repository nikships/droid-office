/** Coalesce live state changes into one visible frame, retaining only an invalidation while hidden. */
export class VisiblePaint {
  private frame: number | undefined;
  private dirty = false;

  constructor(
    private readonly visible: () => boolean,
    private readonly draw: () => void,
    private readonly request: (callback: () => void) => number,
    private readonly cancel: (frame: number) => void,
  ) {}

  schedule() {
    this.dirty = true;
    if (!this.visible() || this.frame !== undefined) return;
    this.frame = this.request(() => {
      this.frame = undefined;
      this.flush();
    });
  }

  /** User actions still paint synchronously, so their subsequent focus lands in the new pane. */
  now() {
    this.dirty = true;
    this.flush();
  }

  visibilityChanged() {
    if (!this.visible() && this.frame !== undefined) {
      this.cancel(this.frame);
      this.frame = undefined;
    }
    this.flush();
  }

  private flush() {
    if (!this.visible() || !this.dirty) return;
    if (this.frame !== undefined) this.cancel(this.frame);
    this.frame = undefined;
    this.dirty = false;
    this.draw();
  }
}
