// The offscreen page's window is never on screen, so a file chooser Chromium opened for it would be a
// sheet on an invisible window. PresenterInput intercepts the chooser (Page.setInterceptFileChooserDialog)
// and the app shows the Finder's open panel on the visible window instead. What the page says about the
// chooser (its accept list) is the page's word, so it is checked here before it reaches the dialog.

export interface ChooserFilter {
  name: string;
  extensions: string[];
}

export interface ChooserRequest {
  backendNodeId: number;
  frameId: string;
  multiple: boolean;
}

export interface ChooserOptions {
  multiple: boolean;
  directory: boolean;
  /** Empty for any file. */
  filters: ChooserFilter[];
}

/** `Page.fileChooserOpened`'s parameters, or undefined when they aren't what the protocol sends. */
export function parseChooserOpened(params: Record<string, unknown>): ChooserRequest | undefined {
  const { backendNodeId, frameId, mode } = params;
  if (typeof backendNodeId !== 'number' || !Number.isInteger(backendNodeId) || backendNodeId <= 0) return undefined;
  if (typeof frameId !== 'string' || !frameId || frameId.length > 128) return undefined;
  if (mode !== 'selectSingle' && mode !== 'selectMultiple') return undefined;
  return { backendNodeId, frameId, multiple: mode === 'selectMultiple' };
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'svg', 'ico', 'psd', 'jxl', 'jp2', 'tga', 'exr', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2'];
/** The MIME types a page in the office asks for, as the name endings the Finder filters by. */
const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/*': IMAGE_EXTENSIONS,
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
  'image/tiff': ['tif', 'tiff'],
  'image/svg+xml': ['svg'],
  'text/html': ['html', 'htm'],
  'application/pdf': ['pdf'],
};
const MAX_ACCEPT = 2048;
const MAX_EXTENSIONS = 100;

/**
 * The Finder filters for an `<input type=file>`'s `accept`: what it asks for first, then all files, so
 * nothing is out of reach (the page still checks what it gets). Empty when it asks for nothing in
 * particular, or for a kind this doesn't know.
 */
export function chooserFilters(accept: unknown): ChooserFilter[] {
  if (typeof accept !== 'string' || !accept.trim() || accept.length > MAX_ACCEPT) return [];
  const extensions = new Set<string>();
  for (const raw of accept.split(',')) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith('.')) {
      const ext = token.slice(1);
      if (!/^[a-z0-9]{1,10}$/.test(ext)) return [];
      extensions.add(ext);
      continue;
    }
    const known = Object.hasOwn(MIME_EXTENSIONS, token) ? MIME_EXTENSIONS[token] : undefined;
    if (!known) return [];
    for (const ext of known) extensions.add(ext);
  }
  if (!extensions.size || extensions.size > MAX_EXTENSIONS) return [];
  const list = [...extensions];
  const pictures = list.every((ext) => IMAGE_EXTENSIONS.includes(ext) || ext === 'pdf');
  return [
    { name: pictures ? 'Pictures' : 'Supported files', extensions: list },
    { name: 'All files', extensions: ['*'] },
  ];
}
