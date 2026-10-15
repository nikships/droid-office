// CommonJS (.cts emits .cjs): a sandboxed preload can't be an ES module.
// The office page runs in an offscreen window the native Metal presenter shows; this is the page's only line to the app.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('droidOfficeNative', {
  presenter: {
    /** Native presentation numbers since the last reset (see `PresenterReport` in presenter-model.ts). */
    stats: (reset: boolean, plannedMs: number, samples: boolean) => ipcRenderer.invoke('presenter:stats', reset, plannedMs, samples),
    /** The page's HDR output is on (brighter than white): the layer asks the display for headroom only then. */
    setHdr: (on: boolean) => ipcRenderer.send('presenter:hdr', on),
  },
});
