import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { screenSnapshot } from '../../src/server/screen.js';

/** Serialize real host state rather than approximating snapshot replay in browser tests. */
export async function hostSnapshot(data: string) {
  const term = new headless.Terminal({ cols: 24, rows: 8, allowProposedApi: true });
  try {
    const serializer = new serialize.SerializeAddon();
    term.loadAddon(serializer);
    const snapshot = screenSnapshot(term, serializer);
    await new Promise<void>((done) => term.write(data, done));
    return snapshot();
  } finally {
    term.dispose();
  }
}
