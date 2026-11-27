import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WTermAdapter } from './wterm';
import type { ClientTerminal, ClientTerminalOptions, TerminalEngineName } from './types';

export type { ClientTerminal, ClientTerminalOptions, TerminalEngineName } from './types';

export type TerminalEngine = {
  readonly term: ClientTerminal;
  proposeDimensions(): { cols: number; rows: number } | undefined;
} & ({ readonly xterm: Terminal; readonly ghostty?: never } | { readonly ghostty: WTermAdapter; readonly xterm?: never });

/** A window owns its handle synchronously (including close during load). Ghostty's async factory
 * runs on open, after fonts are ready; the default path doesn't import its JS or request WASM. */
export function createTerminalEngine(options: ClientTerminalOptions, name: TerminalEngineName): TerminalEngine {
  if (name === 'ghostty') {
    const term = new WTermAdapter(options);
    return { term, ghostty: term, proposeDimensions: () => term.proposeDimensions() };
  }
  const term = new Terminal(options);
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, xterm: term, proposeDimensions: () => fit.proposeDimensions() };
}
