import type { ClientMsg } from '../../shared/protocol.js';
import { emptySetupState, type SetupState } from '../../shared/setup.js';
import { resolveAgent } from '../workers.js';

/** The setup.* messages a client sends (see protocol.ts). */
export type SetupMsg = Extract<ClientMsg, { t: 'setup.check' | 'setup.droid.install' | 'setup.droid.signIn' | 'setup.droid.signInCancel' | 'setup.onboarded' }>;

export interface SetupOptions {
  /** The office's .droid-office, where setup.json keeps whether the welcome is done. */
  dataDir: string;
  /** The agent command (--agent, DROID_OFFICE_AGENT): 'droid' unless the owner named another. */
  agentCmd: string;
  /** Setup changed: to everyone. */
  broadcast(state: SetupState): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** Droid was installed (or found somewhere new): every floor runs it from `path` from now on. */
  agentChanged(path: string): void;
}

export interface Setup {
  state(): SetupState;
  /** Handles a setup.* message from `who`. */
  message(who: string, msg: SetupMsg): void;
  stop(): void;
}

/**
 * Droid installed and signed in, and the welcome (docs/subscriptions.md). server.ts calls only this.
 */
export function mountSetup(opts: SetupOptions): Setup {
  const path = resolveAgent(opts.agentCmd);
  const state: SetupState = { ...emptySetupState(), droid: { ...emptySetupState().droid, path, busy: null } };
  return {
    state: () => state,
    message: () => {},
    stop: () => {},
  };
}
