import { fileURLToPath } from 'node:url';
import { type BaseWindow, BrowserWindow, type IpcMainEvent, ipcMain } from 'electron';
import { UPDATE_ACTIONS, type UpdateAction, type UpdateView } from './update-view.js';

const WIDTH = 440;
const PRELOAD = fileURLToPath(new URL('./update-preload.cjs', import.meta.url));

const PAGE = `<!doctype html><meta charset="utf-8"><title>Software Update</title>
<style>
:root{color-scheme:dark}
html,body{margin:0;background:#111;color:#e8e8e8;font:13px -apple-system,system-ui,sans-serif;-webkit-user-select:none;user-select:none;cursor:default;overflow:hidden}
main{padding:20px 22px 18px}
.label{font:600 11px ui-monospace,monospace;letter-spacing:.2em;color:#ef6f2e}
h1{font-size:15px;font-weight:600;margin:10px 0 6px}
p{color:#9a9a9a;margin:0;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.bar{position:relative;height:6px;border-radius:3px;background:#2a2a2a;overflow:hidden;margin-top:14px}
.fill{position:absolute;inset:0 auto 0 0;width:0;background:#ef6f2e;border-radius:3px;transition:width .2s}
.indeterminate .fill{width:30%;transition:none;animation:slide 1.2s ease-in-out infinite}
@keyframes slide{from{left:-30%}to{left:100%}}
.buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.buttons:empty{display:none}
button{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid #3a3a3a;background:#232323;color:#e8e8e8}
button:hover{background:#2d2d2d}
button.primary{background:#ef6f2e;border-color:#ef6f2e;color:#111;font-weight:600}
button.primary:hover{background:#f58449}
button:focus-visible{outline:2px solid #f58449;outline-offset:2px}
[hidden]{display:none!important}
</style>
<main><div class="label">DROID OFFICE</div><h1 id="title"></h1><p id="detail"></p><div class="bar" id="bar"><div class="fill" id="fill"></div></div><div class="buttons" id="buttons"></div></main>
<script>
const $ = (id) => document.getElementById(id);
let escape;
let shownButtons = '';
window.droidUpdate.onView((view) => {
  $('title').textContent = view.title;
  $('detail').textContent = view.detail || '';
  $('detail').hidden = !view.detail;
  const bar = $('bar');
  bar.hidden = view.progress === undefined;
  bar.classList.toggle('indeterminate', view.progress === 'indeterminate');
  if (typeof view.progress === 'number') $('fill').style.width = (view.progress * 100).toFixed(1) + '%';
  else $('fill').style.width = '';
  escape = view.escape;
  const key = JSON.stringify(view.buttons);
  if (key !== shownButtons) {
    shownButtons = key;
    const box = $('buttons');
    box.replaceChildren(...view.buttons.map((b) => {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      el.onclick = () => window.droidUpdate.act(b.action);
      return el;
    }));
    const primary = box.querySelector('.primary');
    if (primary) primary.focus();
  }
  window.droidUpdate.height(document.querySelector('main').offsetHeight);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && escape) window.droidUpdate.act(escape);
});
</script>`;

export interface UpdateWindowOptions {
  /** The office window to attach to as a sheet, so it opens on the full-screen window's Space. */
  parent?: BaseWindow;
  onAction: (action: UpdateAction) => void;
  onClosed: () => void;
}

/** The one small window the whole update flow happens in. */
export class UpdateWindow {
  private readonly win: BrowserWindow;
  private view?: UpdateView;
  private loaded = false;
  private closing = false;
  private readonly onActionIpc = (e: IpcMainEvent, action: unknown) => {
    if (e.sender !== this.win.webContents) return;
    if (UPDATE_ACTIONS.includes(action as UpdateAction)) this.o.onAction(action as UpdateAction);
  };
  private readonly onHeightIpc = (e: IpcMainEvent, px: unknown) => {
    if (e.sender !== this.win.webContents || typeof px !== 'number' || !Number.isFinite(px)) return;
    const height = Math.min(600, Math.max(120, Math.ceil(px)));
    if (this.win.getContentSize()[1] !== height) this.win.setContentSize(WIDTH, height);
    // Shown once it has its first height, so it doesn't open at the default size and then jump.
    if (!this.win.isVisible()) this.win.show();
  };

  constructor(private readonly o: UpdateWindowOptions) {
    const parent = o.parent && !o.parent.isDestroyed() ? o.parent : undefined;
    this.win = new BrowserWindow({
      parent,
      modal: Boolean(parent),
      width: WIDTH,
      height: 170,
      useContentSize: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Software Update',
      backgroundColor: '#111111',
      webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, preload: PRELOAD },
    });
    ipcMain.on('update:action', this.onActionIpc);
    ipcMain.on('update:height', this.onHeightIpc);
    const contents = this.win.webContents;
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.once('did-finish-load', () => {
      this.loaded = true;
      this.send();
    });
    this.win.on('closed', () => {
      ipcMain.off('update:action', this.onActionIpc);
      ipcMain.off('update:height', this.onHeightIpc);
      o.onClosed();
    });
    void this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => {});
  }

  /** False from the moment it starts closing, so the next phase opens a new window. */
  get open(): boolean {
    return !this.closing && !this.win.isDestroyed();
  }

  render(view: UpdateView) {
    this.view = view;
    this.send();
  }

  focus() {
    if (!this.open) return;
    if (this.o.parent && !this.o.parent.isDestroyed()) this.o.parent.show();
    this.win.show();
    this.win.focus();
  }

  close() {
    if (!this.open) return;
    this.closing = true;
    this.win.close();
  }

  private send() {
    if (this.loaded && this.view && this.open) this.win.webContents.send('update:view', this.view);
  }
}
