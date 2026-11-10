// The Orchestrator's controls that the office and both companions share.

import type { Net } from '../net';
import { toast } from './dom';
import { confirmDialog } from './prompt';

/** Stops the Orchestrator's turn: X at it, or Stop in its prompt box. */
export function stopOrchestrator(net: Net, name: string): void {
  if (net.send({ t: 'orchestrator.interrupt' })) toast(`✋ Stopping ${name}`);
}

/** Asks first, then starts the Orchestrator's conversation over. Its team keeps working and stays its team. */
export function newOrchestratorConversation(net: Net, done?: () => void): void {
  confirmDialog(
    'Start a new conversation?',
    'The Orchestrator forgets this conversation and starts fresh on your next prompt. Workers it hired keep working and stay on its team.',
    'New conversation',
    () =>
      void net.request({ t: 'orchestrator.reset' }).then((r) => {
        if (!r.ok) return toast(r.error ?? 'The office refused this.', 'warn');
        toast('New conversation. The Orchestrator starts fresh on your next prompt.', 'info');
        done?.();
      }),
  );
}
