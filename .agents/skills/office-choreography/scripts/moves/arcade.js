// Step up, E zooms into the cabinet, Enter starts BLOCKFALL, then a scripted run of moves and drops.
(async () => {
  const o = window.office;
  await __sleep(400);
  await __hold(['KeyW'], 450);
  await o.interact('E');
  await __sleep(1800);
  __tap('Enter', 'Enter');
  await __sleep(400);
  const seq = [
    'ArrowLeft',
    'ArrowUp',
    'ArrowLeft',
    'Space',
    'ArrowRight',
    'ArrowRight',
    'ArrowUp',
    'Space',
    'ArrowUp',
    'ArrowLeft',
    'ArrowLeft',
    'ArrowLeft',
    'Space',
    'ArrowRight',
    'Space',
    'ArrowUp',
    'ArrowRight',
    'ArrowRight',
    'ArrowRight',
    'Space',
  ];
  for (const k of seq) {
    __tap(k, k === 'Space' ? ' ' : k);
    await __sleep(k === 'Space' ? 550 : 220);
  }
  await __sleep(500);
  return 'ok';
})();
