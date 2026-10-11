// In front of the Issues board, backed off so the cards fill the frame.
(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo('issues');
  await __hold(['KeyS'], 1100);
  await __pan(0, 60, 10);
  return JSON.stringify(o.state().player);
})();
