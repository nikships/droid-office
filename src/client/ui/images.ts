import { DROP_MAX_BYTES, PROMPT_IMAGES_MAX, PROMPT_IMAGE_TYPES } from '../../shared/drops';
import { ImageStaging } from '../image-staging';
import { store } from '../state';
import { withToken } from '../token';
import { h, toast } from './dom';

// Pictures pasted or dropped into a prompt box: each goes up to the office as soon as it's added
// (see /api/prompt/image in server.ts), shows as a small numbered thumbnail under the box, and
// comes out again with the ✕ that appears when you hover it. What's sent with the prompt is just
// their ids, in order; the office lists where it keeps them after your text.

const staging = new ImageStaging<File>({
  async upload(floor, f) {
    const name = f.name || 'That picture';
    const res = await fetch(withToken(`/api/prompt/image?${new URLSearchParams({ floor, name: f.name })}`), { method: 'POST', headers: { 'content-type': f.type }, body: f });
    const r = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !r.id) throw new Error(r.error ?? `${name} could not be attached`);
    return r.id;
  },
  forget(floor, id) {
    void fetch(withToken(`/api/prompt/image?${new URLSearchParams({ floor, id })}`), { method: 'DELETE' }).catch(() => {});
  },
});

/** Throws away a kept draft's pictures (local handles), uploaded or still going up. Best effort on the office. */
export function forgetStagedImages(handles: readonly string[]) {
  for (const handle of handles) staging.remove(handle);
}

/** The connection was lost: every picture a draft kept outside a mounted box goes, on every floor. */
export function forgetAllStagedImages() {
  staging.removeKept();
}

export interface PromptImages {
  /** The thumbnails, empty (and hidden) until a picture is added: put it under the prompt box. */
  element: HTMLElement;
  add(files: File[]): void;
  /** The ids of the pictures that are up, in the order they were added, which is how they're numbered. */
  ids(): string[];
  /** Every picture here, up or still going up, as opaque local handles: what a kept draft holds. */
  handles(): string[];
  /** Whether a picture is still going up. */
  busy(): boolean;
  /** Resolves once no picture is going up. */
  settled(): Promise<void>;
  /** The ids to send with the prompt. The prompt owns them from here: closing the box no longer throws them away. */
  take(): string[];
  /** Throws away what was never sent: the box was closed. */
  discard(): void;
  /** Lets go of the thumbnails but keeps the pictures, uploads still going included: a draft holds their handles. */
  detach(): void;
  /** Puts back a kept draft's pictures by handle, in order, after what is already here. */
  restore(handles: readonly string[]): void;
  /** Called whenever the pictures change (added, uploaded, removed, taken, discarded, restored). */
  onChange(fn: () => void): void;
  /** Takes pictures dropped on `zone`, which gets the `dropping` class while one is held over it. */
  dropZone(zone: HTMLElement, mark?: HTMLElement): void;
}

interface Item {
  handle: string;
  file: File;
  url: string;
}

export function promptImages(textarea: HTMLTextAreaElement, opts: { floor?: string } = {}): PromptImages {
  const floor = opts.floor ?? store.floor ?? '';
  const items: Item[] = [];
  const waiting: (() => void)[] = [];
  let changed: () => void = () => {};
  const element = h('div.pimgs', { role: 'list', 'aria-label': 'Attached pictures' });

  const idOf = (item: Item) => staging.get(item.handle)?.id;
  const ids = () => items.flatMap((i) => idOf(i) ?? []);
  const busy = () => items.some((i) => !idOf(i));
  const settle = () => {
    if (!busy()) for (const fn of waiting.splice(0)) fn();
  };
  const render = () => {
    element.replaceChildren(
      ...items.map((item, i) =>
        h(
          'div.pimg',
          { role: 'listitem', class: idOf(item) ? '' : 'uploading', title: `Image ${i + 1}: ${item.file.name || 'pasted picture'}` },
          h('img', { src: item.url, alt: `Image ${i + 1}` }),
          h('span.pimg-n', {}, String(i + 1)),
          h('button.pimg-x', { type: 'button', 'aria-label': `Remove image ${i + 1}`, title: 'Remove', onclick: () => remove(item) }, '✕'),
        ),
      ),
    );
  };
  const drop = (item: Item) => {
    const at = items.indexOf(item);
    if (at >= 0) items.splice(at, 1);
    URL.revokeObjectURL(item.url);
  };
  const remove = (item: Item) => {
    drop(item);
    staging.remove(item.handle);
    render();
    settle();
    changed();
    textarea.focus();
  };
  /** Repaints once this picture's upload settles, if it is still shown here. A failed one is gone from staging. */
  const watch = (item: Item) => {
    const entry = staging.get(item.handle);
    if (!entry || entry.id) return;
    void entry.settled.then(() => {
      if (!items.includes(item)) return;
      if (!staging.get(item.handle)) drop(item);
      render();
      settle();
      changed();
    });
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
      const staged = staging.stage(floor, file, (err) => toast(err.message, 'warn'));
      const item: Item = { handle: staged.handle, file, url: URL.createObjectURL(file) };
      items.push(item);
      watch(item);
    }
    render();
    changed();
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
    settle();
  };

  return {
    element,
    add,
    ids,
    handles: () => items.map((i) => i.handle),
    busy,
    settled: () => (busy() ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve()),
    take() {
      const taken = items.flatMap((i) => staging.take(i.handle) ?? []);
      release();
      changed();
      return taken;
    },
    discard() {
      for (const item of items) staging.remove(item.handle);
      release();
      changed();
    },
    detach() {
      for (const item of items) staging.keep(item.handle);
      release();
    },
    restore(kept) {
      for (const handle of kept) {
        if (items.length >= PROMPT_IMAGES_MAX || items.some((i) => i.handle === handle)) continue;
        const entry = staging.adopt(handle);
        if (!entry) continue;
        const item: Item = { handle, file: entry.file, url: URL.createObjectURL(entry.file) };
        items.push(item);
        watch(item);
      }
      render();
      changed();
    },
    onChange(fn) {
      changed = fn;
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
