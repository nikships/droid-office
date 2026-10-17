import type { StartupFailure } from './startup-failure.js';

/** The oldest macOS the app runs on (CAMetalDisplayLink needs 14). Keep `mac.minimumSystemVersion` in electron-builder.yml in step. */
export const MIN_MACOS = 14;
/** The Darwin kernel major version that ships as `MIN_MACOS`: what `os.release()` reports, and what electron-updater compares `minimumSystemVersion` against. */
export const MIN_DARWIN = 23;

export type ChipTier = 'base' | 'pro' | 'max' | 'ultra';
export type Chip = { family: 'apple'; generation: number; tier: ChipTier } | { family: 'intel' } | { family: 'unknown' };

/** Reads `sysctl -n machdep.cpu.brand_string`: "Apple M4 Pro", "Apple M2" or "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz". */
export function parseChip(brand: string): Chip {
  const text = brand.trim();
  const apple = /^Apple M(\d+)(?: (Pro|Max|Ultra))?$/.exec(text);
  if (apple) return { family: 'apple', generation: Number(apple[1]), tier: (apple[2]?.toLowerCase() as ChipTier | undefined) ?? 'base' };
  if (/\bintel\b/i.test(text)) return { family: 'intel' };
  return { family: 'unknown' };
}

/** The Darwin kernel's major version from `os.release()` ("25.0.0" is 25), or undefined when it can't be read. */
export function darwinMajor(release: string): number | undefined {
  const major = Number.parseInt(release, 10);
  return Number.isFinite(major) ? major : undefined;
}

export interface Machine {
  platform: NodeJS.Platform;
  arch: string;
  /** `os.release()`. */
  release: string;
  /** `sysctl -n machdep.cpu.brand_string`, or undefined when sysctl failed. */
  brand: string | undefined;
  /** `DROID_OFFICE_ALLOW_ANY_CHIP`: skips only the Pro-or-better chip check, for CI runners that are base-chip virtual machines. */
  allowAnyChip?: boolean;
}

/**
 * What the Mac app needs: macOS 14 or later on Apple silicon with a Pro, Max or Ultra chip. LSMinimumSystemVersion
 * only stops Finder launches, so this runs again at startup. Returns the reason to refuse, or undefined to go on.
 * The chip comes last so an old Mac is told about macOS first.
 */
export function checkRequirements(machine: Machine): StartupFailure | undefined {
  if (machine.platform !== 'darwin') {
    return { kind: 'platform', title: 'Droid Office is a Mac app', detail: `This build runs on macOS only (it is running on ${machine.platform}).` };
  }
  const darwin = darwinMajor(machine.release);
  if (darwin === undefined || darwin < MIN_DARWIN) {
    return {
      kind: 'macos',
      title: `Droid Office needs macOS ${MIN_MACOS} or later`,
      detail: `Update macOS in System Settings → General → Software Update, then open Droid Office again. (Darwin ${machine.release}; macOS ${MIN_MACOS} is Darwin ${MIN_DARWIN}.)`,
    };
  }
  if (machine.arch !== 'arm64') {
    return { kind: 'chip', title: 'Droid Office needs an Apple silicon Mac', detail: `Intel Macs are not supported. This Mac runs the app as ${machine.arch}. Droid Office needs an Apple M-series Pro, Max or Ultra chip.` };
  }
  if (machine.allowAnyChip) return undefined;
  const chip = machine.brand === undefined ? ({ family: 'unknown' } as const) : parseChip(machine.brand);
  if (chip.family === 'apple' && chip.tier !== 'base') return undefined;
  const have = machine.brand?.trim() || 'unknown';
  if (chip.family === 'apple') {
    return {
      kind: 'chip',
      title: 'Droid Office needs an Apple M-series Pro chip or better',
      detail: `This Mac has an ${have}. Droid Office draws a 3D office at up to 120 frames a second and is built for the Pro, Max and Ultra chips (M1 Pro and later). Base M chips are not supported.`,
    };
  }
  if (chip.family === 'intel') {
    return { kind: 'chip', title: 'Droid Office needs an Apple silicon Mac', detail: `This Mac has an Intel processor (${have}). Intel Macs are not supported. Droid Office needs an Apple M-series Pro, Max or Ultra chip.` };
  }
  return {
    kind: 'chip',
    title: "Droid Office couldn't confirm this Mac's chip",
    detail: `Droid Office needs an Apple M-series Pro, Max or Ultra chip, and this Mac reports its processor as "${have}", which is not one of them.`,
  };
}
