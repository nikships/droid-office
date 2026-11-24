// The building: every project is a floor you ride the elevator to. Shared by the server (which
// assigns each floor its look) and the client (which paints it).

/** The most floors a building has. */
export const MAX_FLOORS = 16;

/** How a floor looks: its walls, their trim, and its poured floor. */
export interface FloorPalette {
  name: string;
  wall: string;
  trim: string;
  /** The polished slab. */
  floor: string;
  /** Every other pour of the slab, a shade off the first. */
  floorAlt: string;
  /** The hairline grid scored into the slab, a meter apart. */
  seam: string;
}

/**
 * How a floor looks, in the factory palette: graphite walls over a near-black polished slab with a
 * hairline grid, and a trim (the baseboard, and the floor's swatch in the elevator) that keeps every
 * floor distinguishable from the next. Trims stay dark enough for white type on them. The first is
 * the office's own look; every new floor takes the next one nobody has.
 *
 * Wall and floor are surface colors under the office's dim night fill, which renders a mid grey near
 * black (#6a6a6a comes out about #0d0d0d), so they read lighter here than they look in the room.
 */
export const FLOOR_PALETTES: FloorPalette[] = [
  { name: 'Graphite', wall: '#878787', trim: '#ee6018', floor: '#6a6a6a', floorAlt: '#727272', seam: '#a2a2a2' },
  { name: 'Steel', wall: '#84898e', trim: '#5c636b', floor: '#686c72', floorAlt: '#707478', seam: '#a0a6ac' },
  { name: 'Concrete', wall: '#8c8a87', trim: '#75716a', floor: '#72706c', floorAlt: '#787774', seam: '#a9a8a2' },
  { name: 'Carbon', wall: '#7b7b7b', trim: '#3a3a3a', floor: '#5c5c5c', floorAlt: '#626262', seam: '#8e8e8e' },
  { name: 'Oxide', wall: '#8a817d', trim: '#a2481a', floor: '#70665e', floorAlt: '#776e64', seam: '#a99a8e' },
  { name: 'Gunmetal', wall: '#83868e', trim: '#484c55', floor: '#666a72', floorAlt: '#6e7278', seam: '#9ea4ae' },
  { name: 'Ash', wall: '#969696', trim: '#7a7a7a', floor: '#787878', floorAlt: '#7e7e7e', seam: '#b2b2b2' },
  { name: 'Ember', wall: '#8a807b', trim: '#d15010', floor: '#6e6461', floorAlt: '#756c68', seam: '#a89890' },
  { name: 'Iron', wall: '#818181', trim: '#565656', floor: '#646464', floorAlt: '#6c6c6c', seam: '#9a9a9a' },
  { name: 'Signal', wall: '#878481', trim: '#b8541c', floor: '#6c6866', floorAlt: '#74706e', seam: '#a6a09c' },
];

export function floorPalette(i: number): FloorPalette {
  return FLOOR_PALETTES[((i % FLOOR_PALETTES.length) + FLOOR_PALETTES.length) % FLOOR_PALETTES.length];
}

/** Where a floor's repository is hosted, which decides whether `gh` or `glab` talks to it. */
export type Forge = 'github' | 'gitlab';

/** The GitLab instance a bare group/subgroup/project path means. */
const DEFAULT_GITLAB_HOST = 'gitlab.com';

const GH_OWNER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GH_NAME = /^[a-zA-Z0-9_.-]{1,100}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GL_SEGMENT = /^[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]{0,253}[a-zA-Z0-9_-])?$/;
/** GitLab nests groups up to 20 deep, plus the project. */
const GL_MAX_SEGMENTS = 21;

/**
 * A repository from what someone typed or pasted, or from a checkout's remote URL. GitHub
 * repositories come back as `owner/repo` (owner/repo, or a github.com URL: https, ssh or git@).
 * An https URL may carry credentials (`https://user:token@github.com/owner/repo`); those are
 * dropped before the address is read, so a long token cannot hide the repository or land in a
 * floor id. GitLab projects come back as `host/group/…/project` (a URL on any other host,
 * host/group/project, or a bare path of three or more segments, which means gitlab.com).
 * Undefined for anything else, so it can never become a CLI option or a path outside the
 * projects folder.
 */
