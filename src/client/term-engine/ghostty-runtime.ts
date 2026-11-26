import { FitAddon, Ghostty, Terminal, type ITerminalOptions } from 'ghostty-web';

/** Only imported by the opted-in renderer. Use the exported binary, not the library's data: URL. */
export async function createGhostty(options: ITerminalOptions) {
  // Give each mirrored PTY its own WASM memory and lifetime. The asset is browser-cached.
  const ghostty = await Ghostty.load(new URL('ghostty-web/ghostty-vt.wasm', import.meta.url).href);
  const term = new Terminal({ ...options, ghostty });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}
