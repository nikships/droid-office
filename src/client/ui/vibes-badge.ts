import { FLOOR_MOOD_LIGHTING, type FloorMood } from '../../shared/gemini-vibes';
import { h } from './dom';

export type VibesBadgeView = { mode: 'hidden' } | { mode: 'off' } | { mode: 'rejected' } | { mode: 'on'; mood: FloorMood; stakes: number; desks: number; note?: string };

/**
 * The Living 3D switch in the corner of the 3D view: lit in the room's mood color with a beating dot
 * and a meter of how much is riding on the floor while it runs, gray and dashed while it is off. A click turns it on or off
 * (or, with a rejected key, opens Settings).
 */
export function vibesBadge(opts: { toggle: (on: boolean) => void; settings: () => void }) {
  const dot = h('span.vb-dot', { 'aria-hidden': 'true' });
  const name = h('span.vb-name', {}, 'Living 3D');
  const state = h('span.vb-state');
  const detail = h('span.vb-detail');
  const bars = Array.from({ length: 5 }, () => h('i'));
  const meter = h('span.vb-meter', { 'aria-hidden': 'true' }, ...bars);
  const el = h('button.vibes-badge.hidden', { type: 'button', id: 'vibes-badge' }, dot, name, state, detail, meter);
  let mode: VibesBadgeView['mode'] = 'hidden';

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mode === 'rejected') opts.settings();
    else if (mode === 'on' || mode === 'off') opts.toggle(mode === 'off');
  });

  const restart = (cls: string) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  return {
    el,
    get mode() {
      return mode;
    },
    paint(view: VibesBadgeView) {
      const was = mode;
      mode = view.mode;
      el.classList.toggle('hidden', mode === 'hidden');
      el.classList.toggle('off', mode === 'off');
      el.classList.toggle('rejected', mode === 'rejected');
      el.setAttribute('aria-pressed', String(mode === 'on'));
      if (view.mode === 'on') {
        const spec = FLOOR_MOOD_LIGHTING[view.mood] ?? FLOOR_MOOD_LIGHTING.calm_planning;
        el.style.setProperty('--vb', spec.accent);
        state.textContent = 'On';
        detail.textContent = view.note ?? (view.desks ? `${spec.label} · ${view.desks} ${view.desks === 1 ? 'desk' : 'desks'}` : 'Watching for busy desks');
        const lit = Math.max(1, Math.round(view.stakes * 5));
        bars.forEach((b, i) => b.classList.toggle('on', view.desks > 0 && i < lit));
        meter.classList.remove('hidden');
        el.title = 'Living 3D is on: Gemini Decisions grades the desks and the room reacts. Click to turn it off.';
      } else if (view.mode === 'off') {
        el.style.removeProperty('--vb');
        state.textContent = 'Off';
        detail.textContent = 'Room stays neutral';
        meter.classList.add('hidden');
        el.title = 'Living 3D is off: no Gemini calls, neutral lighting and postures. Click to turn it on.';
      } else if (view.mode === 'rejected') {
        el.style.removeProperty('--vb');
        state.textContent = 'Paused';
        detail.textContent = 'Gemini key rejected';
        meter.classList.add('hidden');
        el.title = 'Google AI Studio rejected the Gemini key. Click to open Settings.';
      }
      if (was !== 'hidden' && was !== mode && mode !== 'hidden') restart('flip');
    },
    /** A fresh grade arrived: the dot beats once. */
    beat() {
      if (mode === 'on') restart('beat');
    },
  };
}
