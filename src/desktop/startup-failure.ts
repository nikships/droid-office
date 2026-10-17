/** Why the Mac app refused to start. Each one ends in a dialog and a quit: there is no degraded mode. */
export type StartupFailureKind = 'platform' | 'macos' | 'chip' | 'native-module' | 'shared-texture' | 'renderer-crashed';

export interface StartupFailure {
  kind: StartupFailureKind;
  /** The dialog's message line. */
  title: string;
  /** What is wrong and what to do about it. */
  detail: string;
}

/** The text a failure is logged as, and what `--startup-check` prints. */
export function formatStartupFailure(failure: StartupFailure): string {
  return `${failure.title}\n\n${failure.detail}`;
}

function reason(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** The native presenter (`presenter.node`) is missing, unsigned, built for another architecture or fails to initialize. */
export function nativeModuleFailure(err: unknown): StartupFailure {
  return {
    kind: 'native-module',
    title: "Droid Office's display module didn't load",
    detail: `The native Metal presenter that draws the office could not be loaded, and the app has no other way to draw. Reinstall the latest Droid Office from github.com/nikships/droid-office/releases. If it keeps failing, report this message.\n\n${reason(err)}`,
  };
}

/** The offscreen page never produced a GPU shared texture the presenter can show. */
export function sharedTextureFailure(why: unknown): StartupFailure {
  return {
    kind: 'shared-texture',
    title: "Droid Office couldn't get frames from the GPU",
    detail: `Electron did not hand over a shared GPU texture of the office page, and the app has no other way to draw. Quit and open Droid Office again. If it keeps failing, report this message.\n\n${reason(why)}`,
  };
}

/** The office page's process crashed twice in a minute, so it is asked about rather than reloaded again. The one failure the owner can answer with Reload instead of Quit. */
export function rendererCrashFailure(reasons: unknown): StartupFailure {
  return {
    kind: 'renderer-crashed',
    title: 'The office window crashed',
    detail: `The page that draws the office stopped twice in a minute. Reload it to try again, or quit and open Droid Office again. If it keeps happening, report this message.\n\n${reason(reasons)}`,
  };
}
