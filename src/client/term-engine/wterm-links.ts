import type { GhosttyCore } from '@wterm/ghostty';
import { toast } from '../ui/dom';
import type { TerminalPaths } from '../ui/terminal-path-links';
import type { TerminalFind } from './types';
import type { WTermAdapter } from './wterm';
import { nativeLinkPanes } from './wterm-appearance';
import { installFind, missingLine } from './wterm-links-find';
import type { Point } from './wterm-links-lines';
import { type Target, targetAt } from './wterm-links-target';

type Action = (e: MouseEvent) => void;
type XY = Pick<MouseEvent, 'clientX' | 'clientY'>;
const modified = (e: MouseEvent | KeyboardEvent) => e.ctrlKey || e.metaKey;
const same = (a: Target, b: Target | undefined) => a.kind === b?.kind && a.label === b.label && a.text === b.text;
const anchorAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLAnchorElement>('a.term-link') : null);

function installPointer(adapter: WTermAdapter, core: GhosttyCore, grid: HTMLElement, signal: AbortSignal, paths: TerminalPaths) {
  const root = grid.parentElement!;
  const options = { signal, capture: true };
  const point = (e: XY): Point => {
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(root);
    return { x: 1 + Math.floor((e.clientX - rect.left) / parseFloat(style.getPropertyValue('--term-cell-width'))), y: 1 + Math.floor((e.clientY - rect.top) / parseFloat(style.getPropertyValue('--term-row-height'))) };
  };
  // HTTP(S) activation stays synchronous for the browser's popup/user gesture policy.
  function resolve(target: Target, ready: (action?: Action) => void, activate = false) {
    const { kind, text } = target;
    if (kind === 'web')
      return ready(() => {
        window.open(text, '_blank', 'noopener,noreferrer');
      });
    void paths.resolveTarget(text, kind === 'osc8').then(
      (open) => ready(open),
      (error: unknown) => ready(activate && kind === 'osc8' ? () => toast(error instanceof Error ? error.message : 'Could not open file.', 'error') : undefined),
    );
  }
  let pointer: XY | undefined,
    hovered: Target | undefined,
    modifier = false;
  let pending = 0;
  function clearHover() {
    if (!hovered) return;
    pending++;
    hovered = undefined;
    root.classList.remove('wterm-link-hover');
    root.removeAttribute('title');
    for (const el of grid.querySelectorAll('.wterm-link-range')) el.classList.remove('wterm-link-range');
  }
  function hover() {
    if (!pointer || !modifier || anchorAt(document.elementFromPoint(pointer.clientX, pointer.clientY))) return clearHover();
    const t = targetAt(core, point(pointer));
    if (hovered && t && same(hovered, t) && hovered.range.start.x === t.range.start.x && hovered.range.start.y === t.range.start.y && hovered.range.end.x === t.range.end.x && hovered.range.end.y === t.range.end.y) return;
    clearHover();
    if (!t) return;
    hovered = t;
    const own = pending;
    resolve(t, (action) => {
      if (!action || own !== pending || signal.aborted) return;
      const { start, end } = t.range;
      root.classList.add('wterm-link-hover');
      root.title = `Cmd/Ctrl-click to open ${t.text}`;
      const height = parseFloat(getComputedStyle(root).getPropertyValue('--term-row-height'));
      for (const el of grid.querySelectorAll<HTMLElement>('.term-row')) {
        const y = 1 + Math.round(el.offsetTop / height);
        if (y < start.y || y > end.y) continue;
        const left = y === start.y ? start.x - 1 : 0;
        el.style.setProperty('--link-start', String(left));
        el.style.setProperty('--link-length', String((y === end.y ? end.x : adapter.cols) - left));
        el.classList.add('wterm-link-range');
      }
    });
  }
  let press: { at: XY; target: Target } | undefined;
  let nativePress: { at: XY; anchor: HTMLAnchorElement } | undefined;
  let nativeClick: HTMLAnchorElement | undefined;
  root.addEventListener(
    'mousedown',
    (e) => {
      press = nativePress = nativeClick = undefined;
      if (e.button || !modified(e) || core.mouseTracking() || !(e.target instanceof Node && grid.contains(e.target))) return;
      const anchor = anchorAt(e.target);
      if (anchor) {
        nativePress = { at: e, anchor };
        return;
      }
      const target = targetAt(core, point(e));
      if (target) press = { at: e, target };
    },
    options,
  );
  root.addEventListener(
    'mousemove',
    (e) => {
      if (press && Math.hypot(e.clientX - press.at.clientX, e.clientY - press.at.clientY) > 3) press = undefined;
      if (nativePress && Math.hypot(e.clientX - nativePress.at.clientX, e.clientY - nativePress.at.clientY) > 3) nativePress = undefined;
      pointer = e;
      modifier = modified(e) && !e.buttons;
      hover();
    },
    options,
  );
  const leave = () => {
    press = nativePress = nativeClick = pointer = undefined;
    clearHover();
  };
  root.addEventListener('mouseleave', leave, { signal });
  root.addEventListener('dragstart', leave, options);
  window.addEventListener('blur', leave, { signal });
  for (const event of ['keydown', 'keyup'] as const)
    window.addEventListener(
      event,
      (e) => {
        if (modified(e) !== modifier) {
          modifier = modified(e);
          hover();
        }
      },
      options,
    );
  root.addEventListener('scroll', leave, { signal });
  adapter.onReset(leave);
  adapter.onWriteParsed(() => {
    if (press && !same(press.target, targetAt(core, point(press.at)))) press = undefined;
    if (pointer && modifier) hover();
  });
  // WTerm owns keyboard and platform modifier activation. Keep the Office mouse
  // gesture fence (including drag-out-and-back) and its other modifier.
  root.addEventListener(
    'click',
    (e) => {
      const anchor = anchorAt(e.target);
      if (!anchor) return;
      const keyboard = e.detail === 0 && anchor === document.activeElement;
      if (!e.isTrusted || core.mouseTracking() || !(keyboard || (anchor === nativeClick && modified(e)))) e.preventDefault();
      nativeClick = undefined;
    },
    options,
  );
  for (const event of ['auxclick', 'contextmenu', 'dragstart'] as const)
    root.addEventListener(
      event,
      (e) => {
        if (anchorAt(e.target)) e.preventDefault();
      },
      options,
    );
  root.addEventListener(
    'mouseup',
    (e) => {
      const native = nativePress;
      nativePress = undefined;
      if (native && native.anchor === anchorAt(e.target) && modified(e) && !e.button && !core.mouseTracking() && Math.hypot(e.clientX - native.at.clientX, e.clientY - native.at.clientY) <= 3) {
        if (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) nativeClick = native.anchor;
        // Chromium on macOS delivers Ctrl+mouseup without a click.
        else if (e.isTrusted) window.open(native.anchor.href, '_blank', 'noopener,noreferrer');
        return;
      }
      const down = press;
      press = undefined;
      if (!down || !modified(e) || e.button || !(e.target instanceof Node && grid.contains(e.target))) return;
      const at = point(e);
      const current = targetAt(core, at);
      if (!current || !same(down.target, current) || Math.hypot(e.clientX - down.at.clientX, e.clientY - down.at.clientY) > 3) return;
      e.preventDefault();
      if (current.kind === 'web') {
        resolve(current, (action) => action?.(e));
        return;
      }
      const tracked = core.trackPosition({ row: at.y - 1, col: at.x - 1 });
      if (!tracked) return;
      const valid = () => {
        const p = tracked.resolve();
        return p && same(current, targetAt(core, { x: p.col + 1, y: p.row + 1 }));
      };
      // Cancel an edit of THIS target, not shell output arriving elsewhere during the lookup.
      let cancelled = false;
      const sub = adapter.onWriteParsed(() => {
        if (!valid()) cancelled = true;
      });
      resolve(
        current,
        (action) => {
          sub.dispose();
          if (signal.aborted) return; // adapter already disposed the entire core
          try {
            if (!cancelled && valid()) action?.(e);
          } finally {
            tracked.dispose();
          }
        },
        true,
      );
    },
    options,
  );
  signal.addEventListener('abort', () => paths.dispose(), { once: true });
}

export function attachWtermLinks(adapter: WTermAdapter, paths?: TerminalPaths) {
  if (paths) nativeLinkPanes.add(adapter);
  let find: (hit: TerminalFind) => string | undefined = () => missingLine;
  adapter.onOpen((native, signal) => {
    const grid = native.element.querySelector<HTMLElement>('.term-grid')!;
    const core = adapter.core!;
    find = installFind(adapter, core, grid, signal);
    if (paths) installPointer(adapter, core, grid, signal, paths);
  });
  return { find: (hit: TerminalFind) => find(hit) };
}
