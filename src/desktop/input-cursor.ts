/** The NSCursor names `input_view.mm` knows (`CursorNamed`), or the page's own image. */
export type NativeCursor =
  | 'arrow'
  | 'pointingHand'
  | 'iBeam'
  | 'iBeamVertical'
  | 'crosshair'
  | 'openHand'
  | 'closedHand'
  | 'resizeLeftRight'
  | 'resizeUpDown'
  | 'resizeNorthEast'
  | 'resizeNorthWest'
  | 'notAllowed'
  | 'contextMenu'
  | 'dragCopy'
  | 'dragLink'
  | 'hidden';

/**
 * The cursor for Electron's `cursor-changed` type. Electron names Chromium's cursors: its 'pointer' is the plain arrow and its
 * 'hand' is the pointing hand. macOS has no public busy, help or zoom cursor, so those stay an arrow (busy) or a crosshair.
 */
export function nativeCursor(type: string): NativeCursor {
  switch (type) {
    case 'hand':
      return 'pointingHand';
    case 'text':
      return 'iBeam';
    case 'vertical-text':
      return 'iBeamVertical';
    case 'crosshair':
    case 'cell':
    case 'zoom-in':
    case 'zoom-out':
      return 'crosshair';
    case 'grab':
    case 'move':
    case 'm-panning':
    case 'm-panning-vertical':
    case 'm-panning-horizontal':
    case 'e-panning':
    case 'n-panning':
    case 'ne-panning':
    case 'nw-panning':
    case 's-panning':
    case 'se-panning':
    case 'sw-panning':
    case 'w-panning':
      return 'openHand';
    case 'grabbing':
      return 'closedHand';
    case 'e-resize':
    case 'w-resize':
    case 'ew-resize':
    case 'col-resize':
      return 'resizeLeftRight';
    case 'n-resize':
    case 's-resize':
    case 'ns-resize':
    case 'row-resize':
      return 'resizeUpDown';
    case 'ne-resize':
    case 'sw-resize':
    case 'nesw-resize':
      return 'resizeNorthEast';
    case 'nw-resize':
    case 'se-resize':
    case 'nwse-resize':
      return 'resizeNorthWest';
    case 'not-allowed':
    case 'nodrop':
    case 'drag-drop-none':
    case 'ns-no-resize':
    case 'ew-no-resize':
    case 'nesw-no-resize':
    case 'nwse-no-resize':
      return 'notAllowed';
    case 'context-menu':
      return 'contextMenu';
    case 'copy':
    case 'drag-drop-copy':
      return 'dragCopy';
    case 'alias':
    case 'drag-drop-link':
      return 'dragLink';
    case 'none':
      return 'hidden';
    default:
      return 'arrow';
  }
}
