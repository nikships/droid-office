import { FRAMES, SHAPES, SIZES, checkImageUrl, pictureSize, uploadName, type Decoration } from '../../shared/decor';
import { store } from '../state';
import { holdPicture, imageUrl, loadPicture, type Picture } from '../world/gallery';
import { h, openModal, timeAgo } from './dom';
import { colorDot } from './kit';
import { PICTURE_ACCEPT, droppedLink, pictureFile, uploadPicture } from './picture-file';

/** What to say when what was dropped or pasted holds files but none is a picture. */
const notPicture = (f: File) => `“${f.name || 'That file'}” isn't a picture. Choose an image: PNG, JPEG, HEIC, GIF, WebP, TIFF, SVG, RAW and more all work.`;
import { confirmDialog } from './prompt';

export interface HangChoice {
  picture: Picture;
  title: string;
  frame: number;
  /** The frame's width / height. */
  shape: number;
  /** The picture's longest side, in meters. */
  size: number;
}

const FRAME_KEY = 'droid-office.frame';
function lastFrame(): number {
  try {
    const n = Number(localStorage.getItem(FRAME_KEY));
    return Number.isInteger(n) && n >= 0 && n < FRAMES.length ? n : 0;
  } catch {
    return 0;
  }
}

const TIP = 'Any format works: PNG, JPEG, HEIC, GIF, WebP, TIFF, SVG, RAW and more.';
const LINK_TIP = 'Or paste a link to an image online. Right-click any picture on the web and choose “Copy image address”.';

/** The SHAPES entry a frame of this width / height is, given the image's own (Original); -1 for none. */
function shapeIndex(shape: number, aspect: number): number {
  const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.02;
  if (near(shape, aspect)) return 0;
  return SHAPES.findIndex((s) => s.ratio > 0 && near(shape, s.ratio));
}

const PASTE_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘V' : 'Ctrl+V';
const meters = (n: number) => `${n < 1 ? n.toFixed(2) : n.toFixed(1)} m`;

