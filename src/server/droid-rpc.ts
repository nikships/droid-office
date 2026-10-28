import { DroidServerMethod, FACTORY_PROTOCOL_VERSION, JSONRPC_VERSION, LEGACY_FACTORY_API_VERSION, ProcessTransport } from '@factory/droid-sdk/node';

export const DROID_ASK_TIMEOUT_MS = 20_000;
const DROID_ASK_MAX_OUTPUT = 4 * 1024 * 1024;

/** The list methods the office asks droid, each answered from the CLI's own catalogue. */
export const DROID_LIST = {
  models: DroidServerMethod.LIST_MODELS,
  commands: DroidServerMethod.LIST_COMMANDS,
  skills: DroidServerMethod.LIST_SKILLS,
} as const;

type ListMethod = (typeof DROID_LIST)[keyof typeof DROID_LIST];

/**
 * Asks droid's list methods through @factory/droid-sdk's process transport, in `cwd` (a project's
 * skills and commands are its own). `droid exec` in stream-jsonrpc mode answers these without a
 * session. The SDK's createSession insists on FACTORY_API_KEY, unlike this transport.
 * The SDK's DroidClient refuses them before a session exists, so the requests go to its transport.
 * Resolves with each method's result in order, undefined for one droid answered with an error.
 */
export async function askDroid(command: string, cwd: string, methods: readonly ListMethod[], timeoutMs = DROID_ASK_TIMEOUT_MS): Promise<unknown[]> {
  const ids = methods.map((_, i) => `office-${i}`);
  const results = new Map<string, unknown>();
  return new Promise<unknown[]>((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const transport = new ProcessTransport({
      droidExecPath: command,
      cwd,
      env: process.env as Record<string, string>,
      onSpawned: (child) => {
        child.stdout?.on('data', (chunk: Buffer | string) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > DROID_ASK_MAX_OUTPUT) finish(new Error('droid output exceeded the limit'));
        });
      },
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void transport.close().catch(() => {});
      if (error) reject(error);
      else resolve(ids.map((id) => results.get(id)));
    };
    const timer = setTimeout(() => finish(new Error('droid did not answer in time')), timeoutMs);
    transport.onError(() => finish(new Error('droid exited without answering')));
    transport.onMessage((message) => {
      const msg = message as { type?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (msg.type !== 'response' || typeof msg.id !== 'string' || !ids.includes(msg.id) || results.has(msg.id)) return;
      results.set(msg.id, msg.error ? undefined : msg.result);
      if (results.size === ids.length) finish();
    });
    transport
      .connect()
      .then(async () => {
        if (settled) return transport.close();
        await Promise.all(
          methods.map((method, i) => transport.send({ factoryApiVersion: LEGACY_FACTORY_API_VERSION, factoryProtocolVersion: FACTORY_PROTOCOL_VERSION, type: 'request', jsonrpc: JSONRPC_VERSION, id: ids[i], method, params: {} })),
        );
      })
      .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}
