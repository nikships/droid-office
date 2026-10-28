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
  const current = state.floors[action.floor] ?? emptyFloorWorkspace();
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
        active: valid.has(current.active) ? current.active : (panes[0]?.workerId ?? ''),
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
