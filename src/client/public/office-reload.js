// Kept outside the game bundle so a broken client can still recover after a source fix.
(() => {
  const revision = document.querySelector('meta[name="office-revision"]')?.content.trim();
  if (!revision) return; // Vite owns reloads on the development page.

  let state;
  let busy = false;
  let stopped = false;
  let reloading = false;
  let runtimeError = '';
  let failure = '';
  let timer;
  let banner;
  let message;
  let detail;
  let retry;
  let disable;

  const node = (tag, style) => {
    const element = document.createElement(tag);
    element.style.cssText = `all:initial;box-sizing:border-box;${style}`;
    return element;
  };
  const paint = () => {
    const visible = !stopped && state?.enabled && (state.phase === 'building' || state.phase === 'error' || state.restartRequired || runtimeError || failure);
    if (!visible) {
      banner?.remove();
      banner = undefined;
      return;
    }
    if (!banner) {
      banner = node(
        'aside',
        'position:fixed;z-index:2147483647;bottom:16px;right:16px;width:480px;max-width:calc(100vw - 32px);max-height:50vh;overflow:auto;padding:12px;border:1px solid #686868;border-radius:8px;background:#181818;color:#fff;font:13px/1.5 system-ui;box-shadow:0 4px 24px #0008;display:block;',
      );
      banner.id = 'office-source-reload';
      banner.setAttribute('aria-label', 'Source reload recovery');
      message = node('div', 'display:block;color:#fff;font:13px/1.5 system-ui;');
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      detail = node('pre', 'display:block;white-space:pre-wrap;overflow:auto;max-height:160px;color:#ffcfb5;font:12px/1.4 monospace;margin:8px 0;');
      const buttonStyle = 'display:inline-block;color:#fff;background:#333;border:1px solid #888;border-radius:4px;padding:5px 10px;margin:8px 8px 0 0;font:13px system-ui;cursor:pointer;';
      retry = node('button', buttonStyle);
      retry.type = 'button';
      retry.textContent = 'Retry build';
      retry.addEventListener('click', () => {
        if (!retry.disabled) void request({ rebuild: true });
      });
      disable = node('button', buttonStyle);
      disable.type = 'button';
      disable.textContent = 'Disable source reload';
      disable.addEventListener('click', () => {
        if (!disable.disabled) void request({ enabled: false });
      });
      banner.append(message, detail, retry, disable);
      document.body.append(banner);
    }
    const messages = [];
    if (state.phase === 'building') messages.push('Building the local office client… This page reloads when it succeeds.');
    if (state.phase === 'error') messages.push('Client build failed. Fix the local source, then retry. The last successful build stays published.');
    if (runtimeError) messages.push('The office client hit an error. Source reload is still running and will recover this page after a successful new build.');
    if (state.restartRequired) messages.push('Server source changed. Restart the local office to apply it; rebuilding the client does not restart the server.');
    if (!state.available) messages.push(state.reason || 'Source builds are unavailable.');
    if (failure) messages.push(failure);
    if (!state.admin) messages.push('An office admin can retry or disable source reload.');
    message.textContent = messages.join(' ');
    detail.textContent = [state.error, runtimeError].filter(Boolean).join('\n\n');
    detail.style.display = detail.textContent ? 'block' : 'none';
    retry.style.display = disable.style.display = state.admin ? 'inline-block' : 'none';
    retry.disabled = busy || !state.admin || !state.available || state.phase === 'building';
    disable.disabled = busy || !state.admin;
    retry.style.opacity = retry.disabled ? '0.5' : '1';
    disable.style.opacity = disable.disabled ? '0.5' : '1';
  };

  const request = async (body) => {
    if (busy || stopped || reloading) return;
    clearTimeout(timer);
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    paint();
    try {
      const response = await fetch('/api/hot-reload', {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) {
        stopped = true;
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
      state = result;
      failure = '';
      // A published revision is valid even if a subsequent build has failed.
      if (state.enabled && typeof state.revision === 'string' && state.revision && state.revision !== revision) {
        reloading = true;
        try {
          window.dispatchEvent(new CustomEvent('office:before-reload'));
        } finally {
          window.location.reload();
        }
      }
    } catch (err) {
      failure = err?.name === 'AbortError' ? 'The local office did not respond. Retrying…' : `Source reload: ${err?.message || 'connection failed'}. Retrying…`;
    } finally {
      clearTimeout(timeout);
      busy = false;
      paint();
      if (!stopped && !reloading) timer = setTimeout(() => void request(), 2000);
    }
  };
  window.addEventListener(
    'error',
    (event) => {
      runtimeError = event.message || 'The office client failed to load.';
      paint();
    },
    true,
  );
  window.addEventListener('unhandledrejection', (event) => {
    runtimeError = String(event.reason?.message || event.reason || 'The office client failed.');
    paint();
  });
  void request();
})();
