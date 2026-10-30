import { LAYOUT_ORDER, type LayoutMode } from './dashboard-workspace';

export type WorkspaceCommand = { action: 'layout'; mode: LayoutMode } | { action: 'maximize' | 'hire' | 'board' | 'sidebar' } | { action: 'pane' | 'worker'; direction: -1 | 1 };

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented' | 'repeat' | 'preventDefault' | 'stopImmediatePropagation'>;

export const WORKSPACE_KEY_HINTS: [string, string][] = [
  ['⌘ 1–4', 'layout'],
  ['⌘ ↵', 'maximize / restore'],
  ['⌘ ← →', 'panes'],
  ['⌘ ↑ ↓', 'workers'],
  ['⌘ N', 'hire'],
  ['⌘ B', 'board'],
  ['⌘ \\', 'sidebar'],
];

/** Only Command chords belong to the workspace. All CLI and editing keys pass through. */
export function workspaceCommand(e: ShortcutEvent): WorkspaceCommand | undefined {
  if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
  const mode = LAYOUT_ORDER[Number(e.key) - 1];
  if (/^[1-4]$/.test(e.key) && mode) return { action: 'layout', mode };
  switch (e.key.toLowerCase()) {
    case 'enter':
      return { action: 'maximize' };
    case 'arrowleft':
    case 'arrowright':
      return { action: 'pane', direction: e.key === 'ArrowLeft' ? -1 : 1 };
    case 'arrowup':
    case 'arrowdown':
      return { action: 'worker', direction: e.key === 'ArrowUp' ? -1 : 1 };
    case 'n':
      return { action: 'hire' };
    case 'b':
      return { action: 'board' };
    case '\\':
      return { action: 'sidebar' };
  }
}

/** Run in window capture, before xterm or a composer can consume or send the chord. */
export function workspaceShortcut(e: ShortcutEvent, run: (command: WorkspaceCommand) => void): boolean {
  const command = workspaceCommand(e);
  if (!command) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!e.repeat) run(command);
  return true;
}
