// CommonJS (.cts emits .cjs): a sandboxed preload can't be an ES module.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('droidUpdate', {
  act: (action: string) => ipcRenderer.send('update:action', action),
  height: (px: number) => ipcRenderer.send('update:height', px),
  onView: (fn: (view: unknown) => void) => {
    ipcRenderer.on('update:view', (_e, view) => fn(view));
  },
});
