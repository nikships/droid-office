import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isAgentEffort, type AgentChoice, type PromptsState } from '../shared/protocol.js';
import { PROMPTS, PROMPT_MAX, fillPrompt, isPromptId, promptText, type PromptId, type PromptVars } from '../shared/prompts.js';
import { validateWorkerEffort, validateWorkerModel } from './agents.js';

/** What the floors read: a prompt as the office has it now, and what droids start on. */
export interface PromptSource {
  text(id: PromptId): string;
  /** The droid picked in Settings, when one was. */
  agent(): AgentChoice | undefined;
}

/** A prompt's text, from `source` when there is one, else the default. */
export function officePrompt(source: PromptSource | undefined, id: PromptId, vars: PromptVars = {}): string {
  return fillPrompt(source ? source.text(id) : PROMPTS[id].text, vars);
}

/** Why the office can't start `c` as a droid, if it can't. */
export function agentChoiceProblem(c: AgentChoice): string | undefined {
  return validateWorkerModel('agent', c.model) ?? validateWorkerEffort('agent', c.effort);
}

/**
 * The prompts the office writes for droids by itself (shared/prompts.ts), as rewritten in
 * Settings, and the model and effort a droid starts on when whoever starts it doesn't pick one. The same for the whole building, kept in .droid-office/prompts.json.
 */
export class OfficePrompts implements PromptSource {
  private saved: PromptsState = { custom: {} };
  private path: string;

  constructor(
    dataDir: string,
    private onState: (state: PromptsState) => void,
  ) {
    this.path = path.join(dataDir, 'prompts.json');
    this.restore();
  }

  state(): PromptsState {
    return { custom: { ...this.saved.custom }, ...(this.saved.agent ? { agent: { ...this.saved.agent } } : {}) };
  }

  text(id: PromptId): string {
    return promptText(this.saved.custom, id);
  }

  agent(): AgentChoice | undefined {
    const a = this.saved.agent;
    return a && { ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}) };
  }

  /** Rewrites a prompt; `text` null (or the default's own text) puts the default back. Returns why it can't, if it can't. */
  setPrompt(id: unknown, text: string | null, by: string): string | undefined {
    if (!isPromptId(id)) return 'Unknown prompt';
    const def = PROMPTS[id];
    const clean = text === null ? null : text.replace(/\r\n?/g, '\n').trim();
    if (clean !== null && clean.length > PROMPT_MAX) return `A prompt can be ${PROMPT_MAX.toLocaleString('en-US')} characters at most`;
    if (clean === '' && !def.optional) return 'That prompt can’t be empty: write something, or put the default back';
    if (clean === null || clean === def.text) delete this.saved.custom[id];
    else this.saved.custom[id] = { text: clean, by, at: Date.now() };
    this.changed();
    return undefined;
  }

  /** Picks the droid a new one starts on when nobody picks; null goes back to Droid's own default. */
  setAgent(choice: AgentChoice | null, by: string): string | undefined {
    if (!choice) {
      delete this.saved.agent;
      this.changed();
      return undefined;
    }
    const why = this.problem(choice);
    if (why) return why;
    this.saved.agent = { ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}), by, at: Date.now() };
    this.changed();
    return undefined;
  }

  private problem(c: AgentChoice): string | undefined {
    return agentChoiceProblem(c);
  }

  private changed() {
    this.persist();
    this.onState(this.state());
  }

  private restore() {
    let raw: Partial<PromptsState>;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return; // never changed: the defaults
    }
    for (const [id, v] of Object.entries(raw?.custom ?? {})) {
      if (!isPromptId(id) || typeof v?.text !== 'string') continue;
      this.saved.custom[id] = { text: v.text.slice(0, PROMPT_MAX), by: typeof v.by === 'string' ? v.by : 'someone', at: typeof v.at === 'number' ? v.at : 0 };
    }
    const a = raw?.agent as (Partial<AgentChoice> & { by?: unknown; at?: unknown }) | undefined;
    if (a) {
      const choice: AgentChoice = { model: typeof a.model === 'string' ? a.model : undefined, effort: isAgentEffort(a.effort) ? a.effort : undefined };
      if (!this.problem(choice)) this.saved.agent = { ...choice, by: typeof a.by === 'string' ? a.by : 'someone', at: typeof a.at === 'number' ? a.at : 0 };
    }
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
