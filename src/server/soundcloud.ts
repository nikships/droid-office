import { SOUNDCLOUD_STATION_MAX_TRACKS, soundCloudStationUrl, type SoundCloudStation } from '../shared/soundcloud.js';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const UNAVAILABLE = "SoundCloud couldn't load this station's public tracks. Try a public track or playlist link instead.";
type Result = SoundCloudStation | { status: number; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read JSON, never execute the station page's scripts or use its API credentials. */
export function parseSoundCloudStation(html: string, url: string): SoundCloudStation | undefined {
  const stationUrl = soundCloudStationUrl(url);
  if (!stationUrl) return;
  const match = /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\])\s*;\s*<\/script>/.exec(html);
  if (!match) return;
  try {
    const hydration: unknown = JSON.parse(match[1]);
    if (!Array.isArray(hydration)) return;
    const data: unknown = hydration.find((v) => record(v) && v.hydratable === 'systemPlaylist')?.data;
    if (!record(data) || typeof data.permalink_url !== 'string' || soundCloudStationUrl(data.permalink_url) !== stationUrl || !Array.isArray(data.tracks)) return;
    const tracks = data.tracks
      .filter((t: unknown) => record(t) && t.kind === 'track' && typeof t.id === 'number' && Number.isSafeInteger(t.id) && t.id > 0 && t.policy !== 'BLOCK')
      .slice(0, SOUNDCLOUD_STATION_MAX_TRACKS)
      .map((t: { id: number }) => `https://api.soundcloud.com/tracks/${t.id}`);
    if (!tracks.length) return;
    return { title: typeof data.title === 'string' ? data.title.slice(0, 200) : 'SoundCloud station', tracks: [...new Set(tracks)] };
  } catch {
    return;
  }
}

/** Only fetch canonical public station pages on SoundCloud, with no redirects. */
export async function resolveSoundCloudStation(raw: string, fetcher: typeof fetch = fetch): Promise<Result> {
  const url = soundCloudStationUrl(raw);
  if (!url) return { status: 400, error: 'Paste a SoundCloud artist-station or track-station link' };
  try {
    const res = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; droid-office)' },
    });
    if (!res.ok || !res.body || Number(res.headers.get('content-length')) > MAX_PAGE_BYTES) {
      await res.body?.cancel();
      return { status: 502, error: UNAVAILABLE };
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel();
        return { status: 502, error: UNAVAILABLE };
      }
      chunks.push(Buffer.from(value));
    }
    return parseSoundCloudStation(Buffer.concat(chunks).toString('utf8'), url) ?? { status: 502, error: UNAVAILABLE };
  } catch {
    return { status: 502, error: UNAVAILABLE };
  }
}
