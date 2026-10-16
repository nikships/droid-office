import type { AutoHealStep, BoardAgent, VideoBrief } from '../types/content';

export const boardAgents: BoardAgent[] = [
  {
    id: 'issues',
    name: 'Issues agent',
    station: 'Kiosk · Issues board',
    tool: 'gh / glab',
    body: 'Keeps the issue board in order so you don’t have to.',
    does: ['Files new issues', 'Triages and labels', 'Closes what’s done'],
  },
  {
    id: 'pr',
    name: 'PR agent',
    station: 'Kiosk · PR board',
    tool: 'gh / glab',
    body: 'Reads every pull request or merge request on the wall.',
    does: ['Summarises changes', 'Reviews and comments', 'Merges when ready'],
  },
  {
    id: 'pipeline',
    name: 'Pipeline agent',
    station: 'Kiosk · Pipelines board',
    tool: 'Actions / GitLab CI',
    body: 'Watches CI and acts on it when you ask.',
    does: ['Runs workflows', 'Watches and re-runs', 'Auto-heals red runs'],
  },
  {
    id: 'lead',
    name: 'Team lead',
    station: 'Team kiosk',
    tool: 'up to 8 subagents',
    body: 'Splits a big job into parts and hires real workers to do them.',
    does: ['Plans the split', 'Hires subagents to desks', 'Reviews their reports'],
  },
];

export const autoHealSteps: AutoHealStep[] = [
  { time: '14:02:11', actor: 'ci / test', message: 'main #482 failed in auth.spec.ts', status: 'failed' },
  { time: '14:02:13', actor: 'pipeline agent', message: 'woke up, reading job logs', status: 'running' },
  { time: '14:03:40', actor: 'pipeline agent', message: 'root cause: session token expiry off by one', status: 'success' },
  { time: '14:03:42', actor: 'desk 07', message: 'hired fixer on fix/token-expiry', status: 'running' },
  { time: '14:09:05', actor: 'desk 07', message: 'pushed fix, opened PR !231', status: 'success' },
  { time: '14:12:27', actor: 'ci / test', message: 'main #483 passed', status: 'success' },
];

export const autoHealVideo: VideoBrief = {
  slot: 'auto-heal',
  title: 'Auto-heal: a red run wakes the Pipeline agent',
  duration: '0:30',
  shows: [
    'A run on the Pipelines board turns red while Auto-heal is on for the floor.',
    'The Pipeline agent at the kiosk wakes and reads the failed job.',
    'It names the root cause, then a new fixer worker sits down at a desk.',
    'The fix lands as a PR card, and the next run on the board goes green.',
  ],
};

export const teamLeadVideo: VideoBrief = {
  slot: 'team-lead',
  title: 'A team lead splitting one job across desks',
  duration: '0:25',
  shows: [
    'Hire a team lead at the Team kiosk and give it one large task.',
    'The lead posts its plan, then four subagents walk in and sit at separate desks.',
    'Quick cuts between the subagents’ live terminals working in parallel.',
    'The lead collects the reports and marks the job done.',
  ],
};
