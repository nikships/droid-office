// E opens the live terminal. It opens in one frame (a hard cut); ~2.4 s of the clip is usable.
(async () => {
  await __sleep(900);
  await window.office.interact('E');
  await __sleep(3800);
  return JSON.stringify(window.office.state().terminal);
})();
