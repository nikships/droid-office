import type { GhosttyCore } from '@wterm/ghostty';
import type { TerminalPaths } from '../ui/terminal-path-links';
import type { TerminalFind } from './types';
import type { WTermAdapter } from './wterm';
import { installFind, missingLine } from './wterm-links-find';
import type { Point } from './wterm-links-lines';
import { type Target, targetAt } from './wterm-links-target';
import './wterm-links.css';

type Action = (e: MouseEvent) => void;
type XY = Pick<MouseEvent, 'clientX' | 'clientY'>;
const modified = (e: MouseEvent | KeyboardEvent) => e.ctrlKey || e.metaKey;
const same = (a: Target, b: Target | undefined) => a.kind === b?.kind && a.label === b.label && a.text === b.text;

function installPointer(adapter: WTermAdapter, core: GhosttyCore, grid: HTMLElement, signal: AbortSignal, paths: TerminalPaths) {
  const root = grid.parentElement!;
  const options = { signal, capture: true };
  const point = (e: XY): Point => {
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(root);
    return { x: 1 + Math.floor((e.clientX - rect.left) / parseFloat(style.getPropertyValue('--term-cell-width'))), y: 1 + Math.floor((e.clientY - rect.top) / parseFloat(style.getPropertyValue('--term-row-height'))) };
  };
  // HTTP(S) activation stays synchronous for the browser's popup/user gesture policy.
  function resolve(target: Target, ready: (action?: Action) => void) {
    const { kind, text } = target;
    if (kind === 'web' || (kind === 'osc8' && /^https?:\/\//i.test(text)))
      return ready(() => {
        window.open(text, '_blank', 'noopener,noreferrer');
      });
    void paths.resolveTarget(text, kind === 'osc8').then(
      (open) => ready(open),
      () => ready(),
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
    if (!pointer || !modifier) return clearHover();
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
  root.addEventListener(
    'mousedown',
    (e) => {
      press = undefined;
      if (e.button || !modified(e) || !(e.target instanceof Node && grid.contains(e.target))) return;
      const target = targetAt(core, point(e));
      if (target) press = { at: e, target };
    },
    options,
  );
  root.addEventListener(
    'mousemove',
    (e) => {
      if (press && Math.hypot(e.clientX - press.at.clientX, e.clientY - press.at.clientY) > 3) press = undefined;
      pointer = e;
      modifier = modified(e) && !e.buttons;
      hover();
    },
    options,
  );
  const leave = () => {
    press = pointer = undefined;
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
  // Chromium on macOS sends Ctrl+mousedown/up but no click. xterm also
  // activates on mouseup; keep native selection/drag behavior on ordinary presses.
  root.addEventListener(
    'mouseup',
    (e) => {
      const down = press;
      press = undefined;
      if (!down || !modified(e) || e.button || !(e.target instanceof Node && grid.contains(e.target))) return;
      const at = point(e);
      const current = targetAt(core, at);
      if (!current || !same(down.target, current) || Math.hypot(e.clientX - down.at.clientX, e.clientY - down.at.clientY) > 3) return;
      e.preventDefault();
      if (current.kind === 'web' || (current.kind === 'osc8' && /^https?:\/\//i.test(current.text))) {
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
      resolve(current, (action) => {
        sub.dispose();
        if (signal.aborted) return; // adapter already disposed the entire core
        try {
          if (!cancelled && valid()) action?.(e);
        } finally {
          tracked.dispose();
        }
      });
    },
    options,
  );
  signal.addEventListener('abort', () => paths.dispose(), { once: true });
}

export function attachWtermLinks(adapter: WTermAdapter, paths?: TerminalPaths) {
  let find: (hit: TerminalFind) => string | undefined = () => missingLine;
  adapter.onOpen((native, signal) => {
    const grid = native.element.querySelector<HTMLElement>('.term-grid')!;
    const core = adapter.core!;
    find = installFind(adapter, core, grid, signal);
    if (paths) installPointer(adapter, core, grid, signal, paths);
  });
  return { find: (hit: TerminalFind) => find(hit) };
}
