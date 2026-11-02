import type { HookSignal, OfficeTool, RunsOn } from '../types/content';

export const runsOn: RunsOn[] = [
  {
    id: 'local',
    name: 'This Mac',
    where: 'Desk · live terminal',
    tool: 'Droid CLI',
    body: 'A Droid session in a real terminal, in the floor’s checkout or a git worktree of its own.',
    does: ['Thread or live terminal', 'Its own branch and worktree', 'One-key pull requests'],
  },
  {
    id: 'cloud',
    name: 'Factory computer',
    where: 'Desk · Runs on',
    tool: 'Factory cloud',
    body: 'Pick Runs on when you hire. Its first message names the floor’s repository, the folder it starts in and the floor branch.',
    does: ['A fresh computer from an Environment', 'Or one of your own computers', 'Its Thread, with Stop, on web and Android'],
  },
  {
    id: 'tailnet',
    name: 'Bot on your tailnet',
    where: 'Desk · external',
    tool: 'Tailscale MCP',
    body: 'An outside bot, such as an OpenClaw agent, gets a desk and a key of its own. Only your Tailscale devices can reach it.',
    does: ['Add bot in Settings → Phone & web', 'Hires, visits, uses the Whiteboard', 'Reports its own status'],
  },
];

export const hookSignals: HookSignal[] = [
  { name: 'Status', note: 'working, needs input or done' },
  { name: 'Questions', note: 'the whole question, on web and Android' },
  { name: 'Todo progress', note: 'its TodoWrite list as a bar and 3/5' },
  { name: 'Notices', note: 'office news between tool calls' },
  { name: 'Refreshes', note: 'Changes, branch, boards and CI' },
];

export const todoDemo = {
  worker: 'Pixel',
  desk: 'desk 07',
  title: 'Refresh the marketing site',
  done: 3,
  total: 5,
  now: 'Screenshot the changed sections',
};

export const officeTools: OfficeTool[] = [
  { name: 'team_hire', note: 'hire a subagent to a desk' },
  { name: 'team', note: 'check on, message or dismiss them' },
  { name: 'team_report', note: 'a subagent reports to its lead' },
  { name: 'visit_message', note: 'tell, ask or hand over to a peer' },
  { name: 'whiteboard_card', note: 'put a page on the wall' },
  { name: 'whiteboard_read', note: 'read the board and your marks' },
  { name: 'office_inbox', note: 'a tailnet bot’s messages' },
];
