import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SoundCloudPlayer } from '../src/client/ui/soundcloud.js';
import { OfficeSound, type JukeboxPlay } from '../src/client/sound.js';

class Element {
  children: unknown[] = [];
  attributes = new Map<string, string>();
  className = '';
  textContent = '';
  title = '';
  src = '';
  disabled = false;
  removed = false;
  onload?: () => void;
  onerror?: () => void;
  constructor(readonly tag: string) {}
  append(...children: unknown[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }
  addEventListener() {}
  remove() {
    this.removed = true;
  }
}

const EVENTS = { READY: 'ready', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish', ERROR: 'error' };
const STATION = 'https://soundcloud.com/discover/sets/artist-stations:227866761';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: TestContext, script: 'loaded' | 'load' | 'error' = 'loaded') {
  const listeners = new Map<string, () => void>();
  const calls: [string, unknown?][] = [];
  const elements: Element[] = [];
  let loaded: (() => void) | undefined;
  const widget = {
    bind: (event: string, listener: () => void) => listeners.set(event, listener),
    unbind: (event: string) => {
      listeners.delete(event);
      calls.push(['unbind', event]);
    },
    play: () => calls.push(['play']),
    pause: () => calls.push(['pause']),
    next: () => calls.push(['next']),
    setVolume: (v: number) => calls.push(['volume', v]),
    load: (url: string, options: { callback?: () => void }) => {
      loaded = options.callback;
      calls.push(['load', url]);
    },
  };
  const api = Object.assign(() => widget, { Events: EVENTS });
  const window: { SC?: { Widget: typeof api } } = script === 'loaded' ? { SC: { Widget: api } } : {};
  const body = new Element('body');
  const head = new Element('head');
  head.append = (...children: unknown[]) => {
    head.children.push(...children);
    queueMicrotask(() => {
      if (script === 'error') (children[0] as Element).onerror?.();
      else {
        window.SC = { Widget: api };
        (children[0] as Element).onload?.();
      }
    });
  };
  const globals = {
    window,
    Node: Element,
    document: {
      body,
      head,
      getElementById: () => undefined,
      createElement: (tag: string) => {
        const el = new Element(tag);
        elements.push(el);
        return el;
      },
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { calls, listeners, elements, loaded: () => loaded?.(), fire: (event: keyof typeof EVENTS) => listeners.get(EVENTS[event])?.() };
}

test('a blocked Widget API script reports an error', async (t) => {
  const env = setup(t, 'error');
  const errors: string[] = [];
  const player = new SoundCloudPlayer('https://soundcloud.com/artist/song', (e) => errors.push(e));
  t.after(() => player.dispose());
  await tick();
  assert.deepEqual(errors, ['Could not load the SoundCloud player']);
  assert.equal(env.listeners.size, 0);
});

test('official player loads lazily, starts at jukebox volume, and disposes all listeners', async (t) => {
  const env = setup(t, 'load');
  const errors: string[] = [];
  const player = new SoundCloudPlayer('https://soundcloud.com/artist/song', (e) => errors.push(e));
  t.after(() => player.dispose());
  player.setVolume(0.25);
  await tick();
  assert.match(env.elements.find((el) => el.tag === 'iframe')!.src, /w\.soundcloud\.com\/player\/.*auto_play=false/);
  env.fire('READY');
  assert.deepEqual(env.calls.slice(-2), [['volume', 25], ['play']]);
  env.fire('PLAY');
  assert.equal(player.playing, true);
  player.setVolume(0);
  assert.deepEqual(env.calls.at(-1), ['volume', 0]);
  const count = env.calls.length;
  player.setVolume(0);
  assert.equal(env.calls.length, count);
  player.next();
  assert.deepEqual(env.calls.at(-1), ['next']);
  env.fire('PAUSE');
  assert.equal(player.playing, false);
  env.fire('ERROR');
  assert.match(errors[0], /private, unavailable, or restricted/);
  player.dispose();
  assert.equal(env.listeners.size, 0);
  assert.equal(env.elements.find((el) => el.tag === 'details')!.removed, true);
  assert.equal(env.elements.find((el) => el.tag === 'iframe')!.src, '');
});

test('artist stations advance, wrap, skip unavailable tracks, and stop after all fail', async (t) => {
  const env = setup(t);
  const tracks = ['https://api.soundcloud.com/tracks/1', 'https://api.soundcloud.com/tracks/2'];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.match(url, /^\/api\/jukebox\/soundcloud\?url=/);
    return new Response(JSON.stringify({ title: 'Logic Radio', tracks }));
  });
  const errors: string[] = [];
  const player = new SoundCloudPlayer(STATION, (e) => errors.push(e));
  t.after(() => player.dispose());
  await tick();
  env.fire('READY');
  env.fire('PLAY');
  assert.equal(player.playing, true);
  env.fire('FINISH');
  assert.deepEqual(env.calls.at(-1), ['load', tracks[1]]);
  env.loaded();
  assert.deepEqual(env.calls.slice(-2), [['volume', 0], ['play']]);
  const readyCalls = env.calls.length;
  env.fire('READY');
  env.loaded();
  assert.equal(env.calls.length, readyCalls, 'a reload callback and READY must not start playback twice');
  env.fire('PLAY');
  player.next();
  assert.deepEqual(env.calls.at(-1), ['load', tracks[0]]);
  env.fire('ERROR');
  assert.deepEqual(env.calls.at(-1), ['load', tracks[1]]);
  assert.deepEqual(errors, []);
  env.fire('ERROR');
  assert.equal(errors.length, 1);
  assert.equal(player.playing, false);
});

test('station failures and invalid queues show a useful error without creating an embed', async (t) => {
  const env = setup(t);
  for (const data of [
    { status: 502, body: { error: 'Station is unavailable' } },
    { status: 200, body: { title: 'Empty', tracks: [] } },
    { status: 200, body: { title: 'Unsafe', tracks: ['https://evil.test/'] } },
    { status: 200, body: { title: 'Oversized', tracks: Array(201).fill('https://api.soundcloud.com/tracks/1') } },
    { status: 200, body: { title: 'Huge ID', tracks: [`https://api.soundcloud.com/tracks/${'1'.repeat(100)}`] } },
    { status: 200, body: null },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(data.body), { status: data.status }));
    const errors: string[] = [];
    const player = new SoundCloudPlayer(STATION, (e) => errors.push(e));
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(env.listeners.size, 0);
    player.dispose();
  }
});

