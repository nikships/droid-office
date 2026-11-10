import missionControl from './mission-control.mjs';

// Electron's CDP target cannot create companion tabs; exercise its scene and settings here.
export default async (helpers) => missionControl(helpers, { withCompanion: false });
