// Idle preload is opportunistic: a failed fetch must not interrupt startup or prevent Retry.
const warm = () =>
  void Promise.all([import('./wterm-core'), import('./wterm-runtime')])
    .then(([{ warmWterm }]) => warmWterm())
    .catch(() => {});
if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 3000 });
else setTimeout(warm, 1000);
