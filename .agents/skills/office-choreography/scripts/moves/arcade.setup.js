(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo('cabinet');
  await __sleep(400);
  await __look(null, -0.05, 400);
  await __hold(['KeyS'], 500);
  await __sleep(400);
  return JSON.stringify(o.state().player);
})();