/** Pick an image, a title, a frame, a shape and a size. Editing a picture (`initial`) fills them in. */
export function openHangDialog(opts: { initial?: Decoration; size?: number; onDone(choice: HangChoice): void }) {
  const init = opts.initial;
  const fromComputer = !!init && !!uploadName(init.url);
  const urlIn = h('input.input', { id: 'hang-url', type: 'text', placeholder: 'https://…/picture.png', 'aria-label': 'Image link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const titleIn = h('input.input', { id: 'hang-title', type: 'text', maxlength: 80, placeholder: 'Optional', 'aria-label': 'Title', autocomplete: 'off' }) as HTMLInputElement;
  const fileIn = h('input', { type: 'file', accept: PICTURE_ACCEPT, hidden: true, 'aria-hidden': 'true', tabindex: -1, id: 'hang-file' }) as HTMLInputElement;
  urlIn.value = init && !fromComputer ? init.url : '';
  titleIn.value = init?.title ?? '';
  let frame = init?.frame ?? lastFrame();
  /** Index into SHAPES (-1 for none of them); settled once an edited picture's image loads. */
  let shapeI = 0;
  let shapeKnown = !init;
  /** An edited picture keeps its exact shape until its shape or image is changed. */
  let keepShape = !!init;
  let size = init ? Math.max(init.w, init.h) : (opts.size ?? 1.2);
  const choose = h('button.btn.primary', { type: 'button', id: 'hang-choose' }, 'Choose from your computer…');
  const frames = h('div.seg.hang-frames', { role: 'radiogroup', 'aria-label': 'Frame' });
  const shapes = h('div.seg.hang-shapes', { role: 'radiogroup', 'aria-label': 'Shape' });
  const sizes = h('div.seg.hang-sizes', { role: 'radiogroup', 'aria-label': 'Size' });
  const sizeHint = h('p.field-hint', {});
  const stage = h('div.hang-stage', { id: 'hang-stage' });
  const status = h('p.field-hint', { id: 'hang-status', role: 'status' }, TIP);
  const submit = h('button.btn.primary', { type: 'submit', disabled: true }, init ? 'Save' : 'Pick a spot on the wall →') as HTMLButtonElement;
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const form = h(
    'form.modal.hang',
    { role: 'dialog', 'aria-label': init ? 'Edit picture' : 'Hang a picture' },
    h(
      'header',
      {},
      h('div.titles', {}, h('h2', {}, init ? 'Edit picture' : 'Hang a picture'), h('p.sub', {}, init ? 'Change its image, title, frame, shape or size.' : 'A photo from your computer or any image from the web, framed on the office wall.')),
      close,
    ),
    h(
      'div.body.stack',
      {},
      h('div.field', {}, stage, status, fileIn),
      h('div.field', {}, h('label', { for: 'hang-url' }, 'Image link'), urlIn, h('p.field-hint', {}, LINK_TIP)),
      h('div.field', {}, h('label', { for: 'hang-title' }, 'Title'), titleIn),
      h('div.field', {}, h('label', {}, 'Frame'), frames),
      h('div.field', {}, h('label', {}, 'Shape'), shapes, h('p.field-hint', {}, 'Original keeps the whole image. Another shape crops it to fill the frame, from the middle.')),
      h('div.field', {}, h('label', {}, 'Size'), sizes, sizeHint),
    ),
    h('footer', {}, h('span.grow', {}, init ? '' : 'Then aim at a wall and click.'), cancel, submit),
  ) as HTMLFormElement;

  let pic: Picture | null = null;
  /** Where the picture came from, said under it. */
  let from = '';
  let release = () => {};
  let seq = 0;
  let loading = false;
  /** Enter was pressed before the image loaded: go on as soon as it does. */
  let submitWhenLoaded = false;

  const shape = () => (keepShape && init ? init.w / init.h : SHAPES[shapeI]?.ratio || pic?.aspect || 4 / 3);

  const paintStage = () => {
    if (!pic) {
      stage.classList.remove('has-picture');
      stage.replaceChildren(h('div.hang-empty', {}, h('span.hang-empty-icon', { 'aria-hidden': 'true' }, '🖼️'), h('b', {}, 'Drop a picture here'), h('small', {}, `or paste one with ${PASTE_KEY}`), choose));
      return;
    }
    stage.classList.add('has-picture');
    stage.style.setProperty('--frame', FRAMES[frame].color);
    // Shapes past 5:1 are clamped on the wall too (pictureSize).
    stage.style.setProperty('--shape', String(Math.min(5, Math.max(0.2, shape()))));
    const img = h('img', { src: pic.src, alt: 'Preview' });
    stage.replaceChildren(
      h('div.hang-frame', {}, img),
      h('div.hang-meta', {}, h('span.grow', { title: from }, from ? `${from} · ${pic.width} × ${pic.height} px` : `${pic.width} × ${pic.height} px`), h('button.btn.sm', { type: 'button', onclick: () => fileIn.click() }, 'Choose another…')),
    );
  };

  const paintSizeHint = () => {
    const { w, h: ht } = pictureSize(size, shape());
    sizeHint.textContent = `About ${meters(w)} wide and ${meters(ht)} tall on the wall. Scroll while you aim to fine-tune it.`;
  };

  const paintFrames = () => {
    frames.replaceChildren(
      ...FRAMES.map((f, i) => h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(i === frame), class: i === frame ? 'on' : '', onclick: () => ((frame = i), paintFrames(), paintStage()) }, colorDot(f.color), f.name)),
    );
  };
  const paintShapes = () => {
    shapes.replaceChildren(
      ...SHAPES.map((s, i) =>
        h(
          'button.btn',
          { type: 'button', role: 'radio', 'aria-checked': String(i === shapeI), class: i === shapeI ? 'on' : '', onclick: () => ((shapeI = i), (shapeKnown = true), (keepShape = false), paintShapes(), paintStage(), paintSizeHint()) },
          s.name,
        ),
      ),
    );
  };
  const paintSizes = () => {
    sizes.replaceChildren(
      ...SIZES.map((s) => {
        const on = Math.abs(s.size / size - 1) < 0.01;
        return h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '', onclick: () => ((size = s.size), paintSizes(), paintSizeHint()) }, s.name);
      }),
    );
  };
  paintFrames();
  paintShapes();
  paintSizes();
  paintSizeHint();
  paintStage();

  const setStatus = (text: string, kind: '' | 'loading' | 'error' = '') => {
    status.className = kind === 'error' ? 'field-error' : 'field-hint';
    status.hidden = !text;
    status.replaceChildren(kind === 'loading' ? h('span.spinner') : '', text);
  };

  /** Forgets the picture shown, for a new one to take its place. */
  const reset = () => {
    const my = ++seq;
    loading = false;
    pic = null;
    submit.disabled = true;
    release();
    release = () => {};
    paintStage();
    return my;
  };

  /** Shows the picture at `url` (a link, or one the office keeps) once it loads. */
  const show = async (my: number, url: string, label: string) => {
    release = holdPicture(url);
    loading = true;
    try {
      const p = await loadPicture(url);
      if (my !== seq) return;
      loading = false;
      pic = p;
      from = label;
      if (!shapeKnown && init) {
        shapeI = shapeIndex(init.w / init.h, p.aspect);
        shapeKnown = true;
      }
      if (keepShape && init && url !== init.url) {
        keepShape = false;
        if (shapeI < 0) shapeI = 0;
      }
      paintShapes();
      paintStage();
      paintSizeHint();
      setStatus('');
      submit.disabled = false;
      if (submitWhenLoaded) finish();
    } catch (err) {
      if (my !== seq) return;
      loading = false;
      submitWhenLoaded = false;
      setStatus((err as Error).message, 'error');
    }
  };

  const load = async () => {
    const my = reset();
    const raw = urlIn.value.trim();
    if (!raw) return setStatus(TIP);
    const checked = checkImageUrl(raw);
    if ('error' in checked) return setStatus(checked.error, 'error');
    setStatus('Loading the image…', 'loading');
    let host = '';
    try {
      host = new URL(checked.url).host;
    } catch {
      // checked above
    }
    await show(my, checked.url, host ? `From ${host}` : 'From the web');
  };

  const useFile = async (file: File) => {
    clearTimeout(timer);
    submitWhenLoaded = false;
    urlIn.value = '';
    // The picture already chosen stays until this one is ready, so a file that won't open loses nothing.
    const my = ++seq;
    submit.disabled = true;
    setStatus(`Getting “${file.name || 'your picture'}” ready…`, 'loading');
    let url: string;
    try {
      url = await uploadPicture(file);
    } catch (err) {
      if (my !== seq) return;
      submit.disabled = !pic;
      setStatus(`${(err as Error).message}${pic ? ' The picture you had is still here.' : ''}`, 'error');
      return;
    }
    if (my !== seq) return;
    await show(reset(), url, file.name || 'From your computer');
  };

  choose.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => {
    const file = fileIn.files?.[0];
    // Cleared so choosing the same file again still counts as a change.
    fileIn.value = '';
    if (file) void useFile(file);
  });

  let timer = 0;
  urlIn.addEventListener('input', () => {
    submitWhenLoaded = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => void load(), 350);
  });
  // With the button disabled, Enter wouldn't submit the form at all.
  for (const input of [urlIn, titleIn]) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || pic) return;
      e.preventDefault();
      if (!urlIn.value.trim()) return;
      submitWhenLoaded = true;
      if (!loading) {
        clearTimeout(timer);
        void load();
      }
    });
  }
  // A picture pasted anywhere in the window (a screenshot, or an image copied in the Finder or a browser).
  form.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (!files?.length) return;
    e.preventDefault();
    const file = pictureFile(e.clipboardData);
    if (file) void useFile(file);
    else setStatus(notPicture(files[0]), 'error');
  });

  const modal = openModal(form, {
    doing: '🖼️ hanging a picture',
    onClose: () => {
      seq++;
      clearTimeout(timer);
      release();
    },
  });
  // Drops anywhere over the window and around it: a file let go of outside the form would otherwise
  // open in the page (or the Mac app) in place of the office.
  const dragging = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list');
  modal.backdrop.addEventListener('dragover', (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    form.classList.add('dropping');
  });
  modal.backdrop.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !modal.backdrop.contains(e.relatedTarget as Node)) form.classList.remove('dropping');
  });
  modal.backdrop.addEventListener('drop', (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    form.classList.remove('dropping');
    const files = e.dataTransfer?.files;
    if (files?.length) {
      const file = pictureFile(e.dataTransfer);
      if (file) void useFile(file);
      else setStatus(notPicture(files[0]), 'error');
      return;
    }
    const link = droppedLink(e.dataTransfer);
    if (!link) return;
    urlIn.value = link;
    void load();
  });
  close.addEventListener('click', () => modal.close());
  cancel.addEventListener('click', () => modal.close());
  const finish = () => {
    if (!pic) return;
    try {
      localStorage.setItem(FRAME_KEY, String(frame));
    } catch {
      // storage blocked
    }
    const choice = { picture: pic, title: titleIn.value.trim(), frame, shape: shape(), size };
    modal.close();
    opts.onDone(choice);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    finish();
  });
  if (fromComputer && init) {
    setStatus('Loading the picture…', 'loading');
    void show(reset(), init.url, 'From your computer');
  } else if (urlIn.value) void load();
  setTimeout(() => (init ? titleIn : choose).focus(), 30);
}
/** A closer look at a picture on the wall, with who hung it and ways to move, edit or take it down. */
export function openPicture(d: Decoration, actions: { move(): void; edit(): void; remove(): void }) {
  const release = holdPicture(d.url);
  const stage = h('div.picture-stage', {}, h('span.spinner'));
  loadPicture(d.url).then(
    (pic) => stage.replaceChildren(h('img', { src: pic.src, alt: d.title ?? 'Picture' })),
    (err) => stage.replaceChildren(h('p.note.bad', {}, (err as Error).message)),
  );
  const local = !!uploadName(d.url);
  const link = h('a.btn.ghost', { href: local ? imageUrl(d.url) : d.url, target: '_blank', rel: 'noopener noreferrer' }, local ? 'Open full size ↗' : 'Open the original ↗');
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const takeDown = h('button.btn.danger', { type: 'button' }, 'Take down');
  const edit = h('button.btn', { type: 'button' }, 'Edit');
  const move = h('button.btn.primary', { type: 'button' }, 'Move');
  const el = h(
    'div.modal.xl.picture',
    { role: 'dialog', 'aria-label': d.title || 'Picture' },
    h('header', {}, h('div.titles', {}, h('h2', {}, d.title || 'A picture'), h('p.sub', {}, `Hung by ${d.by} · ${timeAgo(d.at)}`)), close),
    h('div.body', {}, stage),
    h('footer', {}, h('div.grow', {}, takeDown), link, edit, move),
  );
  // Someone else took it down while you were looking.
  const unsub = store.on('decor', () => {
    if (!store.decor.some((x) => x.id === d.id)) modal.close();
  });
  const modal = openModal(el, {
    onClose: () => {
      unsub();
      release();
    },
  });
  close.addEventListener('click', () => modal.close());
  move.addEventListener('click', () => {
    modal.close();
    actions.move();
  });
  edit.addEventListener('click', () => {
    modal.close();
    actions.edit();
  });
  takeDown.addEventListener('click', () =>
    confirmDialog('Take this picture down?', 'It comes off the wall for everyone.', 'Take down', () => {
      modal.close();
      actions.remove();
    }),
  );
}
