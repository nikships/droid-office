import type { TextState } from './keys';

/** Pointer keys act on down; their later compatibility click must never act again. */
export class KeyActivations {
  constructor(private readonly activate: (id: string) => void) {}

  pointerDown(id: string): void {
    this.activate(id);
  }

  /** A zero-detail click is keyboard, assistive technology or programmatic activation. */
  click(id: string, detail: number): void {
    if (detail === 0) this.activate(id);
  }
}

export interface TextClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

/** System clipboard access can fail on HTTP or in a WebView; the panel retains a copy for Paste. */
export class PanelClipboard {
  private copied: string | null = null;

  async write(text: string, clipboard: TextClipboard | undefined): Promise<boolean> {
    this.copied = text;
    try {
      if (!clipboard) return false;
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Cut never removes the source until the system clipboard confirms the write. */
  async cut(text: string, clipboard: TextClipboard | undefined, remove: () => void): Promise<boolean> {
    const copied = await this.write(text, clipboard);
    if (copied) remove();
    return copied;
  }

  async read(clipboard: TextClipboard | undefined): Promise<{ text: string; system: boolean } | null> {
    try {
      if (clipboard) return { text: await clipboard.readText(), system: true };
    } catch {
      // The panel's own copy is usable even when system clipboard permission was refused.
    }
    return this.copied === null ? null : { text: this.copied, system: false };
  }
}

/** An asynchronous clipboard response must not replace text or a selection changed meanwhile. */
export function sameTextSelection(before: TextState, after: TextState): boolean {
  return before.value === after.value && before.start === after.start && before.end === after.end;
}
