import type { WTerm } from '@wterm/dom';
import type { TerminalPaths } from '../ui/terminal-path-links';

/** OSC 7 describes the latest directory, not the directory of individual cells. */
export function attachCwd(native: WTerm, paths: TerminalPaths, signal: AbortSignal) {
  native.onWorkingDirectory = (uri) => {
    paths.cwdHint = /^file:\/\//i.test(uri) && uri.length <= 4096 ? uri : undefined;
  };
  signal.addEventListener(
    'abort',
    () => {
      native.onWorkingDirectory = null;
      paths.cwdHint = undefined;
    },
    { once: true },
  );
}
