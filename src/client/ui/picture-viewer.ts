import { h, openModal, type Modal } from './dom';
import { windowHeader } from './kit';

export interface ViewPictureOpts {
  width?: number;
  height?: number;
  about?: string;
  onClose?: () => void;
}

/** A picture at full size, over everything, until Esc, a click outside it or ✕. */
export function viewPicture(src: string, title: string, opts: ViewPictureOpts = {}): Modal {
  const full = h('img.wt-picture-full', { src, alt: title, width: opts.width, height: opts.height, draggable: 'false' });
  const sub = [opts.about, opts.width && opts.height ? `${opts.width} × ${opts.height}` : ''].filter(Boolean).join(' · ') || undefined;
  return openModal(h('div.modal.wt-picture-window', { 'aria-label': title }, windowHeader(title, sub), h('div.body.flush.wt-picture-body', {}, full)), { size: 'full', backdropCloses: true, onClose: opts.onClose });
}
