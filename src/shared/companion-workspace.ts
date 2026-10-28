export type CompanionView = 'thread' | 'terminal';
export interface CompanionPane {
  workerId: string;
  view: CompanionView;
  size: number;
}
export interface CompanionDraft {
  text: string;
  attachments: string[];
}
export interface FloorWorkspace {
  panes: CompanionPane[];
  active: string;
  drafts: Record<string, CompanionDraft>;
  collapsed: string[];
}
export interface CompanionWorkspace {
  floors: Record<string, FloorWorkspace>;
  /** Changes only on actual connection loss, not a deliberate floor switch. */
  epoch: number;
}
export const MAX_COMPANION_PANES = 4;
export function emptyFloorWorkspace(): FloorWorkspace {
  return { panes: [], active: '', drafts: {}, collapsed: [] };
}
export function createCompanionWorkspace(): CompanionWorkspace {
  return { floors: {}, epoch: 0 };
}
export function companionFloorWorkspace(state: CompanionWorkspace, floor: string): FloorWorkspace {
  return Object.hasOwn(state.floors, floor) ? state.floors[floor]! : emptyFloorWorkspace();
}
export type WorkspaceAction =
  | { type: 'open'; floor: string; workerId: string; pin?: boolean }
  | { type: 'close'; floor: string; workerId: string }
  | { type: 'focus'; floor: string; workerId: string }
  | { type: 'view'; floor: string; workerId: string; view: CompanionView }
  | { type: 'resize'; floor: string; workerId: string; size: number }
  | { type: 'draft'; floor: string; workerId: string; draft: CompanionDraft }
  | { type: 'collapse'; floor: string; workerId: string }
  | { type: 'reconcile'; floor: string; workerIds: readonly string[] }
  | { type: 'disconnect' };

/** No sends or replay queue: this model holds only local view state and unsent drafts. */
export function reduceCompanionWorkspace(state: CompanionWorkspace, action: WorkspaceAction): CompanionWorkspace {
  if (action.type === 'disconnect') return { epoch: state.epoch + 1, floors: Object.fromEntries(Object.entries(state.floors).map(([id, value]) => [id, { ...value, drafts: {} }])) };
  const current = companionFloorWorkspace(state, action.floor);
  let next = current;
  const id = 'workerId' in action ? action.workerId : '';
  switch (action.type) {
    case 'open': {
      if (!id) return state;
      if (current.panes.some((p) => p.workerId === id)) next = { ...current, active: id };
      else if (action.pin && current.panes.length >= MAX_COMPANION_PANES) return state;
      else {
        const pane: CompanionPane = { workerId: id, view: 'thread', size: 1 };
        const panes = [...current.panes];
        if (action.pin || !panes.length) panes.push(pane);
        else
          panes[
            Math.max(
              0,
              panes.findIndex((p) => p.workerId === current.active),
            )
          ] = pane;
        next = { ...current, panes, active: id };
      }
      break;
    }
    case 'close': {
      const panes = current.panes.filter((p) => p.workerId !== id);
      next = { ...current, panes, active: current.active === id ? (panes[0]?.workerId ?? '') : current.active };
      break;
    }
    case 'focus':
      if (!id || current.panes.some((p) => p.workerId === id)) next = { ...current, active: id };
      break;
    case 'view':
      next = { ...current, panes: current.panes.map((p) => (p.workerId === id ? { ...p, view: action.view } : p)) };
      break;
    case 'resize':
      if (Number.isFinite(action.size)) next = { ...current, panes: current.panes.map((p) => (p.workerId === id ? { ...p, size: Math.min(4, Math.max(0.25, action.size)) } : p)) };
      break;
    case 'draft':
      next = { ...current, drafts: { ...current.drafts, [id]: { text: action.draft.text, attachments: [...action.draft.attachments] } } };
      break;
    case 'collapse':
      next = { ...current, collapsed: current.collapsed.includes(id) ? current.collapsed.filter((v) => v !== id) : [...current.collapsed, id] };
      break;
    case 'reconcile': {
      const valid = new Set(action.workerIds);
      const panes = current.panes.filter((p) => valid.has(p.workerId));
      next = {
        ...current,
        panes,
        active: !current.active || panes.some((p) => p.workerId === current.active) ? current.active : (panes[0]?.workerId ?? ''),
        collapsed: current.collapsed.filter((v) => valid.has(v)),
        drafts: Object.fromEntries(Object.entries(current.drafts).filter(([key]) => valid.has(key))),
      };
      break;
    }
  }
  return { ...state, floors: { ...state.floors, [action.floor]: next } };
}

/** Persist layouts only. Drafts and attachment handles must never survive a new connection. */
export function companionWorkspaceLayout(state: CompanionWorkspace): CompanionWorkspace {
  return { ...state, floors: Object.fromEntries(Object.entries(state.floors).map(([id, value]) => [id, { ...value, drafts: {} }])) };
}

/** Storage is untrusted: restore bounded, distinct panes, never drafts or a connection epoch. */
export function restoreCompanionWorkspace(value: unknown): CompanionWorkspace {
  if (!value || typeof value !== 'object' || !('floors' in value) || !value.floors || typeof value.floors !== 'object' || Array.isArray(value.floors)) return createCompanionWorkspace();
  const floors = value.floors as Record<string, unknown>;
  const restored: [string, FloorWorkspace][] = [];
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
  let scanned = 0;
  for (const floor in floors) {
    if (scanned++ >= 200) break;
    if (!Object.hasOwn(floors, floor) || !validId(floor)) continue;
    const saved = floors[floor];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !('panes' in saved) || !Array.isArray(saved.panes)) continue;
    const next = emptyFloorWorkspace();
    // Bound invalid entries too, rather than scanning until four valid panes eventually appear.
    for (const pane of saved.panes.slice(0, 100)) {
      if (!pane || typeof pane !== 'object' || !validId(pane.workerId) || next.panes.some((p) => p.workerId === pane.workerId)) continue;
      next.panes.push({
        workerId: pane.workerId,
        view: pane.view === 'terminal' ? 'terminal' : 'thread',
        size: typeof pane.size === 'number' && Number.isFinite(pane.size) ? Math.min(4, Math.max(0.25, pane.size)) : 1,
      });
      next.active = pane.workerId;
      if (next.panes.length === MAX_COMPANION_PANES) break;
    }
    if ('active' in saved && (saved.active === '' || (validId(saved.active) && next.panes.some((p) => p.workerId === saved.active)))) next.active = saved.active;
    if ('collapsed' in saved && Array.isArray(saved.collapsed)) next.collapsed = [...new Set(saved.collapsed.slice(0, 500).filter(validId))];
    restored.push([floor, next]);
  }
  return { floors: Object.fromEntries(restored), epoch: 0 };
}
