// The script the office injects at the top of every Whiteboard artifact's page (see injectSdk in
// whiteboard.ts): the artifact JavaScript API (`window.whiteboard`), plain form fields saved into
// `state.fields` and restored, `data-wb-action` buttons, and the frame's side of the postMessage
// bridge in shared/whiteboard-bridge.ts (nonce from `#wb=`, messages only from `window.parent`).
// It runs inside the sandboxed frame and depends on nothing outside it, so it is plain browser
// JavaScript in a string. Keep it ES2017, with no template literals (this is a String.raw).

/** Changes whenever the script does, so cached card pages are fetched again. */
export const SDK_VERSION = '1';

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
  function write(w) {
    if (rendering) return;
    applyLocal(w);
    post({ type: 'write', write: w });
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
  function anchorAt(p) {
    var size = pageSize();
    if (p.x < 0 || p.y < 0 || p.x > size.w || p.y > size.h) return null;
    var el = hit(p);
    var point = { x: p.x, y: p.y };
    if (!el || el === document.body || el === document.documentElement) return { kind: 'point', point: point };
    var withId = el.closest('[data-wb-id]');
    var target = withId || el;
    var r = pageRect(target);
    var a = { kind: 'element', offset: { x: p.x - r.x, y: p.y - r.y }, point: point };
    if (withId) a.wbId = withId.getAttribute('data-wb-id');
    else {
      a.selector = cssPath(target);
      var q = norm(target.textContent).slice(0, 80);
      if (q) a.quote = q;
    }
    return a;
  }
  function byQuote(quote) {
    var best = null;
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length && i < 20000; i++) {
      if (ours(all[i]) || all[i].tagName === 'SCRIPT' || all[i].tagName === 'STYLE') continue;
      if (norm(all[i].textContent).indexOf(quote) >= 0) best = all[i];
    }
    return best;
  }
  function find(a) {
    if (a.wbId) {
      var w = document.querySelector('[data-wb-id="' + CSS.escape(a.wbId) + '"]');
      if (w) return w;
    }
    var q = a.quote ? norm(a.quote) : '';
    if (a.selector) {
      try {
        var s = document.querySelector(a.selector);
        if (s && (!q || norm(s.textContent).indexOf(q.slice(0, 40)) >= 0)) return s;
      } catch (err) {
        // a selector this page can't parse
      }
    }
    return q ? byQuote(q) : null;
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
  function layout() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var size = pageSize();
      post({ type: 'layout', width: size.w, height: size.h, scrollX: window.scrollX, scrollY: window.scrollY });
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
      fire('state', api.state.get(), []);
      if (first) {
        resolveReady(api);
        fire('ready', api);
      }
      layout();
    } else if (d.type === 'state') {
      if (!isObj(d.state)) return;
      var was = state;
      var changes = Array.isArray(d.changes) ? d.changes : [];
      state = copy(d.state);
      showRemote(was, changes);
      fire('state', api.state.get(), changes);
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
      if (num(d.x) && num(d.y)) window.scrollTo(d.x, d.y);
    }
  });

  function hello() { post({ type: 'ready', version: VERSION }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello);
  else hello();
})();
`;
