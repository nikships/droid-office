import { homedir } from 'node:os';
import { gh } from './github.js';

/** Where CI publishes the Mac app and the Android APK. */
export const ANDROID_RELEASE_REPO = 'nikships/droid-office';

/** Runs `gh` with these arguments and answers its stdout. */
export type GhRunner = (args: string[]) => Promise<string>;

/** The owner's authenticated `gh`: its 5,000-an-hour REST quota, never the 60 an IP gets unauthenticated. */
export const ghRunner: GhRunner = (args) => gh(args, homedir(), 20_000);

/** The fields of GitHub's release object that release checks read. */
export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; size: number; digest: string | null; state: string }[];
}

const RELEASE_JQ = '{tag_name, draft, prerelease, assets: [.assets[] | {name, browser_download_url, size, digest, state}]}';

/** `GET /repos/<repo>/releases/latest` through `gh api`, trimmed to {@link GitHubRelease}. */
export async function latestGitHubRelease(repo: string, run: GhRunner = ghRunner): Promise<GitHubRelease> {
  const out = await run(['api', `repos/${repo}/releases/latest`, '--jq', RELEASE_JQ]);
  let release: unknown;
  try {
    release = JSON.parse(out);
  } catch {
    release = undefined;
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error(`gh answered something other than ${repo}'s latest release`);
  return release as GitHubRelease;
}

/**
 * One latest-release read shared by every caller within `ttlMs`, and by callers that ask while it
 * is still under way. A failure is not kept: the next ask runs `gh` again.
 */
export function cachedLatestRelease(repo: string, run: GhRunner = ghRunner, now: () => number = Date.now, ttlMs = 60_000) {
  let kept: { at: number; release: GitHubRelease } | undefined;
  let inflight: Promise<GitHubRelease> | undefined;
  return (): Promise<GitHubRelease> => {
    if (kept && now() - kept.at < ttlMs) return Promise.resolve(kept.release);
    inflight ??= latestGitHubRelease(repo, run)
      .then((release) => {
        kept = { at: now(), release };
        return release;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
