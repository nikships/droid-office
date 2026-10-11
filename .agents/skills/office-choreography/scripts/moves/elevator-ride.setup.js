(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo('elevator');
  await __sleep(600);
  return JSON.stringify(o.state().player);
})();
