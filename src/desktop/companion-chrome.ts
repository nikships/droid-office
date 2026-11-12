// Keep the native controls over the companion's own navigation, with a clear area to drag.
export const COMPANION_CHROME = `
  .dashboard .dash-top { -webkit-app-region: drag; }
  .dashboard .dash-top-upper { padding-left: 88px; }
  .dashboard .dash-top :is(button, input, select, a) { -webkit-app-region: no-drag; }
  .dashboard :is(.dash-top-lower, .dash-quiet-pop, .dash-layout-pop) { -webkit-app-region: no-drag; }
  /* A modal covers the title bar too: its controls must receive native clicks, not window drags. */
  .dashboard .backdrop { -webkit-app-region: no-drag; }
  .dashboard .dash-top .dash-office { max-width: 180px; }
`;
