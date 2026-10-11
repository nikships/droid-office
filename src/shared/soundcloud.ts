/** SoundCloud page links use its player, not a plain audio element. */
export function soundCloudUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return;
    if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(u.hostname)) return;
    u.protocol = 'https:';
    u.hostname = 'soundcloud.com';
    u.hash = '';
    return u.href;
  } catch {
    return;
  }
}

/** Generated stations aren't embeddable themselves; their public tracks are. */
export function soundCloudStationUrl(raw: string): string | undefined {
  const url = soundCloudUrl(raw);
  if (!url) return;
  const u = new URL(url);
  if (!/^\/discover\/sets\/(?:artist|track)-stations:\d+\/?$/.test(u.pathname)) return;
  u.pathname = u.pathname.replace(/\/$/, '');
  u.search = '';
  return u.href;
}

export const SOUNDCLOUD_STATION_MAX_TRACKS = 200;

export interface SoundCloudStation {
  title: string;
  tracks: string[];
}
