import { Menu, type NativeImage, nativeImage, Tray } from 'electron';
import { TRAY_ICON } from './tray-icon.js';
import { type TrayAction, type TrayView, trayMenu, trayTooltip } from './tray-model.js';

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
    const key = JSON.stringify([view.state, items]);
    if (key === this.shown) return;
    this.shown = key;
    this.tray.setImage(icon(view.state === 'running'));
    this.tray.setToolTip(trayTooltip(view));
    const template = items.map((item) => ('type' in item ? item : { label: item.label, enabled: item.enabled, ...(item.action ? { click: () => this.run(item.action as TrayAction) } : {}) }));
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
