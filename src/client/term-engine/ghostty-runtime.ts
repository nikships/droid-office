import { FitAddon, Ghostty, Terminal, type GhosttyTerminal, type ITerminalOptions } from 'ghostty-web';

// The native selection manager's anonymous document listener outlives dispose(). Give it
// a revocable view of the core, not ownership of the WASM memory. Bind methods to the real
// core so its inner rendering loops still run directly, not through a proxy.
function paneCore(core: GhosttyTerminal) {
  const methods = new Map<PropertyKey, unknown>();
  const { proxy, revoke } = Proxy.revocable(core, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key);
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const method = value.bind(target);
      methods.set(key, method);
      return method;
    },
  });
  methods.set('free', () => {
    try {
      core.free();
    } finally {
      revoke();
    }
  });
  return proxy;
}

/** Only imported by the opted-in renderer. Use the exported binary, not the library's data: URL. */
export async function createGhostty(options: ITerminalOptions) {
  // Reusing an allocator across disposed terminals traps on subsequent writes in the pinned WASM.
  const ghostty = await Ghostty.load(new URL('ghostty-web/ghostty-vt.wasm', import.meta.url).href);
  const factory = Object.create(ghostty) as Ghostty;
  factory.createTerminal = (...args) => paneCore(ghostty.createTerminal(...args));
  const term = new Terminal({ ...options, ghostty: factory });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}
