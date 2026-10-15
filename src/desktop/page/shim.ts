/**
 * Runs inside the office page, in its main world, when the Mac app shows the page through an offscreen window
 * (`Page.addScriptToEvaluateOnNewDocument`, see `presenter-input.ts`). An offscreen page has no native view behind it, so
 * three things a browser window gives for free are rebuilt here, and the office page itself stays unchanged:
 *
 * - Pointer lock. Chromium refuses `requestPointerLock()` in an offscreen page, so this script answers it: the request goes to
 *   the main process (which decides by the rules in `input-lock.ts` and captures the real mouse), and the answer comes back
 *   as `pointerlockchange`, `pointerlockerror`, `document.pointerLockElement` and the promise `requestPointerLock` returns.
 * - `<select>` menus and `title` tooltips, which Chromium shows with native widgets an offscreen page does not have. They are
 *   drawn in the page, so they are part of the frame.
 * - A report of where the caret is while a text field has focus, which the input method needs to place its candidate window.
 *
 * This file is compiled on its own (`tsconfig.desktop-page.json`, DOM types) into a plain script, and the main process reads
 * it at startup. It cannot import anything. The page-to-main channel is the one binding `__droidOfficeHost`, and the main
 * process accepts a short fixed list of messages from it (`input-bridge.ts`); nothing else of the app is reachable from here.
 */
