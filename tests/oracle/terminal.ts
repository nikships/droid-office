import '../../src/client/term-engine/wterm.css';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { WTermAdapter } from '../../src/client/term-engine/wterm';
export function comparisonTerminal(options: ConstructorParameters<typeof Terminal>[0], name: string) {
  return name === 'xterm' ? new Terminal(options) : new WTermAdapter(options ?? {});
}
