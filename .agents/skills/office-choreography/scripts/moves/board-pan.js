// Slow pan across the board, right to left. ~3.9 s at FPS=60.
(async () => {
  await __look(window.__boardFacing - 0.2, null, 3600);
  await __sleep(150);
  return 'ok';
})();
