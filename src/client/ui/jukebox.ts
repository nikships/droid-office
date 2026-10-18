import { JUKEBOX_TUNES, STREAM, checkStreamUrl, trackTitle, tuneById } from '../../shared/jukebox';
import { soundCloudUrl } from '../../shared/soundcloud';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast } from './dom';

/** The jukebox: what's on, the tunes to pick from, skip and stop, and a box for a stream. */
export function openJukebox(net: Net, openVolume: () => void) {
  const close = h('button.btn.icon.close', { 'aria-label': 'Close' }, '✕');
  const now = h('div.jb-now');
  const list = h('ul.list.boxed.jb-tunes');
  const url = h('input.input', {
    id: 'jb-stream',
    type: 'text',
    placeholder: 'https://… SoundCloud, internet radio, or an .mp3',
    'aria-label': 'Stream or audio file link',
    spellcheck: 'false',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const playUrl = h('button.btn', { type: 'button' }, 'Play');
  const volume = h('button.btn', { type: 'button' }, 'Your volume');
  const el = h(
    'div.modal.jukebox',
    { role: 'dialog', 'aria-label': 'Jukebox' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Jukebox'), h('p.sub', {}, 'Pick a tune, or paste a stream.')), close),
    h(
      'div.body.stack.loose',
      {},
      now,
      h('section.section', {}, h('div.eyebrow', {}, 'Put on a tune'), list),
      h(
        'section.section',
        {},
        h(
          'div.field',
          {},
          h('label', { for: 'jb-stream' }, 'Or play a stream'),
          h('div.input-group', {}, url, playUrl),
          h('p.field-hint', {}, 'SoundCloud tracks, playlists and artist stations, direct radio streams, or audio files. Close this window to use the SoundCloud player’s Play and Next track controls.'),
        ),
      ),
    ),
    h('footer', {}, h('span.grow', {}, 'Louder the closer you are to the lounge.'), volume),
  );

  const button = (label: string, title: string, send: () => void, primary = false) => h(primary ? 'button.btn.sm.primary' : 'button.btn.sm', { type: 'button', title, onclick: send }, label);

  const render = () => {
    const j = store.jukebox;
    const stream = j.track === STREAM;
    const soundcloud = stream && !!soundCloudUrl(j.url ?? '');
    now.replaceChildren(
      h('span.jb-disc', { class: j.on ? 'spin' : '' }, stream ? '📻' : '💿'),
      h(
        'div.jb-now-main',
        {},
        h('div.eyebrow', {}, j.on ? 'Now playing' : 'Off'),
        h('div.jb-now-title', { title: j.on ? trackTitle(j) : '' }, j.on ? trackTitle(j) : 'The jukebox is off'),
        h('div.jb-now-meta', {}, j.on ? [soundcloud ? 'SoundCloud' : stream ? 'a stream' : tuneById(j.track)?.mood, j.by && `put on by ${j.by}`].filter(Boolean).join(' · ') : j.by ? `${j.by} turned it off` : 'Pick a tune to put it on'),
      ),
      h(
        'div.row',
        {},
        j.on ? button(soundcloud ? 'Tunes' : 'Skip', 'On to the next built-in tune', () => net.send({ t: 'jukebox.skip' })) : button('Play', `Put ${trackTitle(j)} back on`, () => net.send({ t: 'jukebox.play' }), true),
        h(
          'button.btn.sm',
          {
            type: 'button',
            class: j.shuffle ? 'primary' : '',
            'aria-pressed': String(!!j.shuffle),
            title: j.shuffle ? 'Skip picks a random tune. Click to play them in order.' : 'Skip to a random tune instead of the next one',
            onclick: () => net.send({ t: 'jukebox.shuffle', on: !j.shuffle }),
          },
          'Shuffle',
        ),
        j.on ? button('Stop', 'Turn the jukebox off', () => net.send({ t: 'jukebox.stop' })) : '',
      ),
    );
    list.replaceChildren(
      ...JUKEBOX_TUNES.map((t) => {
        const playing = j.on && j.track === t.id;
        const li = h(
          'li.list-row',
          { class: playing ? 'on' : '', tabindex: 0, role: 'button', 'aria-pressed': String(playing), title: playing ? 'Playing now' : `Put on ${t.title}` },
          h('span.list-icon', {}, playing ? '🔊' : '🎵'),
          h('div.list-main', {}, h('div.list-title', {}, t.title), h('div.list-meta', {}, t.mood)),
          playing ? h('span.list-end.jb-playing', {}, 'Playing') : null,
        );
        const pick = () => {
          if (!playing) net.send({ t: 'jukebox.play', track: t.id });
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
        return li;
      }),
    );
  };

  const play = () => {
    const u = checkStreamUrl(url.value);
    if ('error' in u) {
      toast(u.error, 'warn');
      return url.focus();
    }
    net.send({ t: 'jukebox.play', url: u.url });
    url.value = '';
  };
  playUrl.addEventListener('click', play);
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') play();
  });

  const modal = openModal(el, { doing: '🎵 at the jukebox', onClose: store.on('jukebox', render) });
  close.addEventListener('click', () => modal.close());
  volume.addEventListener('click', () => {
    modal.close();
    openVolume();
  });
  render();
}
