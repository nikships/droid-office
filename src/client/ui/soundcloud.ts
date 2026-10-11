import { SOUNDCLOUD_STATION_MAX_TRACKS, soundCloudStationUrl, type SoundCloudStation } from '../../shared/soundcloud';
import { withToken } from '../token';
import { h } from './dom';

interface Widget {
  bind(event: string, listener: () => void): void;
  unbind(event: string): void;
  play(): void;
  pause(): void;
  next(): void;
  setVolume(volume: number): void;
  load(url: string, options: { auto_play: boolean; hide_related: boolean; show_comments: boolean; visual: boolean; callback?: () => void }): void;
}

interface WidgetApi {
  (iframe: HTMLIFrameElement): Widget;
  Events: { READY: string; PLAY: string; PAUSE: string; FINISH: string; ERROR: string };
}

let loadingApi: Promise<WidgetApi> | undefined;

function loadWidgetApi(): Promise<WidgetApi> {
  const api = () => (window as Window & { SC?: { Widget: WidgetApi } }).SC?.Widget;
  const existing = api();
  if (existing) return Promise.resolve(existing);
  if (loadingApi) return loadingApi;
  loadingApi = new Promise<WidgetApi>((resolve, reject) => {
    const script = h('script', { src: 'https://w.soundcloud.com/player/api.js', async: true });
    const finish = (error?: string) => {
      clearTimeout(timer);
      script.remove();
      const widget = api();
      if (!error && widget) resolve(widget);
      else reject(new Error(error ?? 'Could not load the SoundCloud player'));
    };
    const timer = setTimeout(() => finish('SoundCloud took too long to load'), 15_000);
    script.onload = () => finish();
    script.onerror = () => finish('Could not load the SoundCloud player');
    document.head.append(script);
  }).catch((error: unknown) => {
    loadingApi = undefined;
    throw error;
  });
  return loadingApi;
}

/** A visible official player, kept alive after the jukebox window closes. */
export class SoundCloudPlayer {
  private frame = h('iframe', { title: 'SoundCloud player', allow: 'autoplay', scrolling: 'no' });
  private title = h('span.jb-sc-title', {}, 'SoundCloud');
  private status = h('p.field-hint', { role: 'status' }, 'Loading SoundCloud…');
  private nextButton = h('button.btn.sm', { type: 'button', disabled: true, onclick: () => this.next() }, 'Next track');
  private el = h('details.jb-soundcloud.panel', { open: true, 'aria-label': 'SoundCloud jukebox player' }, h('summary', {}, this.title), this.status, this.nextButton);
  private abort = new AbortController();
  private widget: Widget | undefined;
  private events: string[] = [];
  private tracks: string[] = [];
  private index = 0;
  private failures = 0;
  private volume = 0;
  private disposed = false;
  private ready = false;
  private onReady: (() => void) | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  playing = false;

  constructor(
    url: string,
    private onError: (text: string) => void,
  ) {
    (document.getElementById('app') ?? document.body).append(this.el);
    void this.start(url).catch((error: unknown) => {
      if (!this.disposed) this.fail(error instanceof Error ? error.message : 'Could not load SoundCloud');
    });
  }

  setVolume(volume: number) {
    const v = Math.round(Math.max(0, Math.min(1, volume)) * 1000) / 10;
    if (v === this.volume) return;
    this.volume = v;
    this.widget?.setVolume(v);
  }

  next() {
    if (!this.widget || this.disposed) return;
    if (!this.tracks.length) return this.widget.next();
    this.index = (this.index + 1) % this.tracks.length;
    this.playing = false;
    this.status.textContent = `Loading track ${this.index + 1} of ${this.tracks.length}…`;
    this.waitForReady();
    this.widget.load(this.tracks[this.index], { auto_play: false, hide_related: true, show_comments: false, visual: false, callback: this.onReady });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.abort.abort();
    clearTimeout(this.readyTimer);
    this.widget?.pause();
    for (const event of this.events) this.widget?.unbind(event);
    this.frame.removeAttribute('src');
    this.el.remove();
  }

  private async start(url: string) {
    const [api, station] = await Promise.all([loadWidgetApi(), this.station(url)]);
    if (this.disposed) return;
    if (station) {
      this.tracks = station.tracks;
      this.title.textContent = `SoundCloud · ${station.title}`;
      this.title.title = station.title;
    }
    const params = new URLSearchParams({ url: this.tracks[0] ?? url, auto_play: 'false', hide_related: 'true', show_comments: 'false', visual: 'false' });
    this.frame.src = `https://w.soundcloud.com/player/?${params}`;
    this.el.append(this.frame);
    const widget = (this.widget = api(this.frame));
    const bind = (event: string, fn: () => void) => {
      this.events.push(event);
      widget.bind(event, () => {
        if (!this.disposed) fn();
      });
    };
    this.onReady = () => {
      if (this.disposed || this.ready) return;
      this.ready = true;
      clearTimeout(this.readyTimer);
      this.nextButton.disabled = false;
      widget.setVolume(this.volume);
      this.status.textContent = 'If playback stays paused, press Play in the SoundCloud player.';
      widget.play();
    };
    this.waitForReady();
    bind(api.Events.READY, this.onReady);
    bind(api.Events.PLAY, () => {
      this.playing = true;
      this.failures = 0;
      this.status.textContent = this.tracks.length ? `Track ${this.index + 1} of ${this.tracks.length}` : 'Playing on SoundCloud';
    });
    bind(api.Events.PAUSE, () => {
      this.playing = false;
    });
    bind(api.Events.FINISH, () => {
      if (this.tracks.length) this.next();
    });
    bind(api.Events.ERROR, () => {
      this.playing = false;
      if (this.tracks.length && ++this.failures < this.tracks.length) this.next();
      else this.fail("SoundCloud can't play this link here. It may be private, unavailable, or restricted. Try another public track or playlist.");
    });
  }

  private async station(url: string): Promise<SoundCloudStation | undefined> {
    const station = soundCloudStationUrl(url);
    if (!station) return;
    const res = await fetch(withToken(`/api/jukebox/soundcloud?url=${encodeURIComponent(station)}`), { signal: this.abort.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Could not load the SoundCloud station');
    if (
      !data ||
      typeof data.title !== 'string' ||
      !Array.isArray(data.tracks) ||
      !data.tracks.length ||
      data.tracks.length > SOUNDCLOUD_STATION_MAX_TRACKS ||
      !data.tracks.every((t: unknown) => typeof t === 'string' && /^https:\/\/api\.soundcloud\.com\/tracks\/[1-9]\d{0,15}$/.test(t))
    ) {
      throw new Error('SoundCloud returned no playable station tracks');
    }
    return { title: data.title.slice(0, 200), tracks: data.tracks };
  }

  private waitForReady() {
    this.ready = false;
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (!this.disposed) this.fail('SoundCloud took too long to load. Check your connection or try another link.');
    }, 20_000);
  }

  private fail(text: string) {
    clearTimeout(this.readyTimer);
    this.playing = false;
    this.status.textContent = text;
    this.onError(text);
  }
}
