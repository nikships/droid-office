import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { soundCloudStationUrl, soundCloudUrl } from '../src/shared/soundcloud.js';
import { checkStreamUrl, trackTitle, STREAM } from '../src/shared/jukebox.js';
import { parseSoundCloudStation, resolveSoundCloudStation } from '../src/server/soundcloud.js';
import { Jukebox } from '../src/server/jukebox.js';

const STATION = 'https://soundcloud.com/discover/sets/artist-stations:227866761';
const page = (data: unknown) => `<script>window.__sc_hydration = ${JSON.stringify([{ hydratable: 'systemPlaylist', data }])};</script>`;
const station = {
  permalink_url: STATION,
  title: 'Logic Radio',
  tracks: [
    { kind: 'track', id: 297295502 },
    { kind: 'track', id: 297295551 },
  ],
};

test('SoundCloud links are recognized by exact host and normalized without losing private-track parameters', () => {
  assert.equal(soundCloudUrl('http://www.soundcloud.com/artist/song?secret_token=s-test#t=0:10'), 'https://soundcloud.com/artist/song?secret_token=s-test');
  assert.equal(soundCloudUrl('https://m.soundcloud.com/artist/sets/album'), 'https://soundcloud.com/artist/sets/album');
  for (const url of ['bad', 'https://soundcloud.com.evil.test/a/b', 'https://evil.test/soundcloud.com/a', 'file://soundcloud.com/song', 'https://user:pass@soundcloud.com/song', 'https://soundcloud.com:8080/song']) {
    assert.equal(soundCloudUrl(url), undefined, url);
  }
  assert.equal(soundCloudStationUrl(`${STATION}/?utm_source=clipboard`), STATION);
  assert.equal(soundCloudStationUrl('https://soundcloud.com/discover/sets/track-stations:123'), 'https://soundcloud.com/discover/sets/track-stations:123');
  assert.equal(soundCloudStationUrl('https://soundcloud.com/artist/song'), undefined);
  assert.equal(soundCloudStationUrl('https://soundcloud.com/discover/sets/artist-stations:nope'), undefined);
  assert.deepEqual(checkStreamUrl(` ${STATION} `), { url: STATION });
  assert.deepEqual(checkStreamUrl('http://www.soundcloud.com/artist/song'), { url: 'https://soundcloud.com/artist/song' });
  assert.equal(trackTitle({ track: STREAM, url: STATION }), 'SoundCloud · Artist station');
});

test('station hydration yields a bounded deduplicated queue, not scripts or credentials', () => {
  assert.deepEqual(parseSoundCloudStation(page(station), STATION), {
    title: 'Logic Radio',
    tracks: ['https://api.soundcloud.com/tracks/297295502', 'https://api.soundcloud.com/tracks/297295551'],
  });
  assert.deepEqual(parseSoundCloudStation(page({ ...station, permalink_url: `${STATION}/` }), STATION), parseSoundCloudStation(page(station), STATION));
  assert.equal(parseSoundCloudStation(page(station), 'https://evil.test'), undefined);
  const tracks = [{ kind: 'track', id: 1 }, { kind: 'track', id: 1 }, { kind: 'track', id: -1 }, { kind: 'track', id: '2' }, { kind: 'track', id: 2, policy: 'BLOCK' }, { kind: 'user', id: 3 }, null];
  assert.deepEqual(parseSoundCloudStation(page({ ...station, tracks, title: null }), STATION), { title: 'SoundCloud station', tracks: ['https://api.soundcloud.com/tracks/1'] });
  assert.equal(parseSoundCloudStation(page({ ...station, tracks: Array.from({ length: 250 }, (_, i) => ({ kind: 'track', id: i + 1 })), title: 'x'.repeat(300) }), STATION)?.tracks.length, 200);
  assert.equal(parseSoundCloudStation(page({ ...station, title: 'x'.repeat(300) }), STATION)?.title.length, 200);
  for (const html of [
    '',
    '<script>window.__sc_hydration = [broken];</script>',
    '<script>window.__sc_hydration = [];</script>',
    page({ ...station, permalink_url: 'https://evil.test' }),
    page({ ...station, tracks: [] }),
    page({ ...station, tracks: null }),
  ]) {
    assert.equal(parseSoundCloudStation(html, STATION), undefined);
  }
});

test('station resolver fetches only canonical SoundCloud pages, without following redirects', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, STATION);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return new Response(page(station));
  };
  for (const url of ['https://evil.test/', 'http://127.0.0.1/', 'https://soundcloud.com/artist/song', 'https://soundcloud.com:8080/discover/sets/artist-stations:1']) {
    assert.equal(((await resolveSoundCloudStation(url, fetcher)) as { status: number }).status, 400);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await resolveSoundCloudStation(`${STATION}?tracking=1`, fetcher), { title: 'Logic Radio', tracks: ['https://api.soundcloud.com/tracks/297295502', 'https://api.soundcloud.com/tracks/297295551'] });
  assert.equal(calls, 1);
});

test('station resolver reports network failures, missing tracks and oversized pages', async () => {
  const replies = [
    new Response('blocked', { status: 403 }),
    new Response(null),
    new Response('<html>login required</html>'),
    new Response('large', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ];
  for (const reply of replies) {
    const result = await resolveSoundCloudStation(STATION, async () => reply);
    assert.ok('error' in result);
    assert.equal(result.status, 502);
    assert.match(result.error, /public tracks/);
  }
  const result = await resolveSoundCloudStation(STATION, async () => {
    throw new Error('offline');
  });
  assert.ok('error' in result);
  assert.equal(result.status, 502);
});

test('SoundCloud station selections survive stop, resume and server restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-soundcloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = new Jukebox(dir);
  assert.deepEqual(box.play({ url: STATION }, 'Tester'), { changed: true });
  assert.equal(box.state().url, STATION);
  assert.equal(box.state().track, STREAM);
  assert.equal(box.stop('Tester'), true);
  const resumed = new Jukebox(dir);
  assert.equal(resumed.state().on, false);
  assert.deepEqual(resumed.play({}, 'Tester'), { changed: true });
  assert.equal(resumed.state().url, STATION);
  resumed.skip('Tester');
  assert.equal(resumed.state().track, 'rainy-window');
  assert.equal(resumed.state().url, undefined);
});
