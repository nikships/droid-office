(async () => {
  const log = [];
  const F = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    log.push(['focus()', `${this.tagName}#${this.id}.${this.className}`, (new Error().stack || '').split('\n').slice(2, 5).join(' | ')]);
    return F.apply(this, a);
  };
  const on = (e) => log.push([e.type, `${e.target?.tagName}#${e.target?.id ?? ''}.${e.target?.className ?? ''}`, '']);
  document.addEventListener('focusin', on, true);
  document.addEventListener('focusout', on, true);
  window.addEventListener('blur', on, true);
  window.addEventListener('focus', on, true);
  const V = XRSession.prototype.updateRenderState;
  XRSession.prototype.updateRenderState = function (st) {
    log.push(['updateRenderState', Object.keys(st).join(','), (new Error().stack || '').split('\n').slice(2, 4).join(' | ')]);
    return V.call(this, st);
  };
  await window.__office.vr.enter();
  await new Promise((d) => setTimeout(d, 3000));
  HTMLElement.prototype.focus = F;
  XRSession.prototype.updateRenderState = V;
  document.removeEventListener('focusin', on, true);
  document.removeEventListener('focusout', on, true);
  window.removeEventListener('blur', on, true);
  window.removeEventListener('focus', on, true);
  const c = window.__office.renderer.domElement;
  return {
    log,
    canvas: { tabIndex: c.tabIndex, attrs: [...c.attributes].map((a) => `${a.name}=${a.value}`) },
    active: document.activeElement?.tagName,
    vis: window.__office.renderer.xr.getSession()?.visibilityState,
    inputs: [...document.querySelectorAll('input,textarea,[contenteditable]')].filter((e) => e.offsetParent).map((e) => `${e.tagName}#${e.id}.${e.className}`),
  };
})();
