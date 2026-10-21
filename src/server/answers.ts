import { setTimeout as delay } from 'node:timers/promises';
import { ASK_KEYS, canAnswer, menuKeys, menuOnTextRow, menuTextKeys, readMenu, sameMenu, type AskWorker, type Menu } from '../shared/asks.js';

export interface AnswerHost {
  worker(): AskWorker | undefined;
  lines(): string[] | undefined;
  write(data: string): void;
  live(): boolean;
}

/** One answer at a time, including while the TUI is moving onto its typed-answer row. */
export class Answers {
  private busy = new Set<string>();
  private sent = new Map<string, Menu>();

  /** Called on authoritative status changes/removal, so a later turn may ask the same question. */
  changed(id: string, status?: string) {
    if (status !== 'needs_input') this.sent.delete(id);
  }

  async answer(id: string, shown: Menu, reply: { choice?: number; text?: string }, host: AnswerHost): Promise<string | undefined> {
    const current = () => {
      const worker = host.worker();
      const lines = host.lines();
      return host.live() && worker && canAnswer(worker, lines) ? readMenu(lines!) : undefined;
    };
    const now = current();
    if (this.busy.has(id) || sameMenu(this.sent.get(id), now)) return 'That question is already being answered. Check the terminal.';
    if (!sameMenu(shown, now) || !now) return 'The question changed or was already answered. Your answer was not sent.';
    this.busy.add(id);
    try {
      if (reply.choice !== undefined) {
        const choice = now.choices.find((c) => c.number === reply.choice);
        if (!choice) return 'That choice is no longer available.';
        host.write(menuKeys(now, choice));
      } else {
        const line = (reply.text ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (!line || /[\p{Cc}\p{Cf}]/u.test(line)) return 'Use ordinary text for this answer, or interact with the terminal.';
        if (!now.freeText) {
          const keys = menuTextKeys(now, line);
          if (!keys) return 'This menu cannot safely take a typed answer. Your text is kept; use the terminal.';
          // One write, matching Android replyKeys. The number or arrows open the row; splitting them would drop the text the shortcut already carries.
          host.write(keys);
        } else {
          const steps = Math.max(0, now.choices.length - (now.pointer ?? 0));
          host.write(ASK_KEYS.DOWN.repeat(steps));
          const until = Date.now() + 2500;
          while (Date.now() < until) {
            await delay(40);
            if (!sameMenu(now, current())) return 'The question changed. Your text is kept; check the terminal.';
            if (menuOnTextRow(host.lines() ?? [])) {
              host.write(line + ASK_KEYS.ENTER);
              this.sent.set(id, now);
              return undefined;
            }
          }
          if (sameMenu(now, current())) host.write(ASK_KEYS.UP.repeat(steps));
          return 'The typed-answer row could not be verified. Your text is kept; finish in the terminal.';
        }
      }
      this.sent.set(id, now);
      return undefined;
    } finally {
      this.busy.delete(id);
    }
  }
}
