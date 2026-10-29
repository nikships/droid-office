import { Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from 'electron';
import { TRAY_ICON } from './tray-icon.js';
import { type TrayAction, type TrayView, trayMenu, trayTitle, trayTooltip } from './tray-model.js';

function icon(running: boolean): NativeImage {
  const set = running ? TRAY_ICON.running : TRAY_ICON.stopped;
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(set.x1, 'base64') });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(set.x2, 'base64') });
  return image;
}

/** The menu bar icon, which stays while the office window is closed (see tray-model.ts for what it shows). */
export class OfficeTray {
  private readonly tray = new Tray(icon(false));
  private shown = '';

  constructor(private readonly run: (action: TrayAction) => void) {}

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
      const { action, checked, ...rest } = item;
      return {
        ...rest,
        ...(checked !== undefined ? { type: 'checkbox', checked } : {}),
        ...(action ? { click: () => this.run(action) } : {}),
      };
    });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
