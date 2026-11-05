// Buttons that tell a worker (docs/whiteboard.md, "Buttons that tell a worker"): when the owner's batch
// records the first press of a `data-wb-ping` button, the office types the button's message into the
// worker who last edited the card's page. The press sets `state.pinged[name]`, which keeps the button
// disabled until the worker deletes it; a press that can't reach anyone is taken back.

import type { WorkerInfo } from '../shared/protocol.js';
import { workerMessageVars } from '../shared/prompts.js';
import { buttonDelivery, buttonTarget, type ButtonDelivery } from '../shared/whiteboard-ping.js';
import { findCard, pinged, type ActionPing, type Board } from '../shared/whiteboard.js';
import { officePrompt, type PromptSource } from './prompts.js';

export interface ButtonPress {
  card: string;
  name: string;
  ping: ActionPing;
}

/** How the office gets a message to a worker (WorkerManager). */
export interface PressWorkers {
  tell(id: string, text: string): string | undefined;
  resume(id: string, text: string): string | undefined;
  hold(id: string, text: string): string | undefined;
}

export type PressOutcome = { ok: true; to: string; how: ButtonDelivery } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The presses in a batch, not applied yet, that may record a new ping: each button's first, unless
 * `board` has it sent already. Whether each did is checked again once the batch is in.
 */
export function freshPresses(board: Board, ops: readonly unknown[]): ButtonPress[] {
  const out: ButtonPress[] = [];
  for (const o of ops) {
    if (!isObj(o) || o.op !== 'state.action' || typeof o.card !== 'string' || typeof o.name !== 'string' || !isObj(o.ping) || typeof o.ping.text !== 'string') continue;
    const card = findCard(board, o.card);
    if ((card && pinged(card.state, o.name)) || out.some((p) => p.card === o.card && p.name === o.name)) continue;
    const label = typeof o.ping.label === 'string' ? o.ping.label.trim() : '';
    out.push({ card: o.card, name: o.name, ping: label ? { text: o.ping.text, label } : { text: o.ping.text } });
  }
  return out;
}

/** Types one recorded press into the worker who last edited its card's page, on `board` as it is after the batch. */
export function deliverPress(board: Board, press: ButtonPress, everyone: readonly WorkerInfo[], workers: PressWorkers, floor: string, prompts?: PromptSource): PressOutcome {
  const card = findCard(board, press.card);
  if (!card) return { ok: false, error: 'The card is gone.' };
  const target = buttonTarget(card, everyone);
  if (!target.ok) return { ok: false, error: target.reason };
  const w = everyone.find((x) => x.id === target.id);
  if (!w) return { ok: false, error: `${target.name} is no longer on this floor.` };
  const how = buttonDelivery(w);
  const button = press.ping.label || press.name;
  const message = press.ping.text.trim() || `The owner pressed “${button}”.`;
  const text = officePrompt(prompts, 'whiteboard.button', { floor, card: card.id, title: card.title, button, action: press.name, ...workerMessageVars(message) });
  const err = how === 'resume' ? workers.resume(w.id, text) : how === 'hold' ? workers.hold(w.id, text) : workers.tell(w.id, text);
  return err ? { ok: false, error: `${w.name}: ${err}` } : { ok: true, to: w.name, how };
}