export function normalizeRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.trim().replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
  if (s.length > 400) return undefined;
  let host: string | undefined;
  const url = /^(?:(?:https?|ssh|git):\/\/)?(?:[\w.~%-]+@)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?[/:](.*)$/.exec(s);
  if (url) {
    host = url[1].toLowerCase();
    s = url[2];
  } else if (/^[a-z]+:\/\//i.test(s) || s.includes('@')) {
    return undefined;
  }
  s = s.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  if (host && host !== 'github.com') return gitlabRepo(host, s);
  if (!host && s.split('/').length >= 3) return gitlabRepo(DEFAULT_GITLAB_HOST, s);
  const parts = s.replace(/\.git$/i, '').split('/');
  // A URL may go on past the repository (…/owner/repo/issues/12).
  if (parts.length < 2) return undefined;
  const [owner, repo] = parts;
  if (!GH_OWNER.test(owner)) return undefined;
  if (!GH_NAME.test(repo) || repo === '.' || repo === '..') return undefined;
  return `${owner}/${repo}`;
}

function gitlabRepo(host: string, rest: string): string | undefined {
  if (!HOST.test(host)) return undefined;
  // Pages of a project (…/project/-/merge_requests/12) sit after its /-/.
  const parts = rest
    .replace(/\/-(?:\/.*)?$/, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (parts.length < 2 || parts.length > GL_MAX_SEGMENTS) return undefined;
  if (!parts.every((p) => GL_SEGMENT.test(p) && !/\.(?:git|atom)$/i.test(p))) return undefined;
  return `${host}/${parts.join('/')}`;
}

/** A GitHub or GitLab repository URL pasted to clone into the workspace folder and open as a floor. */
export interface CloneUrl {
  forge: Forge;
  /** Canonical hostname (`github.com`, `gitlab.com`, or self-hosted GitLab host). */
  host: string;
  /** Normalized repository id (`owner/repo` on GitHub, `host/group/…/project` on GitLab). */
  repo: string;
  /** Folder name to clone into (`repo` on GitHub, `project` on GitLab). */
  name: string;
  /** Path on its host (`owner/repo` on GitHub, `group/…/project` on GitLab). */
  path: string;
  /** Canonical clone URL (`https://…`, `http://…`, `git@host:…`, or `ssh://git@host:port/…`). */
  cloneUrl: string;
  /** True when the pasted URL uses SSH (`git@host:…` or `ssh://…`). */
  ssh: boolean;
}

/** Whether a hostname is a GitLab instance by domain name (`gitlab.com` or `*.gitlab.*` / `gitlab.*`). */
export function isGitlabDomain(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'gitlab.com' || /(^|\.)gitlab\./.test(h);
}

/**
 * Parses an explicit GitHub or GitLab repository URL (`https://github.com/owner/repo`,
 * `https://gitlab.com/group/subgroup/project`, self-hosted GitLab URLs, SSH `git@…` / `ssh://…`,
 * or repo subpage URLs such as `/tree/main` or `/-/merge_requests/12`).
 * Bare `owner/repo` strings return undefined so local project search and relative-path errors stay unambiguous.
 */
export function parseCloneUrl(value: unknown, extraGitlabHost?: (host: string) => boolean): CloneUrl | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 400 || /\s/.test(trimmed)) return undefined;
  const match = /^(?:(https?|ssh|git):\/\/)?(?:([\w.~%-]+(?::[^/@\s]*)?)@)?([a-z0-9.-]+\.[a-z]{2,})(?::(\d+))?([/:])(.+)$/i.exec(trimmed);
  if (!match) return undefined;
  const scheme = match[1]?.toLowerCase();
  const userInfo = match[2];
  const rawHost = match[3].toLowerCase();
  const port = match[4];
  const sep = match[5];
  // Reject scp-style colons on HTTP(S) URLs or scheme-less host strings without user@.
  if (sep === ':' && (scheme === 'http' || scheme === 'https' || (!scheme && !userInfo))) return undefined;
  // Ports require an explicit scheme (e.g. ssh:// or https://).
  if (port && !scheme) return undefined;
  const rest = match[6].replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const ssh = scheme === 'ssh' || (!scheme && Boolean(userInfo) && sep === ':');

  const host = rawHost === 'www.github.com' ? 'github.com' : rawHost === 'www.gitlab.com' ? 'gitlab.com' : rawHost;
  if (host === 'github.com') {
    const parts = rest.split('/');
    if (parts.length < 2) return undefined;
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, '');
    if (!GH_OWNER.test(owner)) return undefined;
    if (!GH_NAME.test(name) || name === '.' || name === '..') return undefined;
    const repo = `${owner}/${name}`;
    return {
      forge: 'github',
      host,
      repo,
      name,
      path: repo,
      cloneUrl: ssh ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`,
      ssh,
    };
  }

  const hasGitlabMarker = rest.includes('/-/');
  if (!isGitlabDomain(host) && !hasGitlabMarker && !extraGitlabHost?.(host)) return undefined;
  const gl = gitlabRepo(host, rest);
  if (!gl) return undefined;
  const pathOnHost = gl.slice(host.length + 1);
  const name = pathOnHost.split('/').pop()!;
  const httpScheme = scheme === 'http' && host !== 'gitlab.com' ? 'http' : 'https';
  const cloneUrl = ssh ? (port ? `ssh://git@${host}:${port}/${pathOnHost}.git` : `git@${host}:${pathOnHost}.git`) : `${httpScheme}://${host}${port ? `:${port}` : ''}/${pathOnHost}.git`;
  return {
    forge: 'gitlab',
    host,
    repo: gl,
    name,
    path: pathOnHost,
    cloneUrl,
    ssh,
  };
}

