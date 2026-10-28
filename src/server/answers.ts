import { setTimeout as delay } from 'node:timers/promises';
import { ASK_KEYS, canAnswer, menuKeys, menuOnTextRow, menuTextKeys, menuTextRowEmpty, readMenu, sameMenu, type AskWorker, type Menu } from '../shared/asks.js';

export interface AnswerHost {
  worker(): AskWorker | undefined;
  lines(): string[] | undefined;
  menu?(): Menu | undefined;
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

  async answer(id: string, shown: Menu, reply: { choice?: number; choices?: number[]; text?: string }, host: AnswerHost): Promise<string | undefined> {
    const current = () => {
      const worker = host.worker();
      const lines = host.lines();
      return host.live() && worker && canAnswer(worker, lines) ? (host.menu ? host.menu() : readMenu(lines!)) : undefined;
    };
    const now = current();
    if (this.busy.has(id) || sameMenu(this.sent.get(id), now)) return 'That question is already being answered. Check the terminal.';
    if (!sameMenu(shown, now) || !now) return 'The question changed or was already answered. Your answer was not sent.';
    this.busy.add(id);
    try {
      if (now.multiSelect) {
        if (reply.choice !== undefined || (reply.choices === undefined && reply.text === undefined)) return 'Select the answers, then submit them together.';
        const numbers = reply.choices ?? now.choices.filter((choice) => choice.selected).map((choice) => choice.number);
        if (!Array.isArray(numbers) || new Set(numbers).size !== numbers.length || numbers.some((number) => !Number.isInteger(number) || !now.choices.some((choice) => choice.number === number)))
          return 'Those choices are no longer available.';
        const line = reply.text?.replace(/[\r\n]+/g, ' ').trim();
        if (reply.text !== undefined && (!line || /[\p{Cc}\p{Cf}]/u.test(line))) return 'Use ordinary text for this answer, or interact with the terminal.';
        if (!numbers.length && !line) return 'Select at least one answer.';
        if (!now.freeText) return 'This checkbox dialog cannot be verified safely. Finish in the terminal.';
        const waitFor = async (predicate: (menu: Menu) => boolean) => {
          const until = Date.now() + 2000;
          while (Date.now() < until) {
            const updated = current();
            if (!updated || !sameMenu(now, updated)) return false;
            if (predicate(updated)) return true;
            await delay(40);
          }
          return false;
        };
        const focus = async (target: number) => {
          const before = current();
          if (!before || !sameMenu(now, before) || before.pointer === undefined) return false;
          const delta = target - before.pointer;
          if (delta) host.write((delta < 0 ? ASK_KEYS.UP : ASK_KEYS.DOWN).repeat(Math.abs(delta)));
          return waitFor((menu) => menu.pointer === target);
        };
        // A response describes the complete answer, not text to append to a previous draft.
        if (!menuTextRowEmpty(host.lines() ?? [])) {
          if (!(await focus(now.choices.length)) || !menuOnTextRow(host.lines() ?? [])) return 'The typed-answer row could not be verified. Finish in the terminal.';
          host.write('\x01\x0b'); // AskUser's Ctrl+A / Ctrl+K: start of line, delete to end.
          if (!(await waitFor((menu) => menu.pointer === now.choices.length && menuTextRowEmpty(host.lines() ?? [])))) return 'The previous typed answer could not be cleared safely. Finish in the terminal.';
        }
        const desiredSelection = (menu: Menu | undefined) => sameMenu(now, menu) && menu!.choices.every((choice) => choice.selected === numbers.includes(choice.number));
        // Digits typed on the custom row would edit its text instead of toggling a checkbox.
        if (!(await focus(0))) return 'Keyboard focus could not be verified. Nothing was submitted; use the terminal.';
        // AskUser digits toggle without moving focus. Verify each change before the next key.
        for (const choice of now.choices) {
          const live = current();
          if (!sameMenu(now, live) || !live) return 'The question changed. Check the terminal before trying again.';
          const selected = numbers.includes(choice.number);
          if (live.choices.find((c) => c.number === choice.number)?.selected === selected) continue;
          host.write(String(choice.number));
          const verified = await waitFor((menu) => menu.choices.find((c) => c.number === choice.number)?.selected === selected);
          if (!verified) return 'The selection could not be verified. Nothing was submitted; check the terminal.';
        }
        if (line) {
          if (!(await focus(now.choices.length)) || !menuOnTextRow(host.lines() ?? [])) return 'The typed-answer row could not be verified. Finish in the terminal.';
          host.write(line + ASK_KEYS.ENTER);
          if (!(await waitFor((menu) => menu.pointer === now.choices.length + 1 && desiredSelection(menu)))) return 'The typed answer could not be verified. Finish in the terminal.';
          host.write(ASK_KEYS.ENTER);
        } else {
          if (!(await focus(now.choices.length + 1)) || !desiredSelection(current())) return 'The submit row or selection could not be verified. Nothing was submitted; finish in the terminal.';
          host.write(ASK_KEYS.ENTER);
        }
      } else if (reply.choices !== undefined) {
        return 'This question takes one answer, not a checkbox selection.';
      } else if (reply.choice !== undefined) {
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
