import {
  AutonomyLevel,
  createSession,
  DroidInteractionMode,
  DroidMessageType,
  FACTORY_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  LEGACY_FACTORY_API_VERSION,
  ProcessTransport,
  type DroidSession,
  type JsonRpcMessage,
  type ReasoningEffort,
} from '@factory/droid-sdk/node';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { WorkerTask } from '../shared/protocol.js';
import { LABEL_TEXT_CHARS, type WorkerLabelSettings } from '../shared/worker-labels.js';
import { DROID_SETTINGS_PATH } from './droid-models.js';

export interface LabelInput {
  text: string;
  previousSubject?: string;
}

/** Never return arbitrary SDK/provider errors: they may contain credentials or conversation text. */
export class LabelModelError extends Error {}

export function parseLabel(text: string): WorkerTask {
  let value: unknown;
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new LabelModelError('The label model returned invalid JSON.');
  }
  const v = value as Partial<WorkerTask> | null;
  const line = (s: unknown, max: number) =>
    typeof s === 'string'
      ? s
          .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
          .trim()
          .slice(0, max)
      : '';
  const name = line(v?.name, 60);
  const summary = line(v?.summary, 140);
  if (!name || !summary) throw new LabelModelError('The label model did not return a subject and summary.');
  return { name, summary, generated: true };
}

