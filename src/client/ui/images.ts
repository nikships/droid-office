import { DROP_MAX_BYTES, PROMPT_IMAGES_MAX, PROMPT_IMAGE_TYPES } from '../../shared/drops';
import { store } from '../state';
import { withToken } from '../token';
import { h, toast } from './dom';

// Pictures pasted or dropped into a prompt box: each goes up to the office as soon as it's added
// (see /api/prompt/image in server.ts), shows as a small numbered thumbnail under the box, and
// comes out again with the ✕ that appears when you hover it. What's sent with the prompt is just
// their ids, in order; the office lists where it keeps them after your text.

export interface PromptImages {
  /** The thumbnails, empty (and hidden) until a picture is added: put it under the prompt box. */
  element: HTMLElement;
  /** The ids of the pictures that are up, in the order they were added, which is how they're numbered. */
  ids(): string[];
  /** Whether a picture is still going up. */
  busy(): boolean;
  /** Resolves once no picture is going up. */
  settled(): Promise<void>;
  /** The ids to send with the prompt. The prompt owns them from here: closing the box no longer throws them away. */
  take(): string[];
  /** Throws away what was never sent: the box was closed. */
  discard(): void;
  /** Takes pictures dropped on `zone`, which gets the `dropping` class while one is held over it. */
  dropZone(zone: HTMLElement, mark?: HTMLElement): void;
}

interface Item {
  file: File;
  url: string;
  /** Set once it's up. */
  id?: string;
  /** Taken out while it was still going up. */
  removed?: boolean;
}

export function promptImages(textarea: HTMLTextAreaElement): PromptImages {
  const floor = store.floor ?? '';
  const items: Item[] = [];
  const waiting: (() => void)[] = [];
  const element = h('div.pimgs', { role: 'list', 'aria-label': 'Attached pictures' });

  const query = (extra: Record<string, string>) => new URLSearchParams({ floor, ...extra });
  const upload = async (f: File): Promise<string> => {
    const name = f.name || 'That picture';
    const res = await fetch(withToken(`/api/prompt/image?${query({ name: f.name })}`), { method: 'POST', headers: { 'content-type': f.type }, body: f });
    const r = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !r.id) throw new Error(r.error ?? `${name} could not be attached`);
    return r.id;
  };
  const forget = (id: string) => {
    void fetch(withToken(`/api/prompt/image?${query({ id })}`), { method: 'DELETE' }).catch(() => {});
  };

  const ids = () => items.flatMap((i) => (i.id ? [i.id] : []));
  const busy = () => items.some((i) => !i.id);
  const settle = () => {
    if (!busy()) for (const fn of waiting.splice(0)) fn();
  };
  const render = () => {
    element.replaceChildren(
      ...items.map((item, i) =>
        h(
          'div.pimg',
          { role: 'listitem', class: item.id ? '' : 'uploading', title: `Image ${i + 1}: ${item.file.name || 'pasted picture'}` },
          h('img', { src: item.url, alt: `Image ${i + 1}` }),
          h('span.pimg-n', {}, String(i + 1)),
          h('button.pimg-x', { type: 'button', 'aria-label': `Remove image ${i + 1}`, title: 'Remove', onclick: () => remove(item) }, '✕'),
        ),
      ),
    );
  };
  const remove = (item: Item) => {
    items.splice(items.indexOf(item), 1);
    item.removed = true;
    URL.revokeObjectURL(item.url);
    if (item.id) forget(item.id);
    render();
    settle();
    textarea.focus();
  };

  const add = (files: File[]) => {
    for (const file of files) {
      if (!PROMPT_IMAGE_TYPES.includes(file.type)) {
        toast(`${file.name || 'That file'} isn't a PNG, JPEG, GIF or WebP picture`, 'warn');
        continue;
      }
      if (file.size > DROP_MAX_BYTES) {
        toast(`${file.name || 'That picture'} is too big to send (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`, 'warn');
        continue;
      }
      if (items.length >= PROMPT_IMAGES_MAX) {
        toast(`A prompt takes at most ${PROMPT_IMAGES_MAX} pictures`, 'warn');
        break;
      }
      const item: Item = { file, url: URL.createObjectURL(file) };
      items.push(item);
      upload(file).then(
        (id) => {
          // Taken out while it was going up: it was kept after all, so let it go.
          if (item.removed) return forget(id);
          item.id = id;
          render();
          settle();
        },
        (err: Error) => {
          if (item.removed) return;
          const at = items.indexOf(item);
          if (at >= 0) items.splice(at, 1);
          URL.revokeObjectURL(item.url);
          toast(err.message, 'warn');
          render();
          settle();
        },
      );
    }
    render();
  };

  // A picture on the clipboard with no text (a screenshot) is attached; anything with text pastes as text.
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || e.clipboardData?.getData('text/plain')) return;
    e.preventDefault();
    add(files);
  });

  const release = () => {
    for (const item of items.splice(0)) URL.revokeObjectURL(item.url);
    render();
  };

  return {
    element,
    ids,
    busy,
    settled: () => (busy() ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve()),
    take() {
      const taken = ids();
      release();
      return taken;
    },
    discard() {
      for (const item of items) {
        item.removed = true;
        if (item.id) forget(item.id);
      }
      release();
    },
    dropZone(zone, mark = zone) {
      const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
      let depth = 0;
      const end = () => {
        depth = 0;
        mark.classList.remove('dropping');
      };
      zone.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth++;
        mark.classList.add('dropping');
      });
      zone.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      });
      zone.addEventListener('dragleave', (e) => {
        if (hasFiles(e) && --depth <= 0) end();
      });
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        end();
        add([...e.dataTransfer!.files]);
      });
    },
  };
}
