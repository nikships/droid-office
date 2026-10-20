// The script the office injects at the top of every Whiteboard artifact's page (see injectSdk in
// whiteboard.ts): the artifact JavaScript API (`window.whiteboard`), plain form fields saved into
// `state.fields` and restored, `data-wb-action` buttons, and the frame's side of the postMessage
// bridge in shared/whiteboard-bridge.ts (nonce from `#wb=`, messages only from `window.parent`).
// It runs inside the sandboxed frame and depends on nothing outside it, so it is plain browser
// JavaScript in a string. Keep it ES2017, with no template literals (this is a String.raw).

/** Changes whenever the script does, so cached card pages are fetched again. */
export const SDK_VERSION = '6';

export const SDK_SCRIPT = String.raw`(function () {
  'use strict';
  if (window.whiteboard) return;
  var CHANNEL = 'droid-office-whiteboard';
  var VERSION = 1;
  var FIELDS = 'fields';
  var ACTIONS = 'actions';
  var IDLE_MS = 1000;
  var found = /(?:^#|&)wb=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(location.hash);
  var nonce = found ? found[1] : '';
  var host = window.parent !== window ? window.parent : null;
  var state = {};
  var card = { id: '', title: '', author: null };
  var rendering = false;
  var mode = 'use';
  var started = false;
  var listeners = { state: [], ready: [], mode: [] };
  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function copy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function toPath(p) {
    if (p === undefined || p === null || p === '') return [];
    if (Array.isArray(p)) return p.map(String);
    return String(p).split('.');
  }
  function at(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, path[i])) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }
  function walk(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (!isObj(cur[path[i]])) cur[path[i]] = {};
      cur = cur[path[i]];
    }
    return cur;
  }
  function mergeInto(t, s) {
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      if (isObj(v)) {
        if (!isObj(t[k])) t[k] = {};
        mergeInto(t[k], v);
      } else t[k] = v;
    });
  }
  function fire(ev, a, b) {
    listeners[ev].slice().forEach(function (fn) {
      try { fn(a, b); } catch (err) { console.error(err); }
    });
  }
  function post(msg) {
    if (!host || !nonce) return;
    msg.channel = CHANNEL;
    msg.nonce = nonce;
    host.postMessage(msg, '*');
  }

  // ---- State ----

  function applyLocal(w) {
    var last = w.path[w.path.length - 1];
    if (w.op === 'set') {
      if (!w.path.length) state = copy(w.value);
      else walk(state, w.path.slice(0, -1))[last] = copy(w.value);
    } else if (w.op === 'merge') {
      var target = state;
      if (w.path.length) {
        var parent = walk(state, w.path.slice(0, -1));
        if (!isObj(parent[last])) parent[last] = {};
        target = parent[last];
      }
      mergeInto(target, copy(w.value));
    } else {
      var p = at(state, w.path.slice(0, -1));
      if (isObj(p)) delete p[last];
    }
  }
  // The host never echoes the frame's own writes back, so the frame tells its own listeners. A write
  // made from inside a state listener doesn't fire again, so a listener that writes can't loop.
  var firing = false;
  function fireState(changes) {
    if (firing) return;
    firing = true;
    try { fire('state', api.state.get(), changes); } finally { firing = false; }
  }
  function own(path) { return [{ path: path, author: { kind: 'owner' } }]; }
  function write(w) {
    if (rendering) return;
    applyLocal(w);
    post({ type: 'write', write: w });
    fireState(own(w.path));
  }

  var api = {
    version: VERSION,
    ready: ready,
    state: {
      get: function (path) { return copy(path === undefined ? state : at(state, toPath(path))); },
      set: function (a, b) {
        if (arguments.length >= 2) {
          var path = toPath(a);
          if (!path.length) throw new TypeError('whiteboard.state.set(path, value) needs a path');
          write({ op: 'set', path: path, value: copy(b) });
          return;
        }
        if (!isObj(a)) throw new TypeError('whiteboard.state.set(value) replaces the whole state with an object; use set(path, value) for one key');
        write({ op: 'set', path: [], value: copy(a) });
      },
      merge: function (a, b) {
        var two = arguments.length >= 2;
        var value = two ? b : a;
        if (!isObj(value)) throw new TypeError('whiteboard.state.merge takes an object');
        write({ op: 'merge', path: two ? toPath(a) : [], value: copy(value) });
      },
      del: function (path) {
        var p = toPath(path);
        if (!p.length) throw new TypeError('whiteboard.state.del needs a path');
        write({ op: 'del', path: p });
      }
    },
    on: function (ev, fn) {
      if (!listeners[ev]) throw new TypeError('whiteboard.on: "' + ev + '" is not an event (state, ready or mode)');
      if (typeof fn !== 'function') throw new TypeError('whiteboard.on needs a function');
      listeners[ev].push(fn);
      if (ev === 'ready' && started) fn(api);
      return function () { api.off(ev, fn); };
    },
    off: function (ev, fn) {
      var list = listeners[ev] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    action: function (name, data) {
      if (typeof name !== 'string' || !name) throw new TypeError('whiteboard.action needs a name');
      if (rendering) return;
      var value = data === undefined ? null : copy(data);
      walk(state, [ACTIONS])[name] = { name: name, data: value, at: Date.now() };
      var msg = { type: 'action', name: name };
      if (data !== undefined) msg.data = value;
      post(msg);
      fireState(own([ACTIONS, name]));
    }
  };
  Object.defineProperty(api, 'card', { enumerable: true, get: function () { return copy(card); } });
  Object.defineProperty(api, 'rendering', { enumerable: true, get: function () { return rendering; } });
  Object.defineProperty(api, 'mode', { enumerable: true, get: function () { return mode; } });
  Object.defineProperty(window, 'whiteboard', { value: api, enumerable: true });

  // ---- Form fields, saved into state.fields by name or id ----

  var SKIP = { password: 1, file: 1, hidden: 1, submit: 1, button: 1, reset: 1, image: 1 };
  var TYPED = { text: 1, search: 1, email: 1, url: 1, tel: 1, number: 1, textarea: 1, '': 1 };
  function keyOf(el) { return el.getAttribute('name') || el.id || ''; }
  function typeOf(el) { return el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : (el.getAttribute('type') || 'text').toLowerCase(); }
  function isField(el) {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT')) return false;
    return !SKIP[typeOf(el)] && !!keyOf(el) && !el.hasAttribute('data-wb-ignore');
  }
  function typed(el) { return !!TYPED[typeOf(el)]; }
  function named(key) {
    return Array.prototype.filter.call(document.querySelectorAll('input, textarea, select'), function (el) { return isField(el) && keyOf(el) === key; });
  }
  function readField(key) {
    var els = named(key);
    if (!els.length) return undefined;
    var t = typeOf(els[0]);
    if (t === 'radio') {
      for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
      return null;
    }
    if (t === 'checkbox') {
      if (els.length === 1) return els[0].checked;
      return els.filter(function (el) { return el.checked; }).map(function (el) { return el.value; });
    }
    if (t === 'select' && els[0].multiple) return Array.prototype.map.call(els[0].selectedOptions, function (o) { return o.value; });
    return els[0].value;
  }
  function showField(key, value) {
    named(key).forEach(function (el) {
      var t = typeOf(el);
      if (t === 'radio') el.checked = el.value === value;
      else if (t === 'checkbox') el.checked = Array.isArray(value) ? value.indexOf(el.value) >= 0 : !!value;
      else if (t === 'select' && el.multiple) Array.prototype.forEach.call(el.options, function (o) { o.selected = Array.isArray(value) && value.indexOf(o.value) >= 0; });
      else el.value = value === null || value === undefined ? '' : String(value);
    });
  }
  function fields() { return isObj(state[FIELDS]) ? state[FIELDS] : {}; }

  // The typing rule: the field the owner is in keeps their value. A remote write to it is held (with a
  // small marker) until they stop: on blur or after a second idle, their last value is written if they
  // typed; if they didn't, the held value is shown.
  var focus = null;
  function emit(key) {
    var value = readField(key);
    if (value === undefined) return;
    if (focus && focus.key === key) {
      focus.dirty = false;
      focus.held = undefined;
      unmark();
    }
    write({ op: 'set', path: [FIELDS, key], value: value });
    reportFocus();
  }
  function idle() {
    if (!focus) return;
    clearTimeout(focus.timer);
    focus.timer = setTimeout(function () {
      if (focus && focus.dirty && !focus.composing) emit(focus.key);
    }, IDLE_MS);
  }
  function mark(el, who) {
    unmark();
    var r = el.getBoundingClientRect();
    var m = document.createElement('span');
    m.setAttribute('data-wb-marker', '');
    m.textContent = 'changed by ' + who;
    m.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;font:11px/1.4 system-ui,sans-serif;padding:1px 6px;border-radius:3px;background:#ffd866;color:#222;box-shadow:0 1px 2px rgba(0,0,0,.25)';
    m.style.left = r.left + window.scrollX + 'px';
    m.style.top = r.bottom + window.scrollY + 2 + 'px';
    (document.body || document.documentElement).appendChild(m);
    if (focus) focus.marker = m;
  }
  function unmark() {
    if (focus && focus.marker) {
      focus.marker.remove();
      focus.marker = null;
    }
  }
  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!isField(el) || !typed(el)) return;
    focus = { key: keyOf(el), el: el, dirty: false, composing: false, held: undefined, timer: 0, marker: null };
  }, true);
  document.addEventListener('focusout', function (e) {
    if (!focus || e.target !== focus.el) return;
    var f = focus;
    clearTimeout(f.timer);
    if (f.dirty) emit(f.key);
    else if (f.held !== undefined) showField(f.key, f.held.value);
    unmark();
    focus = null;
  }, true);
  document.addEventListener('compositionstart', function (e) {
    if (focus && e.target === focus.el) {
      focus.composing = true;
      clearTimeout(focus.timer);
    }
  }, true);
  document.addEventListener('compositionend', function (e) {
    if (focus && e.target === focus.el) {
      focus.composing = false;
      focus.dirty = true;
      idle();
    }
  }, true);
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!isField(el)) return;
    if (focus && el === focus.el) {
      focus.dirty = true;
      if (!focus.composing) idle();
    } else emit(keyOf(el));
  }, true);
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!isField(el) || (focus && el === focus.el)) return;
    emit(keyOf(el));
  }, true);

  /** Remote field values go into the page, except the one the owner is typing in. */
  function showRemote(before, changes) {
    var now = fields();
    var old = isObj(before[FIELDS]) ? before[FIELDS] : {};
    var keys = Object.keys(now).concat(Object.keys(old).filter(function (k) { return !Object.prototype.hasOwnProperty.call(now, k); }));
    keys.forEach(function (key) {
      var value = Object.prototype.hasOwnProperty.call(now, key) ? now[key] : null;
      if (focus && focus.key === key) {
        if (JSON.stringify(value) === JSON.stringify(readField(key))) return;
        var by = null;
        (changes || []).forEach(function (c) { if (c && Array.isArray(c.path) && c.path[0] === FIELDS && c.path[1] === key) by = c.author; });
        focus.held = { value: value };
        mark(focus.el, by && by.kind === 'worker' ? by.name : by ? 'you' : 'someone else');
        return;
      }
      showField(key, value);
    });
  }

  // ---- Focus, reported so a content reload can put it back (and the host can tell when typing stops) ----

  function focusOf(el) {
    if (!el || el === document.body || el === document.documentElement || ours(el)) return null;
    var f;
    if (isField(el)) {
      var key = keyOf(el);
      f = { key: key, index: Math.max(0, named(key).indexOf(el)) };
      if (focus && focus.el === el) {
        if (focus.composing) f.composing = true;
        else if (focus.dirty && typed(el)) f.value = String(el.value);
      }
    } else if (el.isContentEditable || el.tabIndex >= 0) f = { selector: cssPath(el) };
    else return null;
    try {
      if (typeof el.selectionStart === 'number') {
        f.start = el.selectionStart;
        f.end = el.selectionEnd;
        if (el.selectionDirection) f.direction = el.selectionDirection;
      }
    } catch (err) {
      // a field type without a caret (email, number)
    }
    return f;
  }
  var focusTimer = 0;
  var lastFocus = 'null';
  function reportFocus() {
    if (focusTimer) return;
    focusTimer = setTimeout(function () {
      focusTimer = 0;
      if (rendering || !started) return;
      var f = focusOf(document.activeElement);
      var s = JSON.stringify(f);
      if (s === lastFocus) return;
      lastFocus = s;
      post({ type: 'focus', field: f });
    }, 0);
  }
  ['focusin', 'focusout', 'input', 'keyup', 'mouseup', 'select', 'selectionchange', 'compositionstart', 'compositionend'].forEach(function (ev) {
    document.addEventListener(ev, reportFocus, true);
  });
  function restoreFocus(f) {
    var el = null;
    if (typeof f.key === 'string') {
      var els = named(f.key);
      el = els[Math.min(f.index || 0, els.length - 1)] || null;
    } else if (typeof f.selector === 'string') {
      try { el = document.querySelector(f.selector); } catch (err) { el = null; }
    }
    if (!el || typeof el.focus !== 'function') return;
    // What the owner typed after the last save; the host has written it into state already.
    if (typeof f.value === 'string' && isField(el) && typed(el)) el.value = f.value;
    el.focus({ preventScroll: true });
    if (typeof f.start === 'number') {
      try { el.setSelectionRange(f.start, typeof f.end === 'number' ? f.end : f.start, f.direction || 'none'); } catch (err) {
        // a field type without a caret
      }
    }
  }

  // Something in the page (a video's own full-screen button, say) has the screen, or just gave it
  // back: its keys are its own, and the Esc that left full screen was the browser's, not the owner's.
  var fsLeftAt = 0;
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement) fsLeftAt = Date.now(); });
  function pageFullscreen() { return !!document.fullscreenElement || Date.now() - fsLeftAt < 500; }

  // Esc in the frame never reaches the office's own key handling (another origin), so it's passed on:
  // only once the artifact has had its turn, and never while an IME composition is open.
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229 || (focus && focus.composing)) return;
    var fs = pageFullscreen();
    setTimeout(function () {
      if (!e.defaultPrevented && !rendering && !fs && !pageFullscreen()) post({ type: 'escape' });
    }, 0);
  });

  // Navigation must cross the iframe boundary. Pinches always belong to the board; ordinary
  // scrolling stays inside a nested scroller while it has room, then continues across the page.
  function editable(el) { return el && el.closest && el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'); }
  // A focused video or audio element plays and pauses with Space, as it does in a tab.
  function presses(el) { return el && el.closest && el.closest('button, a, [role="button"], video, audio'); }
  var space = false;
  window.addEventListener('keydown', function (e) {
    if (!started || rendering || e.code !== 'Space' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || editable(e.target) || presses(e.target) || pageFullscreen()) return;
    e.preventDefault();
    if (!space) { space = true; post({ type: 'space', pressed: true }); }
  }, true);
  function releaseSpace() {
    if (!space) return;
    space = false;
    post({ type: 'space', pressed: false });
  }
  window.addEventListener('keyup', function (e) { if (e.code === 'Space') releaseSpace(); }, true);
  window.addEventListener('blur', releaseSpace);
  window.addEventListener('keydown', function (e) {
    if (!started || rendering || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || editable(e.target) || pageFullscreen()) return;
    var key = e.key.toLowerCase();
    if (key === '=') key = '+';
    if (key === '_') key = '-';
    if (['m', 'h', 'f', '+', '-', '0', '1'].indexOf(key) < 0 || (e.repeat && (key === 'm' || key === 'h' || key === 'f'))) return;
    e.preventDefault();
    post({ type: 'shortcut', key: key });
  });

  function nestedScroll(e) {
    var el = e.target;
    var dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    var dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      var css = getComputedStyle(el);
      var y = /auto|scroll/.test(css.overflowY) && el.scrollHeight > el.clientHeight;
      var x = /auto|scroll/.test(css.overflowX) && el.scrollWidth > el.clientWidth;
      if (y && ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0))) return true;
      if (x && ((dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) || (dx < 0 && el.scrollLeft > 0))) return true;
      el = el.parentElement;
    }
    return false;
  }
  window.addEventListener('wheel', function (e) {
    if (!started || rendering || e.defaultPrevented) return;
    var zoom = e.ctrlKey || e.metaKey;
    if (!zoom && nestedScroll(e)) return;
    e.preventDefault();
    post({ type: 'wheel', point: { x: e.clientX, y: e.clientY }, dx: e.deltaX, dy: e.deltaY, deltaMode: e.deltaMode, zoom: zoom, shift: e.shiftKey });
  }, { passive: false });

  var panPointer = null;
  function panEvent(e, phase) { post({ type: 'pan', phase: phase, point: { x: e.screenX, y: e.screenY } }); }
  window.addEventListener('pointerdown', function (e) {
    if (!started || rendering || e.button !== 1) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    panPointer = e.pointerId;
    e.target.setPointerCapture(e.pointerId);
    panEvent(e, 'start');
  }, true);
  window.addEventListener('pointermove', function (e) { if (e.pointerId === panPointer) { e.stopImmediatePropagation(); panEvent(e, 'move'); } }, true);
  function endPan(e) {
    if (e.pointerId !== panPointer) return;
    e.stopImmediatePropagation();
    panPointer = null;
    panEvent(e, 'end');
  }
  window.addEventListener('pointerup', endPan, true);
  window.addEventListener('pointercancel', endPan, true);
  window.addEventListener('auxclick', function (e) { if (started && !rendering && e.button === 1) e.preventDefault(); }, true);

  // ---- Buttons and forms ----

  function dataOf(el) {
    var raw = el.getAttribute('data-wb-data');
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch (err) { return raw; }
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-wb-action]') : null;
    if (!el) return;
    var form = el.form || (el.closest && el.closest('form'));
    if (form && !form.hasAttribute('action')) e.preventDefault();
    if (form) Array.prototype.forEach.call(form.elements, function (f) { if (isField(f)) emit(keyOf(f)); });
    api.action(el.getAttribute('data-wb-action'), dataOf(el));
  });
  // A form with nowhere to go would reload the page: its fields are saved and its submit is recorded instead.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.hasAttribute('action') || e.defaultPrevented) return;
    e.preventDefault();
    Array.prototype.forEach.call(form.elements, function (f) { if (isField(f)) emit(keyOf(f)); });
    if (!(e.submitter && e.submitter.hasAttribute('data-wb-action'))) api.action('submit', { form: form.getAttribute('name') || form.id || null });
  });

  // ---- Anchors ----

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function pageRect(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  }
  function pageSize() {
    var d = document.documentElement;
    var b = document.body;
    return { w: Math.max(d.scrollWidth, b ? b.scrollWidth : 0), h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0) };
  }
  function ours(el) { return el && el.hasAttribute && el.hasAttribute('data-wb-marker'); }
  function hit(p) {
    var vx = p.x - window.scrollX;
    var vy = p.y - window.scrollY;
    if (vx >= 0 && vy >= 0 && vx < window.innerWidth && vy < window.innerHeight) {
      var el = document.elementFromPoint(vx, vy);
      if (el && !ours(el)) return el;
    }
    var best = null;
    var area = Infinity;
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length && i < 20000; i++) {
      if (ours(all[i])) continue;
      var r = pageRect(all[i]);
      if (r.w * r.h < area && p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h) {
        best = all[i];
        area = r.w * r.h;
      }
    }
    return best;
  }
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id));
        return parts.join(' > ');
      }
      var n = 1;
      for (var s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) n++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
      el = el.parentElement;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }
  // An anchor names its element by data-wb-id, else by CSS path, and keeps a quote of its text (its first
  // 80 characters, or what an agent gave) to check and find it again: an agent rewrites whole pages, so
  // the path may now lead somewhere else, and the quote decides.
  var QUOTE = 80;
  /** Text-free inline elements (a <b> in a sentence) are a poor thing to pin to: the box they sit in is used. */
  function blockOf(el) {
    var INLINE = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, CITE: 1, CODE: 1, DFN: 1, EM: 1, I: 1, KBD: 1, MARK: 1, Q: 1, S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1, VAR: 1 };
    while (el && el.parentElement && el.parentElement !== document.body && INLINE[el.tagName] && getComputedStyle(el).display === 'inline') el = el.parentElement;
    return el;
  }
  function anchorAt(p) {
    var size = pageSize();
    if (p.x < 0 || p.y < 0 || p.x > size.w || p.y > size.h) return null;
    var el = hit(p);
    var point = { x: p.x, y: p.y };
    if (!el || el === document.body || el === document.documentElement) return { kind: 'point', point: point };
    var withId = el.closest('[data-wb-id]');
    var target = withId || blockOf(el);
    var r = pageRect(target);
    var a = { kind: 'element', offset: { x: p.x - r.x, y: p.y - r.y }, point: point };
    if (withId) a.wbId = withId.getAttribute('data-wb-id');
    else a.selector = cssPath(target);
    var q = textOf(target).slice(0, QUOTE);
    if (q) a.quote = q;
    return a;
  }
  function textOf(el) { return norm(el.textContent); }
  function tagOf(selector) {
    var m = /([a-z][a-z0-9-]*)(?::nth-of-type\(\d+\))?\s*$/i.exec(selector || '');
    return m ? m[1].toUpperCase() : '';
  }
  /**
   * A text's words for comparing, lowercased and without the punctuation round them. A leading "2." or
   * "3)" goes (sections get renumbered), and so does a quote's last word when it was cut off mid-word.
   */
  function words(s, cut) {
    var raw = s.toLowerCase().split(' ');
    if (raw.length > 1 && /^\(?\d{1,3}[.)]$/.test(raw[0])) raw.shift();
    if (cut && raw.length > 1) raw.pop();
    return raw.map(function (w) { return w.replace(/^[("'\u201c\u2018[]+|[)"'\u201d\u2019\].,;:!?]+$/g, ''); }).filter(Boolean);
  }
  function lcs(a, b) {
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev.push(0);
    for (var i = 0; i < a.length; i++) {
      var cur = [0];
      for (var k = 0; k < b.length; k++) cur.push(a[i] === b[k] ? prev[k] + 1 : Math.max(prev[k + 1], cur[k]));
      prev = cur;
    }
    return prev[b.length];
  }
  /** A word that tells siblings written from one template apart: a number, a price, a date, a one-letter label. */
  function telling(w) { return /\d/.test(w) || (w.length === 1 && w !== 'a' && w !== 'i'); }
  /**
   * Whether an element's text is the quoted one, edited: the quote's words survive at its start, in
   * order (all of them for a quote of under four words, else nearly all), and none of its telling words
   * is gone. A heading or a sentence an agent reworded passes; "Option B" for "Option A" doesn't.
   */
  function edited(q, text) {
    var qw = words(q, q.length >= QUOTE);
    if (!qw.length) return false;
    var tw = words(text.slice(0, q.length * 2 + 40), false);
    var have = {};
    tw.forEach(function (w) { have[w] = 1; });
    if (qw.some(function (w) { return telling(w) && !have[w]; })) return false;
    var kept = lcs(qw, tw.slice(0, qw.length + 6)) / qw.length;
    return qw.length < 4 ? kept === 1 : kept >= EDITED;
  }
  var EDITED = 0.85;
  /** A quote this short ("Approve", "Q3") is in too many places to be found by unless an element says just that. */
  var SHORT = 12;
  function holds(text, q, anywhere) {
    if (q.length < SHORT) return anywhere ? text === q : text.indexOf(q) === 0;
    return text.indexOf(q) >= 0;
  }
  function candidates() {
    var out = [];
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length && i < 20000; i++) {
      var el = all[i];
      if (ours(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') continue;
      out.push(el);
    }
    return out;
  }
  function distance(el, a) {
    var r = pageRect(el);
    var off = a.offset || { x: 0, y: 0 };
    return Math.abs(r.x + off.x - a.point.x) + Math.abs(r.y + off.y - a.point.y);
  }
  /** Of the elements that hold the quote: the anchor's tag if any has it, then the least other text (the element, not a wrapper round it), then the nearest to where the mark was. */
  function pick(pool, a, tag) {
    var same = pool.filter(function (el) { return el.tagName === tag; });
    var best = null;
    var bestLen = Infinity;
    var bestDist = Infinity;
    (same.length ? same : pool).forEach(function (el) {
      var len = textOf(el).length;
      var d = distance(el, a);
      if (len < bestLen || (len === bestLen && d < bestDist)) {
        best = el;
        bestLen = len;
        bestDist = d;
      }
    });
    return best;
  }
  /**
   * The element an anchor is on now, else null (detached). In order: its data-wb-id; the element at its
   * CSS path if that still holds its quote; any element that holds the quote (the path now leads to
   * another, or the page was wrapped or reordered); the element at its path if its text is the quote,
   * edited; the one element of its tag anywhere whose text is the quote, edited. Never a guess: a
   * mark on nothing is shown detached, a mark on the wrong element misleads.
   */
  function find(a) {
    if (a.wbId) {
      var w = document.querySelector('[data-wb-id="' + CSS.escape(a.wbId) + '"]');
      if (w) return w;
    }
    var q = a.quote ? norm(a.quote) : '';
    var tag = tagOf(a.selector);
    var s = null;
    if (a.selector) {
      try { s = document.querySelector(a.selector); } catch (err) { s = null; }
      if (s && (!q || holds(textOf(s), q, false))) return s;
    }
    if (!q) return null;
    var all = candidates();
    var holding = all.filter(function (el) { return holds(textOf(el), q, true); });
    if (holding.length) return pick(holding, a, tag);
    if (s && edited(q, textOf(s))) return s;
    if (!tag) return null;
    var alike = all.filter(function (el) { return el.tagName === tag && edited(q, textOf(el)); });
    return alike.length === 1 ? alike[0] : null;
  }
  function locate(item) {
    var a = item.anchor;
    if (a.kind === 'point') return { id: item.id, point: { x: a.point.x, y: a.point.y }, detached: false };
    var el = find(a);
    if (!el) return { id: item.id, point: null, detached: true };
    var r = pageRect(el);
    var off = a.offset || { x: 0, y: 0 };
    return { id: item.id, point: { x: r.x + off.x, y: r.y + off.y }, detached: false };
  }

  // ---- Layout ----

  var queued = false;
  var scrollSeq = 0;
  function layout() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var size = pageSize();
      post({ type: 'layout', width: size.w, height: size.h, scrollX: window.scrollX, scrollY: window.scrollY, seq: scrollSeq });
    });
  }
  window.addEventListener('scroll', layout, { passive: true });
  window.addEventListener('resize', layout);
  window.addEventListener('load', layout);
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(layout);
    ro.observe(document.documentElement);
    document.addEventListener('DOMContentLoaded', function () { if (document.body) ro.observe(document.body); });
  }

  // ---- The bridge ----

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function isPoint(v) { return isObj(v) && num(v.x) && num(v.y); }
  function isAnchor(v) { return isObj(v) && isPoint(v.point) && (v.kind === 'point' || (v.kind === 'element' && (typeof v.wbId === 'string' || typeof v.selector === 'string'))); }
  window.addEventListener('message', function (e) {
    if (!host || e.source !== host) return;
    var d = e.data;
    if (!isObj(d) || d.channel !== CHANNEL || !nonce || d.nonce !== nonce) return;
    if (d.type === 'init') {
      if (!isObj(d.card) || typeof d.card.id !== 'string' || !isObj(d.state)) return;
      card = { id: d.card.id, title: String(d.card.title || ''), author: isObj(d.card.author) ? d.card.author : null };
      rendering = d.rendering === true;
      mode = d.mode === 'markup' ? 'markup' : 'use';
      document.documentElement.setAttribute('data-wb-mode', mode);
      var before = state;
      state = copy(d.state);
      showRemote(before, []);
      var first = !started;
      started = true;
      fireState([]);
      if (first) {
        resolveReady(api);
        fire('ready', api);
      }
      layout();
      reportFocus();
    } else if (d.type === 'state') {
      if (!isObj(d.state)) return;
      var was = state;
      var changes = Array.isArray(d.changes) ? d.changes : [];
      state = copy(d.state);
      showRemote(was, changes);
      fireState(changes);
    } else if (d.type === 'anchorAt') {
      if (Number.isSafeInteger(d.req) && isPoint(d.point)) post({ type: 'anchor', req: d.req, anchor: anchorAt(d.point) });
    } else if (d.type === 'locate') {
      if (!Number.isSafeInteger(d.req) || !Array.isArray(d.anchors)) return;
      var items = d.anchors.filter(function (x) { return isObj(x) && typeof x.id === 'string' && isAnchor(x.anchor); });
      post({ type: 'positions', req: d.req, positions: items.map(locate) });
    } else if (d.type === 'mode') {
      if (d.mode !== 'use' && d.mode !== 'markup') return;
      mode = d.mode;
      document.documentElement.setAttribute('data-wb-mode', mode);
      fire('mode', mode);
    } else if (d.type === 'scrollTo') {
      if (num(d.x) && num(d.y)) {
        if (Number.isSafeInteger(d.seq) && d.seq >= 0) scrollSeq = d.seq;
        window.scrollTo({ left: d.x, top: d.y, behavior: 'instant' });
        layout();
      }
    } else if (d.type === 'focus') {
      if (isObj(d.field) && !rendering) restoreFocus(d.field);
    }
  });

  function hello() { post({ type: 'ready', version: VERSION }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello);
  else hello();
})();
`;