/** GitLab repositories carry their host; GitHub's are plain owner/repo. */
export function forgeOf(repo: string | undefined): Forge | undefined {
  if (!repo) return undefined;
  return repo.split('/')[0].includes('.') ? 'gitlab' : 'github';
}

/** A GitLab repository's instance and its group/…/project path. */
export function gitlabParts(repo: string): { host: string; path: string } {
  const i = repo.indexOf('/');
  return { host: repo.slice(0, i), path: repo.slice(i + 1) };
}

/** The repository's path on its host: owner/repo on GitHub, group/…/project on GitLab. */
export function repoPath(repo: string): string {
  return forgeOf(repo) === 'gitlab' ? gitlabParts(repo).path : repo;
}

/** The repository's home page. */
export function repoWebUrl(repo: string): string {
  return forgeOf(repo) === 'gitlab' ? `https://${repo}` : `https://github.com/${repo}`;
}

/** How a forge names things, for text shown to people and prompts given to workers. */
export interface ForgeWords {
  site: 'GitHub' | 'GitLab';
  cli: 'gh' | 'glab';
  /** "PR" or "MR". */
  pr: string;
  /** "pull request" or "merge request". */
  pull: string;
  /** How a pull request is referenced in text: #12 on GitHub, !12 on GitLab. */
  ref(n: number): string;
}

const WORDS: Record<Forge, ForgeWords> = {
  github: { site: 'GitHub', cli: 'gh', pr: 'PR', pull: 'pull request', ref: (n) => `#${n}` },
  gitlab: { site: 'GitLab', cli: 'glab', pr: 'MR', pull: 'merge request', ref: (n) => `!${n}` },
};

/** GitHub's words unless the forge is GitLab. */
export function forgeWords(forge: Forge | undefined): ForgeWords {
  return WORDS[forge ?? 'github'];
}

/**
 * The other floors a worker hired on `current` can work in too, each in a worktree of its own
 * (see WorkerInfo.repos): any floor but its own that is a git checkout on a branch.
 */
export function repoChoices(floors: readonly { id: string; name: string; branch?: string; plain?: boolean }[], current: string | null | undefined): { id: string; name: string }[] {
  return floors.filter((f) => f.id !== current && f.branch && !f.plain).map((f) => ({ id: f.id, name: f.name }));
}

/**
 * Where someone coming back in lands. `floorIds` is the building's floors in arrival order.
 * A floor that's gone (not the roof, and no longer in the building) sends them to the roof
 * instead of the first floor. `back` means the place they asked for is still there, so the
 * spot they were standing in can be used; otherwise they arrive by elevator.
 */
export function returnLanding(wanted: string | null, floorIds: readonly string[], roofId: string): { onRoof: boolean; floorId: string | undefined; back: boolean; gone: boolean } {
  const known = wanted !== null && floorIds.includes(wanted);
  const gone = wanted !== null && wanted !== roofId && !known;
  const onRoof = (wanted === roofId || gone) && floorIds.length > 0;
  const floorId = onRoof ? undefined : known ? wanted : floorIds[0];
  const back = !gone && wanted !== null && (onRoof || floorId === wanted);
  return { onRoof, floorId, back, gone };
}
