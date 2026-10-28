/** What one successful send took out of a draft: the composer text as it was, and the pictures sent. */
export interface SubmittedDraft {
  /** The composer's text exactly as kept in the draft when the send went out. */
  text: string;
  /** The opaque picture handles that went with it. */
  attachments: string[];
}

export interface DraftLike {
  text: string;
  attachments: readonly string[];
}

/**
 * A kept draft after a send of it succeeded: only the pictures that went are taken out, and the text
 * only if nobody changed it since. A send that lands after its view went away must never overwrite
 * what a newer view of the same draft has added.
 */
export function acknowledgeDraft<D extends DraftLike>(draft: D, sent: SubmittedDraft): D {
  const gone = new Set(sent.attachments);
  const attachments = draft.attachments.filter((handle) => !gone.has(handle));
  const text = draft.text === sent.text ? '' : draft.text;
  if (text === draft.text && attachments.length === draft.attachments.length) return draft;
  return { ...draft, text, attachments };
}

/** Successful sends by draft key, so another mounted view of the same draft can acknowledge one. */
export class SubmittedDrafts {
  private listeners = new Map<string, Set<(sent: SubmittedDraft) => void>>();

  on(key: string, fn: (sent: SubmittedDraft) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  /** Tells every listener on `key` but `from` (the view that sent it, which acknowledged itself). */
  emit(key: string, sent: SubmittedDraft, from?: (sent: SubmittedDraft) => void) {
    for (const fn of [...(this.listeners.get(key) ?? [])]) if (fn !== from) fn(sent);
  }

  get size() {
    return this.listeners.size;
  }
}
