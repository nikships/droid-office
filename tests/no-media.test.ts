// Voice chat and screen sharing are gone (single-owner track, commit A4): nothing captures
// the microphone or the screen, no signaling rides the WebSocket, and no voice or share UI
// remains on the desktop or in VR. The jukebox, office sounds, chat and people stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src/', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mjs|js|html|css)$/.test(path) ? [path] : [];
  });
}

const files = sources(ROOT).map((path) => ({ path: relative(ROOT, path), src: readFileSync(path, 'utf8') }));
const file = (path: string) => files.find((f) => f.path === path)?.src ?? assert.fail(`missing ${path}`);
const hits = (re: RegExp) => files.filter(({ src }) => re.test(src)).map((f) => f.path);

test('nothing captures the microphone, the screen, or opens a peer connection', () => {
  assert.deepEqual(hits(/getUserMedia|getDisplayMedia|RTCPeerConnection|RTCRtpSender|RTCSessionDescription|RTCIceCandidate/), []);
});

test('no voice or rtc wire messages, ICE servers, or TURN flags', () => {
  assert.deepEqual(hits(/\bt: '(voice|rtc)'/), []);
  assert.deepEqual(hits(/iceServers|RTCIceServer|parseTurn|\.ice\b/), []);
  assert.deepEqual(hits(/--turn|stun:/), []);
});

test('the voice module and its emulator scripts are gone', () => {
  assert.equal(existsSync(join(ROOT, 'client/voice.ts')), false);
  assert.equal(existsSync(join(ROOT, 'client/iwsdk-scripts/vr-voice.mjs')), false);
  assert.equal(existsSync(join(ROOT, 'client/iwsdk-scripts/vr-leave.mjs')), false);
  assert.deepEqual(hits(/from '(\.\/|\.\.\/)voice'/), []);
});

test('the desktop has no voice or share actions, hotkeys, or mounts', () => {
  const main = file('client/main.ts');
  for (const gone of [
    'Join voice',
    'Leave voice',
    'Share screen',
    'Stop sharing',
    "'Mute'",
    "'Unmute'",
    'toggleVoice',
    'toggleShare',
    'watchShare',
    'currentShares',
    'refreshShares',
    'tvShowing',
    'tvStream',
    'tvVideo',
    'tvTexture',
    'remoteScreens',
    'localScreen',
    'startShare',
    'stopShare',
    'joinVoice',
    'inVoice',
    'isMuted',
    'toggleMute',
    'leaveVoice',
    'handleSignal',
    'updateSpeaking',
    '__voice',
    'new Voice',
    'noMedia',
    'KeyV',
    'KeyM',
    'V / M',
    'SHARE SCREEN',
    'Watch full screen',
    "id: 'voice'",
    "id: 'mute'",
    "id: 'share'",
    'Sound & voice',
  ])
    assert.doesNotMatch(main, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), gone);
  assert.doesNotMatch(file('client/ui/hud.ts'), /V \/ M|updateSpeaking|from '\.\.\/voice'/);
  assert.doesNotMatch(file('client/index.html'), /shares/);
  assert.doesNotMatch(file('client/style.css'), /#shares|\.share-thumb|\.speaking|\.modal\.viewer/);
  assert.doesNotMatch(file('client/ui/settings.ts'), /Voice chat/);
  assert.doesNotMatch(file('client/sound.ts'), /Voice chat/);
});

test('the desktop keeps its audio: jukebox, office sounds, and their mute switches', () => {
  assert.match(file('client/ui/settings.ts'), /card\('Office sounds'/);
  assert.match(file('client/ui/settings.ts'), /card\('Jukebox'/);
  assert.match(file('client/sound.ts'), /setMusicVolume/);
  assert.match(file('client/main.ts'), /jukebox: \(op, track\)/);
  assert.match(file('client/main.ts'), /toggleSound/);
});

test('the VR menu has no voice rows or actions', () => {
  const menu = file('client/vr/menu.ts');
  for (const gone of ['toggleMute', 'leaveVoice', 'inVoice', 'isMuted', 'lastMuted', 'Join voice', 'Leave voice', "'Mute'", "'Unmute'", "id: 'mute'", "id: 'leave'", 'leave voice', '(M)', '(V)']) {
    assert.doesNotMatch(menu, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), gone);
  }
  assert.doesNotMatch(file('client/vr/attach.ts'), /VrUiVoice|voice/);
  assert.doesNotMatch(file('client/vr/preview.ts'), /voice|leave voice|mute →/);
});

test('VR keeps chat, people, and sound actions', () => {
  const menu = file('client/vr/menu.ts');
  assert.match(menu, /sendChat/);
  assert.match(menu, /walkToPeer/);
  assert.match(menu, /toggleSound/);
  assert.match(menu, /id: 'chat'/);
  assert.match(menu, /id: 'people'/);
});

test('teammate presence fields stay for the A5 commit', () => {
  // PeerInfo.voice/muted/sharing and their plumbing go with chat and presence, not here.
  assert.match(file('shared/protocol.ts'), /voice: boolean/);
  assert.match(file('shared/protocol.ts'), /ChatLine/);
  assert.match(file('client/ui/hud.ts'), /renderPeople/);
  assert.match(file('client/main.ts'), /\{ t: 'chat', text \}/);
});
