import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** What the Edit menu and the context menu run on: the offscreen page. A menu role would target the focused window's contents, and the office window has none. */
export interface EditTarget {
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  pasteAndMatchStyle(): void;
  delete(): void;
  selectAll(): void;
}

/** The Edit menu, as the Mac app's menus have it, acting on whatever page `target` returns (nothing, before one exists). */
export function editMenu(target: () => EditTarget | undefined): MenuItemConstructorOptions {
  const run = (act: (t: EditTarget) => void) => () => {
    const t = target();
    if (t) act(t);
  };
  return {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: run((t) => t.undo()) },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: run((t) => t.redo()) },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: run((t) => t.cut()) },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: run((t) => t.copy()) },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: run((t) => t.paste()) },
      { label: 'Paste and Match Style', accelerator: 'Shift+Option+CmdOrCtrl+V', click: run((t) => t.pasteAndMatchStyle()) },
      { label: 'Delete', click: run((t) => t.delete()) },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: run((t) => t.selectAll()) },
    ],
  };
}

/** The part of Electron's `context-menu` params the menu is built from. */
export type ContextParams = Pick<ContextMenuParams, 'linkURL' | 'isEditable' | 'selectionText' | 'editFlags'>;

/** The menu for a right click the page did not handle itself: link actions, then the edit commands that apply. Empty when nothing applies. */
export function contextMenu(params: ContextParams, target: EditTarget, openLink: (url: string) => void, copyText: (text: string) => void): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const gap = () => items.length && items[items.length - 1]!.type !== 'separator' && items.push({ type: 'separator' });
  if (params.linkURL) {
    items.push({ label: 'Open Link in Browser', click: () => openLink(params.linkURL) }, { label: 'Copy Link Address', click: () => copyText(params.linkURL) });
  }
  const flags = params.editFlags;
  if (params.isEditable) {
    gap();
    items.push(
      { label: 'Undo', enabled: flags.canUndo, click: () => target.undo() },
      { label: 'Redo', enabled: flags.canRedo, click: () => target.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: flags.canCut, click: () => target.cut() },
      { label: 'Copy', enabled: flags.canCopy, click: () => target.copy() },
      { label: 'Paste', enabled: flags.canPaste, click: () => target.paste() },
      { label: 'Select All', enabled: flags.canSelectAll, click: () => target.selectAll() },
    );
  } else if (params.selectionText) {
    gap();
    items.push({ label: 'Copy', enabled: flags.canCopy, click: () => target.copy() });
  }
  return items;
}
