import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import type { VtScanner } from '../../shared/vt-scanner';

export type TerminalEngineName = 'xterm' | 'ghostty';
export type TerminalParser = Pick<VtScanner, 'registerCsiHandler' | 'registerDcsHandler' | 'registerEscHandler' | 'registerOscHandler'>;
export type ClientTerminalOptions = Pick<
  ITerminalOptions,
  | 'cursorBlink'
  | 'cursorStyle'
  | 'disableStdin'
  | 'fontSize'
  | 'fontFamily'
  | 'theme'
  | 'scrollback'
  | 'smoothScrollDuration'
  | 'lineHeight'
  | 'scrollSensitivity'
  | 'macOptionIsMeta'
  | 'allowTransparency'
  | 'allowProposedApi'
  | 'minimumContrastRatio'
  | 'linkHandler'
>;

/** Shared mirror, input, settings and lifecycle contract. Engine-specific features use the
 * discriminated native handle instead of pretending to implement an unsupported xterm API. */
export interface ClientTerminal extends Pick<Terminal, 'cols' | 'rows' | 'focus' | 'paste' | 'input' | 'resize' | 'reset' | 'dispose' | 'scrollToBottom' | 'attachCustomKeyEventHandler'> {
  readonly options: ClientTerminalOptions;
  readonly supportsLineHeight?: boolean;
  readonly parser: TerminalParser;
  readonly modes: Pick<Terminal['modes'], 'sendFocusMode' | 'applicationCursorKeysMode' | 'bracketedPasteMode' | 'mouseTrackingMode'>;
  readonly buffer: { readonly active: { readonly viewportY: number; readonly baseY: number } };
  readonly textarea?: HTMLTextAreaElement;
  setRenderingPaused?(paused: boolean): void;
  saveReader?(): (() => void) | undefined;
  open(host: HTMLElement): void | Promise<void>;
  write(data: string, done?: () => void): void;
  onData(fn: (data: string) => void): { dispose(): void };
  onWriteParsed(fn: () => void): { dispose(): void };
}

/** A line to scroll to once the terminal has loaded: a search hit (see search.ts). */
export interface TerminalFind {
  /** What was searched for, as a searchKey. */
  needle: string;
  /** How many rows from the bottom of the worker's terminal the line was. */
  fromEnd: number;
}
