import { createRequire } from 'node:module';
import path from 'node:path';

/** Where `npm run build:native` writes the presenter, and where electron-builder ships it (`files` in electron-builder.yml), relative to the app's root. */
export const PRESENTER_MODULE = path.join('native', 'presenter', 'build', 'Release', 'presenter.node');

/** The presenter's file for an app rooted at `appPath` (`app.getAppPath()`: the bundle's Resources/app, or the checkout). */
export function presenterModulePath(appPath: string): string {
  return path.join(appPath, PRESENTER_MODULE);
}

const require = createRequire(import.meta.url);

/** `require` of the presenter. Throws what dlopen says (missing file, bad signature, wrong architecture); wrap it in `loadNative` from `startup.ts` so a failure ends the app with the error. */
export function requirePresenter(appPath: string): Record<string, unknown> {
  return require(presenterModulePath(appPath)) as Record<string, unknown>;
}
