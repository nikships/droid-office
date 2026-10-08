import { FRAMES, checkImageUrl, type Decoration } from '../../shared/decor';
import { store } from '../state';
import { holdPicture, loadPicture, type Picture } from '../world/gallery';
import { h, openModal, timeAgo } from './dom';
import { colorDot } from './kit';
import { confirmDialog } from './prompt';

export interface HangChoice {
  picture: Picture;
  title: string;
  frame: number;
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

const TIP = 'Paste a link to an image. Online, right-click any picture and choose “Copy image address”.';

/** Pick an image, a title and a frame. Editing a picture (`initial`) fills them in. */
export function openHangDialog(opts: { initial?: Decoration; onDone(choice: HangChoice): void }) {
  const init = opts.initial;
  const urlIn = h('input.input', { id: 'hang-url', type: 'text', placeholder: 'https://…/picture.png', 'aria-label': 'Image link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const titleIn = h('input.input', { id: 'hang-title', type: 'text', maxlength: 80, placeholder: 'Optional', 'aria-label': 'Title', autocomplete: 'off' }) as HTMLInputElement;
  urlIn.value = init?.url ?? '';
  titleIn.value = init?.title ?? '';
  let frame = init?.frame ?? lastFrame();
  const frames = h('div.seg.hang-frames', { role: 'radiogroup', 'aria-label': 'Frame' });
  const preview = h('div.hang-preview', { hidden: true });
  const status = h('p.field-hint', {}, TIP);
  const submit = h('button.btn.primary', { type: 'submit', disabled: true }, init ? 'Save' : 'Pick a spot on the wall →') as HTMLButtonElement;
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const form = h(
    'form.modal.hang',
    { role: 'dialog', 'aria-label': init ? 'Edit picture' : 'Hang a picture' },
    h('header', {}, h('div.titles', {}, h('h2', {}, init ? 'Edit picture' : 'Hang a picture'), h('p.sub', {}, init ? 'Change its image, title or frame.' : 'Any image from the web, framed on the office wall.')), close),
    h(
      'div.body.stack',
      {},
      h('div.field', {}, h('label', { for: 'hang-url' }, 'Image link'), urlIn, status),
      h('div.field', {}, h('label', { for: 'hang-title' }, 'Title'), titleIn),
      h('div.field', {}, h('label', {}, 'Frame'), frames),
      preview,
    ),
    h('footer', {}, h('span.grow', {}, init ? '' : 'Then aim at a wall and click.'), cancel, submit),
  ) as HTMLFormElement;

  let pic: Picture | null = null;
  let release = () => {};
  let seq = 0;
  let loading = false;
  /** Enter was pressed before the image loaded: go on as soon as it does. */
  let submitWhenLoaded = false;

  const paintFrames = () => {
    frames.replaceChildren(
      ...FRAMES.map((f, i) => {
        return h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(i === frame), class: i === frame ? 'on' : '', onclick: () => ((frame = i), paintFrames()) }, colorDot(f.color), f.name);
      }),
    );
    preview.style.setProperty('--frame', FRAMES[frame].color);
  };
  paintFrames();

  const setStatus = (text: string, kind: '' | 'loading' | 'error' = '') => {
    status.className = kind === 'error' ? 'field-error' : 'field-hint';
    status.hidden = !text;
    status.replaceChildren(kind === 'loading' ? h('span.spinner') : '', text);
  };

  const load = async () => {
    const my = ++seq;
    loading = false;
    pic = null;
    submit.disabled = true;
    release();
    release = () => {};
    preview.replaceChildren();
    preview.hidden = true;
    const raw = urlIn.value.trim();
    if (!raw) return setStatus(TIP);
    const checked = checkImageUrl(raw);
    if ('error' in checked) return setStatus(checked.error, 'error');
    release = holdPicture(checked.url);
    setStatus('Loading the image…', 'loading');
    loading = true;
    try {
      const p = await loadPicture(checked.url);
      if (my !== seq) return;
      loading = false;
      pic = p;
      preview.replaceChildren(h('img', { src: p.src, alt: 'Preview' }));
      preview.hidden = false;
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

  const modal = openModal(form, {
    doing: '🖼️ hanging a picture',
    onClose: () => {
      seq++;
      clearTimeout(timer);
      release();
    },
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
    const choice = { picture: pic, title: titleIn.value.trim(), frame };
    modal.close();
    opts.onDone(choice);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    finish();
  });
  if (urlIn.value) void load();
  setTimeout(() => (init ? titleIn : urlIn).focus(), 30);
}

/** A closer look at a picture on the wall, with who hung it and ways to move, edit or take it down. */
export function openPicture(d: Decoration, actions: { move(): void; edit(): void; remove(): void }) {
  const release = holdPicture(d.url);
  const stage = h('div.picture-stage', {}, h('span.spinner'));
  loadPicture(d.url).then(
    (pic) => stage.replaceChildren(h('img', { src: pic.src, alt: d.title ?? 'Picture' })),
    (err) => stage.replaceChildren(h('p.note.bad', {}, (err as Error).message)),
  );
  const link = h('a.btn.ghost', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the original ↗');
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