test('stopping during station resolution cancels the request and prevents late playback', async (t) => {
  const env = setup(t);
  let signal: AbortSignal | undefined;
  let done: ((response: Response) => void) | undefined;
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      done = resolve;
    });
  });
  const errors: string[] = [];
  const player = new SoundCloudPlayer(STATION, (e) => errors.push(e));
  player.dispose();
  assert.equal(signal?.aborted, true);
  done?.(new Response(JSON.stringify({ title: 'Late', tracks: ['https://api.soundcloud.com/tracks/1'] })));
  await tick();
  assert.equal(env.listeners.size, 0);
  assert.deepEqual(errors, []);
});

test('identical SoundCloud reconnects preserve playback, while explicit replay and floor return restart it', (t) => {
  const sound = Object.create(OfficeSound.prototype) as OfficeSound;
  const apply = t.mock.method(sound as unknown as { applyJukebox(changed: boolean): void }, 'applyJukebox', () => {});
  const play: JukeboxPlay = { track: 'stream', url: STATION, startedAt: 1000, since: 100 };
  sound.setJukebox(play);
  assert.equal(apply.mock.callCount(), 1);
  sound.setJukebox({ ...play, since: 500 });
  assert.equal(apply.mock.callCount(), 1, 'clock correction/reconnect must not recreate the widget');
  sound.setJukebox({ ...play, startedAt: 2000 });
  assert.equal(apply.mock.callCount(), 2, 'a new play of the same URL must restart');
  sound.setJukebox(null);
  assert.equal(apply.mock.callCount(), 3, 'leaving the floor must dispose playback');
  sound.setJukebox(play);
  assert.equal(apply.mock.callCount(), 4, 'returning to the floor must recreate playback');
});
