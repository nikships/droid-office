import { sameMenu, type Menu } from '../shared/asks';
import type { QuestionDraft } from './ui/question-workspace';

/** Unsent answers survive pane/floor remounts, never a different question or a lost connection. */
export class DashboardQuestionDrafts {
  private drafts = new Map<string, { menu: Menu; waitingSince?: number; sessionId?: string; draft: QuestionDraft }>();

  get(key: string, menu: Menu, waitingSince?: number, sessionId?: string): QuestionDraft {
    const previous = this.drafts.get(key);
    if (previous && previous.waitingSince === waitingSince && previous.sessionId === sessionId && sameMenu(previous.menu, menu)) return previous.draft;
    const draft: QuestionDraft = { text: '' };
    this.drafts.set(key, { menu, waitingSince, sessionId, draft });
    return draft;
  }

  forget(key: string) {
    this.drafts.delete(key);
  }

  clear() {
    this.drafts.clear();
  }
}

/** Answer receipts belong to one occurrence, not every future question with the same text. */
export class DashboardQuestion {
  private menu?: Menu;
  private waitingSince?: number;
  private sessionId?: string;
  revision = 0;
  answering = false;
  answered = false;

  sync(menu: Menu | undefined, waitingSince: number | undefined, sessionId?: string) {
    if (sessionId === this.sessionId && waitingSince === this.waitingSince && ((!menu && !this.menu) || sameMenu(menu, this.menu))) return;
    this.menu = menu;
    this.waitingSince = waitingSince;
    this.sessionId = sessionId;
    this.revision++;
    this.answering = false;
    this.answered = false;
  }
}
