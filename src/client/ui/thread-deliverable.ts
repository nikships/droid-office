import { threadDeliverable } from '../../shared/thread-diff';
import { store } from '../state';
import { toast } from './dom';
import { threadFileImageUrl, threadFilePreviewUrl } from './file-preview';
import { buildDroppedCard } from './whiteboard-dialogs';

// A file a worker created, sent from its Thread to the floor's Whiteboard as the card the owner would
// get by dropping that file on the grid.

const TEXT_TYPES = { markdown: 'text/markdown', html: 'text/html' } as const;

async function workspaceFile(floor: string, workerId: string, path: string): Promise<File | string> {
  const kind = threadDeliverable(path);
  const name = path.split('/').at(-1) || path;
  if (!kind) return `${name} isn't a Markdown, HTML or picture file.`;
  if (kind === 'image') {
    const res = await fetch(threadFileImageUrl({ floor, workerId, path }));
    if (!res.ok) return ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Couldn't read ${name} (HTTP ${res.status}).`;
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type });
  }
  const res = await fetch(threadFilePreviewUrl({ floor, workerId, path }));
  const json = (await res.json().catch(() => null)) as { text?: string; truncated?: boolean; error?: string } | null;
  if (!res.ok || typeof json?.text !== 'string') return json?.error ?? `Couldn't read ${name} (HTTP ${res.status}).`;
  if (json.truncated) return `${name} is too long to send to the Whiteboard from here.`;
  return new File([json.text], name, { type: TEXT_TYPES[kind] });
}

/** Adds `path` from `workerId`'s workspace to `floor`'s Whiteboard, returning the new card's id, or undefined after saying why not. */
export async function sendWorkspaceFile(floor: string, workerId: string, path: string): Promise<string | undefined> {
  if (store.whiteboard.state(floor) !== 'live') {
    toast('The Whiteboard is still connecting. Try again in a moment.', 'warn');
    return;
  }
  try {
    const file = await workspaceFile(floor, workerId, path);
    if (typeof file === 'string') return void toast(file, 'warn');
    const built = await buildDroppedCard(floor, file);
    if (typeof built === 'string') return void toast(built, 'warn');
    const applied = await store.whiteboard.apply(floor, built.ops);
    if (!applied.ok) return void toast(`Couldn't add “${built.title}” to the Whiteboard${applied.reason === 'invalid' ? `: ${applied.error.reason}` : ''}`, 'error');
    toast(`Added “${built.title}” to the Whiteboard.`);
    return built.card;
  } catch (err) {
    toast(`Couldn't send ${path} to the Whiteboard: ${(err as Error).message}`, 'error');
  }
}
