// Voice chat and screen sharing are gone (single-owner track, commit A4): nothing captures
// the microphone or the screen, no signaling rides the WebSocket, and no voice or share UI
// remains on the desktop . Chat and teammate presence are gone too (commit A5):
// no chat history, remote avatars, relays, whereabouts, people views or floor headcounts.
// The jukebox and office sounds stay.
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

test('the voice module is gone', () => {
  assert.equal(existsSync(join(ROOT, 'client/voice.ts')), false);
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
  assert.match(file('client/main.ts'), /openJukebox\(net/);
  assert.match(file('client/ui/settings.ts'), /'volume', 'muted'/);
  assert.match(file('client/ui/settings.ts'), /'music', 'musicMuted'/);
});

test('no chat or teammate presence anywhere: protocol, server, stores or UI', () => {
  // No peer or chat shapes on the wire, and no presence or chat messages. queue.move is a
  // queued task moving up or down the queue, not a person, so it stays.
  assert.deepEqual(hits(/PeerInfo/), []);
  assert.deepEqual(hits(/ChatLine/), []);
  assert.deepEqual(hits(/\bt: '(move|doing|chat)'/), []);
  assert.deepEqual(hits(/peer\.(join|update|move|leave)/), []);
  assert.deepEqual(hits(/term\.typing/), []);
  // No chat persistence on the server, and no peer relays or headcounts.
  assert.deepEqual(hits(/ChatLog|CHAT_KEEP|chat\.jsonl/), []);
  assert.deepEqual(hits(/toNeighbors|lastMoveAt/), []);
  assert.deepEqual(hits(/\.people\b/), []);
  assert.equal(existsSync(join(ROOT, 'client/ui/whereabouts.ts')), false);
  assert.deepEqual(hits(/whereabouts/), []);
  // No people or chat UI on the desktop.
  assert.deepEqual(hits(/renderPeople|renderChat|sayBubble|syncPeers|walkToPeer|sendChat|seedPeer/), []);
  assert.doesNotMatch(file('client/main.ts'), /store\.peers|store\.chat|store\.you/);
  assert.doesNotMatch(file('client/state.ts'), /\| '(peers|carrying|chat)'/);
  assert.doesNotMatch(file('client/state.ts'), / (peers|chat|you) = /);
  assert.doesNotMatch(file('client/ui/hud.ts'), /people|chat/i);
  assert.doesNotMatch(file('client/ui/menu.ts'), /'people'|'chat'/);
  assert.doesNotMatch(file('client/index.html'), /people-panel|chat-log|chat-input/);
  assert.doesNotMatch(file('client/style.css'), /#chat-log|#chat-input|chat-out|\.people/);
  // The workers panel shows by default; removed panels can't come back from old settings.
  assert.match(file('client/state.ts'), /workers: true, spend: false, limits: false, floor: false/);
});