/** The SDK overlays, rather than replaces, process.env. Explicit empty overrides are important. */
export function labelEnvironment(base: NodeJS.ProcessEnv, home: string, key: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    env[name] = /^(NEBULA_|DROID_OFFICE_|ELECTRON_|VSCODE_)/.test(name) || ['NO_COLOR', 'FORCE_COLOR', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'NODE_OPTIONS', 'PWD', 'OLDPWD'].includes(name) ? '' : value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    FACTORY_API_KEY: key,
  };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(new LabelModelError('Worker label generation was cancelled or timed out.'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new LabelModelError('Worker label generation was cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One catalogue batch before initialize, using the SDK transport's documented request envelope. */
async function catalogue(transport: ProcessTransport, model: string, signal: AbortSignal): Promise<{ tools: { id: string; llmId: string }[]; models: { id: string; disabled?: boolean; supportedReasoningEfforts?: string[] }[] }> {
  const replies = new Map<string, Record<string, unknown>>();
  const work = new Promise<void>((resolve, reject) => {
    transport.onError(() => reject(new LabelModelError('The isolated Droid process stopped.')));
    transport.onMessage((message) => {
      const m = message as { type?: string; id?: string; result?: Record<string, unknown>; error?: unknown };
      if (m.type !== 'response' || !m.id || !['label-tools', 'label-models'].includes(m.id)) return;
      if (m.error || !m.result) return reject(new LabelModelError('Droid could not list the label model and tools.'));
      replies.set(m.id, m.result);
      if (replies.size === 2) resolve();
    });
    void Promise.all(
      ['tools', 'models'].map((kind) =>
        transport.send({
          factoryApiVersion: LEGACY_FACTORY_API_VERSION,
          factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
          type: 'request',
          jsonrpc: JSONRPC_VERSION,
          id: `label-${kind}`,
          method: `droid.list_${kind}`,
          params: kind === 'tools' ? { modelId: model } : {},
        } as JsonRpcMessage),
      ),
    ).catch(reject);
  });
  await abortable(work, signal);
  const tools = replies.get('label-tools')?.tools;
  const models = replies.get('label-models')?.models;
  if (!Array.isArray(tools) || !Array.isArray(models)) throw new LabelModelError('Droid returned an invalid label catalogue.');
  return { tools, models };
}

export interface LabelModelOptions {
  droid: () => string | null;
  key: () => string | undefined;
  system: () => string;
  settingsPath?: string;
}

/** A fresh, credentialed, disposable profile. Never falls back to the owner's Droid profile. */
export class WorkerLabelModel {
  constructor(private options: LabelModelOptions) {}

  async generate(input: LabelInput, settings: WorkerLabelSettings, cancelled: AbortSignal): Promise<WorkerTask> {
    const droid = this.options.droid();
    const key = this.options.key();
    if (!droid || !path.isAbsolute(droid)) throw new LabelModelError('Install Droid to generate worker labels.');
    if (!key) throw new LabelModelError('Connect a Factory API key in Settings to generate worker labels.');
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(45_000)]);
    const home = await mkdtemp(path.join(os.tmpdir(), 'office-worker-label-'));
    let transport: ProcessTransport | undefined;
    let session: DroidSession | undefined;
    let child: ChildProcess | undefined;
    const abort = () => child?.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const isolated: Record<string, unknown> = { hooksDisabled: true, cloudSessionSync: false };
      if (settings.model.startsWith('custom:')) {
        const saved = JSON.parse(await readFile(this.options.settingsPath ?? DROID_SETTINGS_PATH, 'utf8')) as { customModels?: { id?: string }[] };
        const selected = saved.customModels?.find((m) => m.id === settings.model);
        if (!selected) throw new LabelModelError('The selected custom label model is no longer configured.');
        // Only this model definition, never hooks, MCP servers, plugins or login files.
        isolated.customModels = [selected];
      }
      await mkdir(path.join(home, '.factory'), { mode: 0o700 });
      await writeFile(path.join(home, '.factory', 'settings.json'), JSON.stringify(isolated), { mode: 0o600 });
      let bytes = 0;
      transport = new ProcessTransport({
        droidExecPath: droid,
        cwd: home,
        env: labelEnvironment(process.env, home, key),
        onSpawned: (spawned) => {
          child = spawned;
          if (signal.aborted) abort();
          spawned.stdout?.on('data', (data: Buffer | string) => {
            bytes += Buffer.byteLength(data);
            if (bytes > 4 * 1024 * 1024) void transport?.close();
          });
        },
      });
      await abortable(transport.connect(), signal);
      const catalog = await catalogue(transport, settings.model, signal);
      const model = catalog.models.find((m) => m.id === settings.model && !m.disabled);
      if (!model?.supportedReasoningEfforts?.includes(settings.effort)) throw new LabelModelError('The selected label model or reasoning effort is unavailable. Choose another in Settings.');
      session = await abortable(
        createSession({
          transport,
          cwd: home,
          modelId: settings.model,
          reasoningEffort: settings.effort as ReasoningEffort,
          systemPrompt: `${this.options.system()}\nUse only the supplied visible conversation text and previous subject. Never use tools. Return exactly JSON with string fields "name" and "summary".`,
          disabledToolIds: [...new Set(catalog.tools.flatMap((tool) => [tool.id, tool.llmId]).filter(Boolean))],
          disableBuiltinSkills: true,
          mcpServers: [],
          autonomyLevel: AutonomyLevel.Off,
          interactionMode: DroidInteractionMode.Auto,
          autoRejectPermissionRequests: true,
          abortSignal: signal,
          tags: [{ name: 'droid-office-worker-label' }],
        }),
        signal,
      );
      if (session.settings.modelId !== settings.model || session.settings.reasoningEffort !== settings.effort) throw new LabelModelError('Droid did not select the requested label model and effort.');
      const [mcps, skills] = await abortable(Promise.all([session.listMcpServers(), session.listSkills()]), signal);
      if (mcps.summary.total || skills.skills.length) throw new LabelModelError('The isolated label session unexpectedly loaded MCP servers or skills.');
      let result: WorkerTask | undefined;
      const stream = session.stream(JSON.stringify({ previousSubject: input.previousSubject?.slice(0, 60), conversation: input.text.slice(-LABEL_TEXT_CHARS) }));
      while (true) {
        const next = await abortable(stream.next(), signal);
        if (next.done) break;
        const message = next.value;
        // Droid currently retains ToolSearch despite disabledToolIds. Reject any tool attempt,
        // rather than claiming the SDK provides a strict no-tools allowlist.
        if (message.type === DroidMessageType.ToolCall) throw new LabelModelError('The label model attempted a tool call. No label was published.');
        if (message.type === DroidMessageType.Result) {
          if (!message.success) throw new LabelModelError('The label model did not finish successfully.');
          if (message.messages.some((m) => m.type === 'hook' || m.type === DroidMessageType.ToolCall)) throw new LabelModelError('The label session unexpectedly ran a hook or tool.');
          result = parseLabel(message.text);
        }
      }
      if (!result) throw new LabelModelError('The label model returned no result.');
      return result;
    } catch (error) {
      if (error instanceof LabelModelError) throw error;
      throw new LabelModelError(signal.aborted ? 'Worker label generation was cancelled or timed out.' : 'Worker label generation failed. Check the Factory connection and selected model.');
    } finally {
      signal.removeEventListener('abort', abort);
      if (session) await session.close().catch(() => {});
      if (transport) await transport.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  }
}