(() => {
  type Host = (message: string) => void;
  type Api = { granted(id: number, raw: boolean): void; denied(id: number, error: string): void; revoked(): void };

  const w = window as unknown as Record<string | symbol, unknown>;
  if (window !== window.top || w[Symbol.for('droid-office.shim')]) return;
  const send = w.__droidOfficeHost as Host | undefined;
  if (typeof send !== 'function') return;
  // The channel is for this script only: the page's own code has no use for it.
  delete w.__droidOfficeHost;
  const post = (message: Record<string, unknown>) => send(JSON.stringify(message));

  // --- Pointer lock -------------------------------------------------------------------------------------------------
  let lockElement: Element | null = null;
  let nextId = 1;
  const pending = new Map<number, { element: Element; resolve: () => void; reject: (e: DOMException) => void }>();

  const fire = (type: string) => document.dispatchEvent(new Event(type));

  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, enumerable: true, get: () => lockElement });
  Element.prototype.requestPointerLock = function requestPointerLock(this: Element, options?: { unadjustedMovement?: boolean }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.isConnected) {
        reject(new DOMException('The element is not in the document.', 'InvalidStateError'));
        fire('pointerlockerror');
        return;
      }
      const id = nextId++;
      pending.set(id, { element: this, resolve, reject });
      post({ t: 'lock', id, raw: options?.unadjustedMovement === true, activation: (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? false });
    });
  } as typeof Element.prototype.requestPointerLock;
  Document.prototype.exitPointerLock = function exitPointerLock() {
    if (lockElement) post({ t: 'exit' });
  };

  const api: Api = {
    granted(id) {
      const request = pending.get(id);
      pending.delete(id);
      if (!request) return;
      const changed = lockElement !== request.element;
      lockElement = request.element;
      if (changed) fire('pointerlockchange');
      request.resolve();
    },
    denied(id, error) {
      const request = pending.get(id);
      pending.delete(id);
      if (!request) return;
      request.reject(new DOMException(error === 'NotSupportedError' ? 'Unadjusted movement is not supported.' : 'The pointer lock request was not allowed.', error));
      fire('pointerlockerror');
    },
    revoked() {
      if (!lockElement) return;
      lockElement = null;
      fire('pointerlockchange');
    },
  };
  Object.defineProperty(window, Symbol.for('droid-office.shim'), { value: api, enumerable: false });

  // An Esc the page took (the one that closes a window and relocks) must not also let go of the mouse.
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Escape' && lockElement) post({ t: 'escUp', prevented: e.defaultPrevented });
  });

  // --- Text focus and caret -----------------------------------------------------------------------------------------
  const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'number', '']);
  const editableTarget = (el: Element | null): Element | null => {
    if (!el) return null;
    if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
    if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled ? el : null;
    return el instanceof HTMLElement && el.isContentEditable ? el : null;
  };
  let reported = '';
  let reportQueued = false;
  const report = () => {
    reportQueued = false;
    const el = editableTarget(document.activeElement);
    let message: Record<string, unknown>;
    if (!el) message = { t: 'editable', on: false, x: 0, y: 0, w: 0, h: 0 };
    else {
      let rect = el.getBoundingClientRect();
      const sel = window.getSelection();
      if (el instanceof HTMLElement && el.isContentEditable && sel?.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width || r.height) rect = r;
      }
      message = { t: 'editable', on: true, x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    const key = JSON.stringify(message);
    if (key === reported) return;
    reported = key;
    post(message);
  };
  const queueReport = () => {
    if (reportQueued) return;
    reportQueued = true;
    requestAnimationFrame(report);
  };
  for (const type of ['focusin', 'focusout', 'input', 'compositionupdate', 'scroll', 'resize']) window.addEventListener(type, queueReport, true);
  document.addEventListener('selectionchange', queueReport);

  // --- <select> menus -----------------------------------------------------------------------------------------------
  interface Row {
    option: HTMLOptionElement | null;
    label: string;
    el: HTMLElement;
  }
  let menu: { select: HTMLSelectElement; host: HTMLElement; rows: Row[]; active: number; close: () => void } | null = null;
  const plainSelect = (t: EventTarget | null): HTMLSelectElement | null => (t instanceof HTMLSelectElement && !t.multiple && t.size <= 1 && !t.disabled ? t : null);

  // Registered once, here, ahead of every script the page runs: a window with its own capturing Esc handler (the office's)
  // would otherwise hear the key first and close the window the list belongs to.
  let menuKey: ((e: KeyboardEvent) => void) | null = null;
  // A key the list took on its way down is not heard coming up either, as with a native menu.
  const consumed = new Set<string>();
  window.addEventListener('blur', () => consumed.clear());
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        const key = e as KeyboardEvent;
        if (type === 'keyup' && consumed.delete(key.code)) {
          key.stopImmediatePropagation();
          return;
        }
        menuKey?.(key);
      },
      true,
    );
  }

  const closeMenu = () => menu?.close();
  const openMenu = (select: HTMLSelectElement) => {
    closeMenu();
    const style = getComputedStyle(select);
    const rgb = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/.exec(style.backgroundColor);
    const dark = !rgb || Number(rgb[4] ?? 1) < 0.5 || Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3]) < 384;
    const bg = dark ? '#2a2a2e' : '#ffffff';
    const fg = dark ? '#f2f2f2' : '#1d1d1f';
    const hover = '#0a64d9';
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    list.style.cssText = `position:fixed;box-sizing:border-box;overflow:auto;padding:4px;border-radius:8px;background:${bg};color:${fg};font:${style.font || '13px system-ui'};box-shadow:0 0 0 1px rgba(128,128,128,.35),0 8px 24px rgba(0,0,0,.35);outline:none`;
    const rows: Row[] = [];
    const addRow = (option: HTMLOptionElement | null, label: string, disabled: boolean, indent: boolean) => {
      const el = document.createElement('div');
      el.textContent = label || '\u00a0';
      el.style.cssText = `padding:3px 10px 3px ${indent ? 22 : 10}px;border-radius:5px;white-space:nowrap;cursor:default;${disabled ? 'opacity:.5;' : ''}${option ? '' : 'font-weight:600;'}`;
      if (option) el.setAttribute('role', 'option');
      list.append(el);
      rows.push({ option: disabled ? null : option, label, el });
      return rows.length - 1;
    };
    let selected = 0;
    for (const child of Array.from(select.children)) {
      if (child instanceof HTMLOptGroupElement) {
        addRow(null, child.label, true, false);
        for (const o of Array.from(child.children)) if (o instanceof HTMLOptionElement) addRow(o, o.text, o.disabled || child.disabled, true);
      } else if (child instanceof HTMLOptionElement) {
        addRow(child, child.text, child.disabled, false);
      }
    }
    rows.forEach((r, i) => {
      if (r.option && r.option === select.options[select.selectedIndex]) selected = i;
    });
    const paint = (active: number) => {
      rows.forEach((r, i) => {
        r.el.style.background = i === active && r.option ? hover : 'transparent';
        r.el.style.color = i === active && r.option ? '#fff' : fg;
      });
      rows[active]?.el.scrollIntoView({ block: 'nearest' });
    };
    const state = { select, host, rows, active: selected, close: () => {} };
    const choose = (i: number) => {
      const row = rows[i];
      if (!row?.option) return;
      state.close();
      if (select.selectedIndex !== row.option.index) {
        select.selectedIndex = row.option.index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      select.focus();
    };
    const step = (from: number, dir: number) => {
      for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (rows[i]?.option) return i;
      return from;
    };
    const onKey = (e: KeyboardEvent) => {
      // Nothing under the menu (the camera keys, the terminal) hears a key meant for it.
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      if (e.key === 'Escape' || e.key === 'Tab') state.close();
      else if (e.key === 'ArrowDown') paint((state.active = step(state.active, 1)));
      else if (e.key === 'ArrowUp') paint((state.active = step(state.active, -1)));
      else if (e.key === 'Home') paint((state.active = step(-1, 1)));
      else if (e.key === 'End') paint((state.active = step(rows.length, -1)));
      else if (e.key === 'Enter' || e.key === ' ') choose(state.active);
      else return;
      consumed.add(e.code);
      e.preventDefault();
    };
    const onOutside = (e: Event) => {
      if (e.composedPath().includes(host)) return;
      state.close();
    };
    state.close = () => {
      menu = null;
      menuKey = null;
      window.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('blur', state.close);
      window.removeEventListener('wheel', onOutside, true);
      host.remove();
    };
    rows.forEach((r, i) => {
      r.el.addEventListener('mousemove', () => r.option && state.active !== i && paint((state.active = i)));
      r.el.addEventListener('mouseup', () => choose(i));
      r.el.addEventListener('mousedown', (e) => e.preventDefault());
    });
    root.append(list);
    document.documentElement.append(host);
    const box = select.getBoundingClientRect();
    list.style.minWidth = `${box.width}px`;
    const room = { below: innerHeight - box.bottom - 8, above: box.top - 8 };
    const height = Math.min(list.scrollHeight + 2, 360);
    const up = room.below < height && room.above > room.below;
    list.style.maxHeight = `${Math.max(80, Math.min(360, up ? room.above : room.below))}px`;
    list.style.left = `${Math.max(4, Math.min(box.left, innerWidth - list.offsetWidth - 4))}px`;
    list.style.top = up ? `${Math.max(4, box.top - list.offsetHeight - 2)}px` : `${box.bottom + 2}px`;
    paint(selected);
    menuKey = onKey;
    window.addEventListener('mousedown', onOutside, true);
    window.addEventListener('wheel', onOutside, { capture: true, passive: true });
    window.addEventListener('blur', state.close);
    menu = state;
  };

  window.addEventListener(
    'mousedown',
    (e) => {
      const select = plainSelect(e.target);
      if (!select || e.button !== 0) return;
      e.preventDefault();
      select.focus();
      openMenu(select);
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (e) => {
      const select = plainSelect(e.target);
      if (!select || menu || e.metaKey || e.ctrlKey) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu(select);
      }
    },
    true,
  );
  HTMLSelectElement.prototype.showPicker = function showPicker(this: HTMLSelectElement) {
    openMenu(this);
  };

  // --- title tooltips -----------------------------------------------------------------------------------------------
  const TIP_DELAY = 700;
  let tipTimer = 0;
  let tip: HTMLElement | null = null;
  let tipAt = { x: 0, y: 0 };
  const hideTip = () => {
    clearTimeout(tipTimer);
    tip?.remove();
    tip = null;
  };
  const showTip = (text: string) => {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:fixed;z-index:2147483647;max-width:360px;padding:4px 8px;border-radius:6px;background:#2a2a2e;color:#f2f2f2;font:12px system-ui;box-shadow:0 0 0 1px rgba(128,128,128,.35),0 4px 12px rgba(0,0,0,.35);pointer-events:none;white-space:pre-wrap';
    document.documentElement.append(el);
    el.style.left = `${Math.max(4, Math.min(tipAt.x + 12, innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(tipAt.y + 18, innerHeight - el.offsetHeight - 4))}px`;
    tip = el;
  };
  window.addEventListener(
    'mousemove',
    (e) => {
      if (Math.abs(e.clientX - tipAt.x) < 3 && Math.abs(e.clientY - tipAt.y) < 3 && (tip || tipTimer)) return;
      tipAt = { x: e.clientX, y: e.clientY };
      hideTip();
      if (lockElement || menu || e.buttons) return;
      const owner = e.target instanceof Element ? e.target.closest('[title]') : null;
      const text = owner?.getAttribute('title')?.trim();
      if (text) tipTimer = window.setTimeout(() => showTip(text), TIP_DELAY);
    },
    true,
  );
  for (const type of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(type, hideTip, true);
  document.addEventListener('mouseleave', hideTip);
})();
