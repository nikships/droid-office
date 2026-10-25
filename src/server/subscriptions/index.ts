import type { ClientMsg } from '../../shared/protocol.js';
import { emptySubscriptionsState, modelAvailability, type ModelAvailability, type SubscriptionsState } from '../../shared/subscriptions.js';

/** The subscriptions.* messages a client sends (see protocol.ts). */
export type SubscriptionsMsg = Extract<
  ClientMsg,
  { t: 'subscriptions.proxy' | 'subscriptions.connect' | 'subscriptions.connectCancel' | 'subscriptions.disconnect' | 'subscriptions.provider' | 'subscriptions.models' | 'subscriptions.refresh' }
>;

export interface SubscriptionsOptions {
  /** The office's .droid-office. */
  dataDir: string;
  /** Subscriptions changed: to everyone. */
  broadcast(state: SubscriptionsState): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** DroidProxy rewrote its models in Droid's settings: the office reads Droid's model list again. */
  modelsChanged(): void;
}

export interface Subscriptions {
  state(): SubscriptionsState;
  /** Handles a subscriptions.* message from `who`. */
  message(who: string, msg: SubscriptionsMsg): void;
  /** Whether `model` can run now, as last known; undefined when it isn't a subscription model or nobody can tell. */
  availability(model: string | undefined): ModelAvailability | undefined;
  /**
   * Why a worker on `model` can't start now, in words for whoever hired it; undefined when it can,
   * or when nobody can tell. Synchronous, from the last known state. A stopped DroidProxy doesn't
   * refuse the hire: this starts it.
   */
  gate(model: string | undefined): string | undefined;
  stop(): void;
}

/**
 * DroidProxy and the subscriptions it serves (docs/subscriptions.md). server.ts calls only this.
 */
export function mountSubscriptions(_opts: SubscriptionsOptions): Subscriptions {
  const state = emptySubscriptionsState();
  return {
    state: () => state,
    message: () => {},
    availability: (model) => modelAvailability(state, model),
    gate: () => undefined,
    stop: () => {},
  };
}
