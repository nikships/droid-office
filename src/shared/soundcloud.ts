/** SoundCloud page links use its player, not a plain audio element. */
export function soundCloudUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return;
    if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(u.hostname)) return;
    // Built afresh rather than by assigning to the URL: React Native's URL is read-only.
    return `https://soundcloud.com${u.pathname}${u.search}`;
  } catch {
    return;
  }
}

/** Generated stations aren't embeddable themselves; their public tracks are. */
export function soundCloudStationUrl(raw: string): string | undefined {
  const url = soundCloudUrl(raw);
  if (!url) return;
  const { pathname } = new URL(url);
  if (!/^\/discover\/sets\/(?:artist|track)-stations:\d+\/?$/.test(pathname)) return;
  return `https://soundcloud.com${pathname.replace(/\/$/, '')}`;
}

export const SOUNDCLOUD_STATION_MAX_TRACKS = 200;

export interface SoundCloudStation {
  title: string;
  tracks: string[];
}
