// Keep the native controls over the companion's own navigation, with a clear area to drag.
export const COMPANION_CHROME = `
  .dashboard .dash-top {
    height: auto;
    min-height: 68px;
    padding-left: 96px;
    -webkit-app-region: drag;
    background: linear-gradient(115deg, rgba(238,96,24,.14), rgba(18,18,20,.88) 42%, rgba(18,18,20,.72));
    backdrop-filter: blur(24px) saturate(140%);
    border-bottom-color: rgba(238,96,24,.2);
  }
  .dashboard .dash-top :is(button, select, a) { -webkit-app-region: no-drag; }
  .dashboard .dash-floor-strip { -webkit-app-region: no-drag; }
  /* A modal covers the title bar too: its controls must receive native clicks, not window drags. */
  .dashboard .backdrop { -webkit-app-region: no-drag; }
  .dashboard .dash-top .dash-office { max-width: 180px; }
`;
