import type { StationKind } from '../../shared/layout';

/** What each board agent offers at its kiosk, in the 3D office and in the companion. */
export const STATION_INFO: Record<StationKind, { icon: string; offer: string; does: string; example: string }> = {
  issues: { icon: '📌', offer: 'Ask me about issues', does: 'I file, find, triage, label and close them', example: 'File an issue: the bean bag walks straight through the jukebox' },
  pulls: { icon: '🔀', offer: 'Ask me about PRs', does: 'I sum up, review, comment on and merge them', example: 'Review the newest PR and tell me if it’s ready to merge' },
  actions: { icon: '🚀', offer: 'Ask me about CI', does: 'I kick off pipelines, re-run failures and explain what broke', example: 'Kick off the release workflow on main and tell me when it’s done' },
  lead: { icon: '🧭', offer: 'Give me a big job', does: 'I split it up and hire a team of subagents at the desks', example: 'Add dark mode: one subagent on the settings, one on the styles, one on the tests' },
};
