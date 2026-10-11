// Record whatever is on screen for MOVE_ARG ms (default 3000).
(async () => {
  await __sleep(Number(window.__arg) || 3000);
  return 'ok';
})();
