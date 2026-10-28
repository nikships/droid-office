import { Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from 'electron';
import { TRAY_ICON } from './tray-icon.js';
import { type TrayAction, type TrayIcon, type TrayView, trayMenu, trayTitle, trayTooltip, type WorkerLink } from './tray-model.js';

function icon(running: boolean): NativeImage {
  const set = running ? TRAY_ICON.running : TRAY_ICON.stopped;
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(set.x1, 'base64') });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(set.x2, 'base64') });
  return image;
}

/** The SF Symbols beside a waiting worker, the raised hand and the tick the office shows above their heads. */
const SYMBOLS: Record<TrayIcon, string> = { needsInput: 'hand.raised.fill', done: 'checkmark.circle.fill' };
const symbols = new Map<TrayIcon, NativeImage | undefined>();

/** A menu-sized symbol in the menu's own text colour; none where this macOS doesn't have it. */
function symbol(which: TrayIcon): NativeImage | undefined {
  if (!symbols.has(which)) {
    const image = nativeImage.createFromNamedImage(SYMBOLS[which], { pointSize: 13, weight: 'medium', scale: 'medium' });
    if (!image.isEmpty()) image.setTemplateImage(true);
    symbols.set(which, image.isEmpty() ? undefined : image);
  }
  return symbols.get(which);
}

/** The menu bar icon, which stays while the office window is closed (see tray-model.ts for what it shows). */
export class OfficeTray {
  private readonly tray = new Tray(icon(false));
  private shown = '';

  constructor(private readonly run: (action: TrayAction, link?: WorkerLink) => void) {}

  render(view: TrayView) {
    const items = trayMenu(view);
    const title = trayTitle(view);
    const key = JSON.stringify([view.state, title, items]);
    if (key === this.shown) return;
    this.shown = key;
    this.tray.setImage(icon(view.state === 'running'));
    this.tray.setTitle(title, { fontType: 'monospacedDigit' });
    this.tray.setToolTip(trayTooltip(view));
    const template = items.map((item): MenuItemConstructorOptions => {
      if ('type' in item) return item;
      const { action, link, icon: which, checked, ...rest } = item;
      const image = which && symbol(which);
      return {
        ...rest,
        ...(checked !== undefined ? { type: 'checkbox', checked } : {}),
        ...(image ? { icon: image } : {}),
        ...(action ? { click: () => this.run(action, link) } : {}),
      };
    });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
