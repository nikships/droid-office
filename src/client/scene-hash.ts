/** Set by `define` in vite.config.ts (`tools/scene-hash.mjs`); absent where the client runs without Vite. */
declare const __SCENE_HASH__: string | undefined;

/**
 * A hash of what the baked bounce light is a picture of: the scene's code and models, its layout and three.js.
 * '' when the build has none, and then the saved bake is keyed by the office's version instead.
 */
export const SCENE_HASH: string = typeof __SCENE_HASH__ === 'string' ? __SCENE_HASH__ : '';
