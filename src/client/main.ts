import './style.css';
import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { randomLook } from '../shared/avatar';
import {
  BALCONY,
  BEANBAGS,
  COMPUTE_WALL,
  DESK_BY_ID,
  DESKS,
  ELEVATOR,
  ELEVATOR_CAR,
  FLOOR,
  GOLF_HOLE,
  LADDER,
  LOFT,
  POLE,
  POLES,
  SEATING_BY_ID,
  SLAB,
  STATIONS,
  STATION_AGENT,
  STOREY,
  WALL_HEIGHT,
  beanbagsOut,
  deskSeat,
  inElevator,
  nextFreeSeat,
  roofDrop,
  seatPlace,
  streetBelow,
  vacantSeats,
  type DeskDef,
  type SeatDef,
  type SeatPlace,
  type StationKind,
} from '../shared/layout';
import { floorPalette, forgeOf, forgeWords, normalizeRepo, repoWebUrl } from '../shared/floors';
import type { AgentEffort, CarriedIssue, FloorInfo, GhIssue, GongWhy, WorkerInfo, WorkerTask } from '../shared/protocol';
import { MEETING_PATTERNS } from '../shared/meetings';
import { isPaletteKey } from '../shared/palette';
import { isAsleep, isBusy, workerPr } from '../shared/status';
import { PROVIDER_LABEL, guestKeyNote, outsideNote, processLabel, statusWord } from '../shared/guests';
import { Net } from './net';
import { removedFloorNotice, standSpot } from './arrival';
import { guardLeaving } from './leave';
import { store, lastFloor, lastSpot, loadProfile, loadSettings, rememberSpot, saveSettings, words, workerForPull, type Profile, type Spot, type Topic } from './state';
import { EYE_HEIGHT, PlayerController, groundAt, isTyping } from './player';
import { Climber, type Arrival, type Grip, type Way } from './climb';
import { Caffeine } from './caffeine';
import { buildOffice, type DeskView, type InteractKind, type Interactable } from './world/office';
import { loadPropManifest, preloadProps, propManifest } from './world/props';
import { buildRooftop, type Rooftop } from './world/rooftop';
import { DrunkVision } from './world/drunk';
import { Booze, type Stage as Feeling } from './booze';
import { djFrame, djTime } from './dnb';
import { openBar } from './ui/bar';
import { DRINK_BY_ID, ROOF, ROOF_NAME, type Drink } from '../shared/rooftop';
import { Person, type PrBadge, Worker, type Stage } from './world/character';
import { GolfBalls, PIN_DISTANCE, fly, pinText, type Flight, type Hit, type Shot } from './world/golf';
import { Golfer } from './golf';
import { Hands } from './world/hands';
import { Smoke } from './world/smoke';
import { HAZE_MAX, Sky, describeSky, type ScreenGlow } from './world/sky';
import { Laptop } from './world/laptop';
import { BoardTexture, QueueBoardTexture, ServicesBoardTexture } from './world/boards';
import type { BoardSpot } from './world/board-layout';
import { loadFonts, MONO } from './fonts';
import { Gallery } from './world/gallery';
import { Arrivals, Departures } from './world/leaving';
import { Casualties } from './world/casualties';
import { TeamLines, type TeamLink } from './world/team-lines';
import { teamSummary } from '../shared/team';
import { BloodSpray, gunHit, Puff } from './world/gun';
import { Confetti, type Area } from './world/confetti';
import { Hanger } from './hanging';
import { redrawText } from './world/toon';
import { OfficeSound } from './sound';
import { DesktopNotifier, askNotifyPermission, notifyPermission, waitingOnSomeone } from './notify';
import { NextUp, waitingInOrder, waitingLabel } from './nextup';
import { $, h, clip, closeAllModals, hintToast, modalOpen, onModalChange, openModalList, readingNow, toast, STATUS_LABEL } from './ui/dom';
import { createAutomation, facingToward, pitchToward, runCommand, type CameraPose } from './automation';
import { onBringIn, onOpenTeammate, openTerminal, openTerminalFor, routeTerminalMessage, type TerminalFind } from './ui/terminal';
import { openSearch } from './ui/search';
import { openChanges, openChangesFor, routeChangesMessage } from './ui/changes';
import { openRepoPulls, workerRepos } from './ui/repos';
import { openPrompt, confirmDialog, sendHomeDialog, lostWorktreeDialog, routeWorktreeMessage, worktreePref } from './ui/prompt';
import { issuePrompt, openBoard } from './ui/boards';
import { openTicket, routeJiraMessage } from './ui/jira';
import { bindFactory, watchFactory } from './factory';
import { openIssue, openPull, routePullMessage } from './ui/pull';
import { openAsk } from './ui/ask';
import { openServices, serviceUrl } from './ui/services';
import { paletteOpen, togglePalette, type PaletteEntry } from './ui/palette';
import { loadingScreen } from './ui/loading';
import { openQueue } from './ui/queue';
import { openUpgrade, restarting, showRestarting, showUpgraded } from './ui/upgrade';
import { openHelp, renderCaffeine, renderWorkers } from './ui/hud';
import { cloudLine, hireCloud, openCloudWindow, runsOnPicker, sendCloudHome } from './ui/factory-cloud';
import { cloudBadge } from '../shared/factory-cloud';
import { Compass, type Bearing } from './ui/compass';
import { openCharacter } from './ui/character';
import { openSettings, type SettingsPane } from './ui/settings';
import { openPhone } from './ui/phone';
import { elevatorPanelOpen, openElevator, routeElevatorMessage } from './ui/elevator';
import { toggleFloorMenu } from './ui/floormenu';
import { modelBadge, rememberedChoice } from './ui/models';
import { officeFull, pressureNote } from './world/machine';
import { CiBoardTexture } from './world/factory-ci';
import { openCiWindow } from './ui/factory-ci';
import { ComputeWallTextures, rackCubesOf, wallSummary } from './world/factory-computers';
import { setRackCubes } from './world/factory-props';
import { openComputers } from './ui/factory-computers';
import { actionLabel, actionOffered, mountHud, type HudAction } from './ui/menu';
import { openJukebox } from './ui/jukebox';
import { openBookshelf } from './ui/bookshelf';
import { Arcade } from './ui/arcade';
import { Cabinet } from './ui/cabinet';
import { trackTitle } from '../shared/jukebox';
import { GAME, scoreText } from '../shared/cabinet';
import { EMOTES, EMOTE_BY_ID, EmoteBucket, type EmoteId } from '../shared/emotes';
import { EmoteWheel } from './ui/emotes';
import { wayTo } from './walkto';
import { MeetingBoardTexture, MeetingSignTexture, meetingStage } from './world/meeting';
import { issueMeeting, openMeeting, type MeetingPreset } from './ui/meeting';

// Up from the first paint (index.html) until the office has drawn a frame. Nothing is preloaded.
const loading = loadingScreen(() => () => {});

// ---- Renderer & scene ---------------------------------------------------------------------------
const canvas = $('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const effect = new OutlineEffect(renderer, { defaultThickness: 0.0032, defaultColor: [0.2, 0.2, 0.2] });
const scene = new THREE.Scene();
// It is always night; the sky's color and the fog change with the weather (world/sky.ts).
scene.background = new THREE.Color('#0a0720');
scene.fog = new THREE.Fog('#0a0720', 40, 90);
/** How far the camera sees in the office: as far as the haze ever is, from the top floor. */
const FAR = HAZE_MAX + 20;
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, FAR);

const hemi = new THREE.HemisphereLight('#2b2a6b', '#1a0d2c', 0.3);
const ambient = new THREE.AmbientLight('#5a4a9c', 0.1);
scene.add(hemi, ambient);
// The moon; the sky sets its light (world/sky.ts).
const sun = new THREE.DirectionalLight('#8f9cff', 0.18);
sun.position.set(-8, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// Wide enough for the office, the garage under it and the balcony and lot out front, from wherever the sun is.
Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 30, bottom: -30, near: 1, far: 100 });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.03;
scene.add(sun);

const office = buildOffice();
scene.add(office.group);
const teamLines = new TeamLines();
office.group.add(teamLines.group);

// The MacBook GLBs load after the scene exists; each laptop swaps its procedural
// stand-in for them the first frame they are cached (see world/laptop.ts).
void loadPropManifest()
  .then(() => preloadProps(Object.keys(propManifest())))
  .catch((err) => console.warn('office: prop GLBs unavailable, keeping procedural props', err));
const sky = new Sky(scene, { sun, hemi, ambient }, office.night);
/** The laptop screens that light the room, reused every frame (see Sky.setScreens). */
const screenGlows: ScreenGlow[] = [];
store.on('sky', () => store.sky && sky.set(store.sky));

const noOutline = (obj: THREE.Object3D) =>
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry;
    const flat = geo instanceof THREE.PlaneGeometry || geo instanceof THREE.CircleGeometry;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (flat || mat instanceof THREE.MeshBasicMaterial) mat.userData.outlineParameters = { visible: false };
  });
noOutline(office.group);

// ---- Board agents -------------------------------------------------------------------------------

const STATION_INFO: Record<StationKind, { icon: string; offer: string; does: string; example: string }> = {
  issues: { icon: '📌', offer: 'Ask me about issues', does: 'I file, find, triage, label and close them', example: 'File an issue: the bean bag walks straight through the jukebox' },
  pulls: { icon: '🔀', offer: 'Ask me about PRs', does: 'I sum up, review, comment on and merge them', example: 'Review the newest PR and tell me if it’s ready to merge' },
  queue: { icon: '📋', offer: 'Ask me to queue work', does: 'I turn it into tasks for fresh workers', example: 'Queue every open bug issue, most important first' },
  lead: { icon: '🧭', offer: 'Give me a big job', does: 'I split it up and hire a team of subagents at the desks', example: 'Add dark mode: one subagent on the settings, one on the styles, one on the tests' },
};
/** The board agents waiting by their boards before anyone has asked them anything (see buildKiosk). */
const idleAgents = STATIONS.map((def) => {
  const kind = def.station!;
  const agent = STATION_AGENT[kind];
  const model = new Worker(agent.name, agent.color);
  model.setStatus('idle', false);
  model.setTask({ name: STATION_INFO[kind].offer, summary: STATION_INFO[kind].does });
  const view = office.desks.get(def.id)!;
  view.vacancy.children[0].add(model.root);
  noOutline(model.root);
  return { model, view };
});

// Boards: each draws onto a canvas texture, redrawn whenever what it shows changes.
/** How much of its light a wall board gives off in the dark room: dim, but its text stays easy to read. */
const BOARD_GLOW = 0.62;
function mountBoard(mesh: THREE.Mesh, texture: THREE.Texture, render: () => void, topics: Topic[]) {
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.map = texture;
  mat.color.setScalar(BOARD_GLOW);
  mat.needsUpdate = true;
  for (const topic of topics) store.on(topic, render);
  render();
}
/** The issue card in your hands, taken off this floor's issues board (see Carrying an issue card), or null. */
let carrying: CarriedIssue | null = null;
const issuesTex = new BoardTexture('issues');
const renderIssuesBoard = () => {
  // The card in your hands is missing from the board until you put it back.
  const held = carrying?.issue;
  issuesTex.setJira(store.jiraBoard);
  issuesTex.render(held === undefined ? store.issues : { ...store.issues, items: store.issues.items.filter((i) => i.number !== held) });
};
mountBoard(office.boardMeshes.issues, issuesTex.texture, renderIssuesBoard, ['issues', 'jiraBoard']);
const pullsTex = new BoardTexture('pulls');
const renderPullsBoard = () => pullsTex.render(store.pulls, store.workers);
mountBoard(office.boardMeshes.pulls, pullsTex.texture, renderPullsBoard, ['pulls']);
// PR notes name the desk they came from. Redraw when that changes, not on every worker update.
let deskLinks = '';
store.on('workers', () => {
  const k = JSON.stringify([...store.workers.values()].filter((w) => w.worktree).map((w) => [w.worktree!.branch, w.pr?.number, w.name, w.color, w.deskId]));
  if (k === deskLinks) return;
  deskLinks = k;
  renderPullsBoard();
});
const servicesTex = new ServicesBoardTexture();
const renderServicesBoard = () => servicesTex.render(store.services.items, store.workers);
mountBoard(office.boardMeshes.services, servicesTex.texture, renderServicesBoard, ['services', 'workers']);
const queueTex = new QueueBoardTexture();
const renderQueueBoard = () => queueTex.render(store.queue, store.workers);
mountBoard(office.boardMeshes.queue, queueTex.texture, renderQueueBoard, ['queue', 'workers']);
// The compute wall on the west wall: this machine, and the Factory Droid Computers (world/factory-computers.ts).
const computeWall = new ComputeWallTextures();
const renderMachineBoard = () => {
  computeWall.render(store.machine, store.factory);
  setRackCubes(rackCubesOf(store.factory));
};
mountBoard(office.fleetScreen, computeWall.fleet, () => {}, []);
mountBoard(office.machineScreen, computeWall.machine, renderMachineBoard, ['machine', 'factory']);
/** The Computers window, on one computer when `id` is given. */
const showComputers = (id?: string) => openComputers({ settings: () => showSettings('factory'), id });
// Ages and asleep-ness move on by themselves; the wall paints only when what it says changed.
setInterval(renderMachineBoard, 30_000);
// Someone near the wall is watching it: Factory's computers are read more often meanwhile.
let stopWatchingWall: (() => void) | undefined;
setInterval(() => {
  const near = !upTop && !!store.floor && Math.hypot(player.pos.x - COMPUTE_WALL.x, player.pos.z - COMPUTE_WALL.z) < 12;
  if (near && !stopWatchingWall) stopWatchingWall = watchFactory('computers');
  else if (!near && stopWatchingWall) {
    stopWatchingWall();
    stopWatchingWall = undefined;
  }
}, 1000);
// The meeting room: its output as it's written on the back wall, and how it's going on the door.
const meetingBoardTex = new MeetingBoardTexture();
const renderMeetingBoard = () => meetingBoardTex.render(store.meeting);
mountBoard(office.meetingBoard, meetingBoardTex.texture, renderMeetingBoard, ['meeting']);
const meetingSignTex = new MeetingSignTexture();
const renderMeetingSign = () => meetingSignTex.render(store.meeting);
mountBoard(office.meetingSign, meetingSignTex.texture, renderMeetingSign, ['meeting']);
// Factory's CI automations on the north wall past the gong.
/** This floor's GitHub repository (owner/repo), if its checkout has one. */
const floorGithubRepo = () => {
  const repo = normalizeRepo(store.project?.remote);
  return repo && repo.split('/').length === 2 ? repo : undefined;
};
const ciTex = new CiBoardTexture();
const renderCiBoard = (force = false) => ciTex.render({ connection: store.factory.connection, ci: store.factory.ci, floorRepo: floorGithubRepo(), now: Date.now() }, force);
mountBoard(office.boardMeshes.ci, ciTex.texture, () => renderCiBoard(), ['factory', 'project']);
// Its "5M" ages: redrawn only when one of them ticks over.
setInterval(() => renderCiBoard(), 60_000);
const showCi = (add = false) => openCiWindow({ floorRepo: floorGithubRepo(), add });

// Pictures people hung on the walls
const gallery = new Gallery();
office.group.add(gallery.group);
store.on('decor', () => gallery.sync(store.decor));

// Confetti for merges, landing on whatever it falls on
const confetti = new Confetti((x, z, y) => groundAt(office.colliders, x, z, y, false));
scene.add(confetti.mesh);

// TV: geometry and its idle screen only (screen sharing is gone).
const tvIdle = (() => {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d')!;
  // A flat dark standby screen with a mono wordmark, the way the HUD's panels look.
  const draw = () => {
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = 'rgba(255, 255, 255, .045)';
    for (let y = 16; y < 720; y += 32) for (let x = 16; x < 1280; x += 32) g.fillRect(x, y, 2, 2);
    g.fillStyle = '#ee6018';
    g.fillRect(80, 316, 10, 80);
    g.fillStyle = '#eeeeee';
    g.textAlign = 'left';
    g.font = `700 72px ${MONO}`;
    g.fillText('OFFICE TV', 116, 376);
    t.needsUpdate = true;
  };
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  draw();
  return { tex: t, redraw: draw };
})();
const tvMat = office.tvScreen.material as THREE.MeshBasicMaterial;
tvMat.color.set('#ffffff');
tvMat.map = tvIdle.tex;
tvMat.toneMapped = false;
// The world's canvases drew at boot, before the bundled fonts were necessarily in: repaint them
// once Geist and Geist Mono are loaded, so nothing is left in a fallback typeface.
void loadFonts().then(() => {
  renderIssuesBoard();
  renderPullsBoard();
  renderServicesBoard();
  renderQueueBoard();
  computeWall.repaint();
  renderMachineBoard();
  renderMeetingBoard();
  renderMeetingSign();
  renderCiBoard(true);
  tvIdle.redraw();
  redrawText();
});
// The boss's monitor upstairs: Minesweeper, from the boss's chair.
const arcade = new Arcade(office.bossScreen);

// ---- The rooftop bar ------------------------------------------------------------------------------
/** Up on the roof: built the first time anyone goes up there. */
let roof: Rooftop | null = null;
function theRoof(): Rooftop {
  if (!roof) {
    roof = buildRooftop(office.night, roofFloors());
    roof.group.visible = false;
    scene.add(roof.group);
    noOutline(roof.group);
  }
  return roof;
}
/** How many floors the roof stands on: every one that's built. */
function roofFloors(): number {
  return Math.max(1, builtFloors().length);
}
/** Floors come and go: the roof goes up or down with them, and the street's that much further down from it. */
function syncRoof() {
  if (!roof) return;
  const floors = roofFloors();
  roof.setFloors(floors);
  if (upTop) sky.setRoof(true, roofDrop(floors));
}
store.on('floors', syncRoof);
/** Where you are now: up on the roof (true), or on a floor of the office. */
let upTop = false;
/** How far into the DJ's set it is, on the office's clock, so everyone up there hears the same bar. */
const djAt = () => djTime(store.officeNow());
/** Drinks from the bar, and how they make the world look (see booze.ts, world/drunk.ts). */
const booze = new Booze();
const drunkVision = new DrunkVision(renderer);

// ---- Networking & state -------------------------------------------------------------------------
const net = new Net(() => store.profile, whereNow);
bindFactory(net);

const me = new Person(store.profile.name, store.profile.color, store.profile.look);
me.showLabel(false);
scene.add(me.root);
noOutline(me.root);
const settings = loadSettings();
const player = new PlayerController(camera, canvas, office.colliders);
// Everyone arrives by elevator (the welcome says exactly where).
placeInCar();
player.view = settings.view;
const hands = new Hands(store.profile.color, me.skinColor);
const caffeine = new Caffeine();
/** No shaking the view for the coffee jitters when the system asks for less motion. */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Cigarette smoke, from anyone on a smoke break.
const smoke = new Smoke();
scene.add(smoke.group);
const puff = (kind: 'wisp' | 'exhale', at: THREE.Vector3, dir: THREE.Vector3) => (kind === 'wisp' ? smoke.wisp(at) : smoke.exhale(at, dir));
const camLocal = new THREE.Vector3();
// In first person yours comes off the cigarette in your hand and out in front of the camera.
me.onSmoke = (kind, at, dir) => {
  if (player.view !== 'first') return puff(kind, at, dir);
  if (kind === 'wisp') return smoke.wisp(camera.localToWorld(hands.cigTip(camLocal)));
  smoke.exhale(camera.localToWorld(camLocal.set(0, -0.14, -0.3)), camera.getWorldDirection(camLocal).setY(0.1).normalize());
};
const sound = new OfficeSound();
sound.setVolume(settings.volume, settings.muted);
sound.setMusicVolume(settings.music, settings.musicMuted);
sound.onMusicError = (text) => toast(text, 'warn');
// The jukebox on your floor: everyone there hears it from the same bar, and its lights say what's on.
store.on('jukebox', () => {
  const j = store.jukebox;
  sound.setJukebox(j.on ? { track: j.track, url: j.url, startedAt: j.startedAt, since: j.since } : null);
  office.jukebox.show(j.on, trackTitle(j));
});
// The arcade cabinet next to it: BLOCKFALL up close, and on its screen.
const cabinet = new Cabinet(office.cabinet.screen, net, { openTerminal: (id) => openWorkerTerminal(id), sound: (kind, lines) => sound.arcade(kind, lines) });
const notifier = new DesktopNotifier(
  () => settings.notify,
  (id) => openWorkerTerminal(id),
);
// ---- Golf off the balcony --------------------------------------------------------------------------
// Everyone's balls, in the air or lying where they stopped.
const balls = new GolfBalls();
scene.add(balls.group);
/** Your closest shot to the pin so far (meters) and how many you've holed in one, kept in this browser. */
const GOLF_KEY = 'droid-office.golf';
function golfRecord(): { best: number | null; holes: number } {
  try {
    const r = JSON.parse(localStorage.getItem(GOLF_KEY) ?? '{}') as { best?: unknown; holes?: unknown };
    return { best: typeof r.best === 'number' ? r.best : null, holes: typeof r.holes === 'number' ? r.holes : 0 };
  } catch {
    return { best: null, holes: 0 };
  }
}
function saveGolfRecord(r: { best: number | null; holes: number }) {
  try {
    localStorage.setItem(GOLF_KEY, JSON.stringify(r));
  } catch {
    // private window: it's only for this visit then
  }
}
/** A shot off the tee: where it goes is worked out the same way everywhere. */
function shotHere(shot: Shot): Flight {
  return fly(shot, player.street, office.stack.state.index);
}
const golf = new Golfer(player, me, camera, {
  holding: () => undefined,
  hit: (shot) => {
    balls.launch(shotHere(shot));
    sound.golf('hit');
  },
  ball: () => balls.mine,
  street: () => player.street,
  done: () => {
    // Not '': that reads as "no hint shown", and the golf hint would stay up.
    hintKey = 'stale';
  },
});
balls.onHit = (hit: Hit) => {
  // Your ball's heard wherever it lands (the camera's following it).
  if (hit.kind === 'cup') sound.golf('cup');
  else if (hit.kind === 'bounce') sound.golf(hit.lie === 'sand' || hit.lie === 'rough' ? 'thud' : 'bounce', undefined, hit.speed);
  else sound.golf(hit.kind, undefined, hit.speed);
};
balls.onRest = (f: Flight) => {
  if (f.holed) {
    confetti.burst(GOLF_HOLE.x, player.street + 1.2, GOLF_HOLE.z, 260, 1.4);
    sound.golf('cheer');
  }
  const rec = golfRecord();
  if (f.holed) {
    rec.holes++;
    toast(rec.holes === 1 ? 'HOLE IN ONE!' : `HOLE IN ONE! That's ${rec.holes}`);
  } else if (Number.isFinite(f.fromPin) && (rec.best === null || f.fromPin < rec.best)) {
    if (rec.best !== null) toast(`${pinText(f.fromPin)} from the pin — your best yet!`);
    rec.best = f.fromPin;
  } else return;
  saveGolfRecord(rec);
};

/** E at the tee: take a club out and step up to the ball. */
function teeOff() {
  if (golf.active || trip || climber.active) return;
  if (carrying) return toast(`Your hands are full: put #${carrying.issue} down first (Q)`, 'warn');
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (errand) stopWalking();
  if (smokeBreakUntil) setSmoking(false);
  holsterGun(true);
  golf.start();
}

sky.onThunder = (delay, loud) => sound.thunder(delay, loud);
const hanger = new Hanger(net, camera, canvas, player, office, gallery);
scene.add(hanger.ghost.group);
hanger.onChange = () => {
  hud.refresh();
  // Not '': that reads as "no hint shown", and the hanging hint would stay up.
  hintKey = 'stale';
};

// ---- The ladder and the fire poles ----------------------------------------------------------------
/** The floors of the building from the bottom up. */
function builtFloors(): FloorInfo[] {
  return store.floors;
}
/** The floor above yours (1) or below it (-1), if there is one. */
function floorThere(way: Way): FloorInfo | undefined {
  const floors = builtFloors();
  const i = floors.findIndex((f) => f.id === store.floor);
  return i < 0 ? undefined : floors[i + way];
}
const climber = new Climber(player, {
  floorThere: (way) => floorThere(way)?.name,
  travel: (way, how, at) => {
    const f = floorThere(way);
    if (f) travel(f.id, how, at);
    else climber.abort();
  },
  sound: (kind, speed = 0) => {
    if (kind === 'grab') sound.rung(true);
    else if (kind === 'rung') sound.rung();
    else if (kind === 'slide') sound.slide();
    else if (kind === 'twirl') sound.twirl();
    else if (kind === 'bonk') {
      sound.bonk();
      toast(`🔝 ${store.currentFloor()?.name ?? 'This'} is the top floor — the hatch won't budge`);
    } else if (kind === 'land') {
      sound.poleLanding(speed);
      landed(speed);
    }
  },
  done: () => {
    // Not '': that reads as "no hint shown", and the climbing hint would stay up.
    hintKey = 'stale';
  },
});
/** How hard the view shakes from landing off a pole, easing off to 0. */
let thud = 0;
/** Down the pole onto the mat: the view shakes, dust flies, and there's the floor you're on now. */
function landed(speed: number) {
  if (!reduceMotion.matches) thud = Math.min(1, speed / 7);
  const at = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    at.set(player.pos.x + Math.sin(a) * 0.3, player.pos.y + 0.08, player.pos.z + Math.cos(a) * 0.3);
    smoke.exhale(at, dir.set(Math.sin(a), 0.15, Math.cos(a)).normalize());
  }
  const f = store.currentFloor();
  toast(`🚒 Wheee! Down to ${f?.name ?? 'the floor below'}`);
}
office.stack.onHatch = (where, open) => sound.hatch({ x: LADDER.x + 0.3, y: where === 'floor' ? 0 : WALL_HEIGHT, z: LADDER.z }, open);
// Speed lines round the edge of the screen, sliding down a pole.
const whoosh = h('div', { id: 'whoosh' });
$('app').append(whoosh);

/** E at the ladder: onto it, facing the wall. */
function grabLadder() {
  if (trip || climber.active) return;
  if (!floorThere(1) && !floorThere(-1)) return toast('No other floors yet — add a project in the elevator', 'warn');
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (errand) stopWalking();
  climber.grabLadder();
}

/** E at a fire pole: down it, if there's a floor below; else (on the bottom floor) a spin round it. */
function usePole(i: number) {
  const spot = POLES[i];
  if (trip || climber.active || !spot) return;
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (errand) stopWalking();
  if (office.stack.polesGoDown()) climber.slide(spot);
  else climber.twirl(spot);
}

/**
 * The ladder and the poles go where there are floors to go to from this one, and the building is as
 * tall as there are floors, with the street as far down as this one is up.
 */
function syncStack() {
  const floors = builtFloors();
  const index = floors.findIndex((f) => f.id === store.floor);
  // Up on the roof there's no ladder or pole to take: nothing above, nothing below.
  const up = store.floor === ROOF ? undefined : floors[index + 1]?.name;
  const down = index > 0 ? floors[index - 1]?.name : undefined;
  const count = index < 0 ? 1 : floors.length;
  const s = office.stack.state;
  if (s.index === Math.max(0, index) && s.count === count && s.up === up && s.down === down) return;
  office.stack.set({ index: Math.max(0, index), count, up, down });
  office.setLevel(Math.max(0, index), count);
  player.street = streetBelow(index);
}
store.on('floors', syncStack);

function showMyProfile(p: Profile) {
  me.setColor(p.color);
  me.setLook(p.look);
  hands.setColor(p.color);
  hands.setSkin(me.skinColor);
}

interface WorkerView {
  model: Worker;
  laptop: Laptop;
  deskId: string;
  status: string;
  acked: boolean;
}
const workerViews = new Map<string, WorkerView>();
/** Workers a `worker.remove` is taking out of the store right now. They walk out of the building; a worker that's gone because you changed floors just vanishes. */
const sentHome = new Set<string>();
// Workers sent home, packing up and walking out with a box of their things.
const departures = new Departures(
  scene,
  (x, z, y) => groundAt(office.colliders, x, z, y),
  () => arrangeSeats(),
  () => office.stack.state.index > 0,
);
// Workers called to a meeting, walking in from the elevator to the meeting table.
const arrivals = new Arrivals(scene, (x, z, y) => groundAt(office.colliders, x, z, y));
// Workers shot with the .44 Magnum: shared downed state, then revival or a medic pickup.
const casualties = new Casualties(scene, (x, z, y) => groundAt(office.colliders, x, z, y), {
  spawnMedic: (name) => {
    const m = new Person(name, '#f2f4f6', randomLook());
    noOutline(m.root);
    return m;
  },
  onLand: (at) => sound.thud(at),
  onSiren: (at) => sound.siren(at),
});
/** The gun in your right hand (`7` draws and holsters it). */
let gunOut = false;
/** Dust where missed shots cracked into the walls and floor, and the spray where workers were hit. */
const puffs: { group: THREE.Object3D; update(dt: number): boolean; dispose(): void }[] = [];

/** `7`: the .44 Magnum out of its holster, or back in. */
function toggleGun() {
  if (gunOut) {
    holsterGun();
    return;
  }
  if (golf.active) return toast('Your hands are full: put the club back first (E)', 'warn');
  if (climber.active) return toast('Your hands are full: both hands on the climb', 'warn');
  if (hanger.active) return toast('Your hands are full: hang the picture first (or F to stop)', 'warn');
  if (carrying) return toast(`Your hands are full: put #${carrying.issue} down first (Q)`, 'warn');
  if (readingNow()) return toast('Your hands are full: close the book first', 'warn');
  gunOut = true;
  hands.holdGun(true);
  me.setGun(true);
  sound.gunDraw();
  hintKey = 'stale';
}

/** The gun back in its holster. */
function holsterGun(quiet = false) {
  if (!gunOut) return;
  gunOut = false;
  hands.holdGun(false);
  me.setGun(false);
  if (!quiet) sound.gunHolster();
  hintKey = 'stale';
}

/** A click with the gun out: fire at what's under the crosshair (or the mouse, in third person). */
function fireGun(ndc: THREE.Vector2) {
  hands.fireGun();
  me.fire();
  sound.gunshot();
  // One shell of kick up the camera.
  if (!reduceMotion.matches) thud = Math.max(thud, 0.4);
  // Smoke curling off the muzzle.
  const tip = player.view === 'first' ? hands.muzzleTip(new THREE.Vector3()) : me.muzzleTip(new THREE.Vector3());
  if (tip) {
    if (player.view === 'first') camera.localToWorld(tip);
    for (let i = 0; i < 2; i++) {
      tip.x += (Math.random() - 0.5) * 0.05;
      tip.y += Math.random() * 0.04;
      tip.z += (Math.random() - 0.5) * 0.05;
      smoke.wisp(tip);
    }
  }
  raycaster.setFromCamera(ndc, camera);
  resolveGunShot();
}

function resolveGunShot() {
  if (upTop) return;
  const byRoot = new Map<THREE.Object3D, string>();
  for (const [id, v] of workerViews) byRoot.set(v.model.root, id);
  // Workers sit inside the office; ones still walking in are out in the scene. Players are never targets.
  const result = gunHit(raycaster, office.group, byRoot);
  const direction = raycaster.ray.direction.clone();
  landShot(result, direction);
}

/**
 * What a bullet does where it lands. Anything solid in front blocks it, and a miss cracks into it
 * with dust. A worker sprays blood back out of the wound with a wet smack and is shot: the server
 * starts its revival window (worker.shoot) and every client on the floor sees it go down, its
 * session still running. No menu opens anywhere.
 */
function landShot(result: ReturnType<typeof gunHit>, direction: THREE.Vector3) {
  const hit = result?.hit;
  const workerId = result?.workerId ?? null;
  if (!hit || workerId === null) {
    if (!hit) return;
    const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? null;
    const puff = new Puff(hit.point, normal);
    scene.add(puff.group);
    puffs.push(puff);
    sound.impact(hit.point);
    return;
  }
  // A guest isn't the office's to shoot, nor is a cloud worker on its Factory computer: the round goes into its chair like a miss.
  const target = store.workers.get(workerId);
  if (target?.guest || target?.cloud) {
    const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? null;
    const puff = new Puff(hit.point, normal);
    scene.add(puff.group);
    puffs.push(puff);
    sound.impact(hit.point);
    hintToast(target.cloud ? `${target.name} works on ${cloudBadge(target.cloud)}: there's nobody really at this desk to shoot` : `${target.name} is a guest from outside the office: the office leaves it alone`, 'info');
    return;
  }
  const out = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : direction.clone().negate();
  const spray = new BloodSpray(hit.point, out, direction);
  scene.add(spray.group);
  puffs.push(spray);
  sound.hit(hit.point);
  const v = workerViews.get(workerId);
  const w = store.workers.get(workerId);
  const desk = v ? office.desks.get(v.deskId) : undefined;
  if (!v || !w || !desk || w.downedUntil !== undefined) return;
  net.send({ t: 'worker.shoot', workerId });
}

/** Walk up to a body to revive it; the gun can stay drawn. */
function nearbyCasualty(): WorkerInfo | undefined {
  if (!net.up || upTop) return undefined;
  const id = casualties.nearby(player.pos);
  const w = id ? store.workers.get(id) : undefined;
  return w?.downedUntil !== undefined && w.downedUntil > store.officeNow() ? w : undefined;
}

function reviveNearby(): boolean {
  const w = nearbyCasualty();
  if (!w) return false;
  reach();
  net.send({ t: 'worker.revive', workerId: w.id });
  return true;
}

/** Set while a floor's workers arrive with it (a welcome, an elevator ride): they're in their seats already. */
let seatedAlready = false;
let firstWelcome = true;
/** The server version this page was loaded with. */
let bootVersion = '';
let upgradePhase = '';

net.onStatus((up) => {
  $('conn').classList.toggle('hidden', up);
});
net.onMessage((msg) => {
  // The floor you asked to come back to (see Net.connect), to tell if the office put you somewhere else.
  const wasOn = msg.t === 'welcome' ? (store.floor ?? lastFloor()) : null;
  if (msg.t === 'welcome' || msg.t === 'floor.enter') {
    departures.clear();
    arrivals.clear();
    casualties.clear();
    seatedAlready = true;
  }
  if (msg.t === 'worker.remove') sentHome.add(msg.workerId);
  store.apply(msg);
  seatedAlready = false;
  sentHome.clear();
  routeTerminalMessage(msg);
  routeChangesMessage(msg);
  routePullMessage(msg);
  routeJiraMessage(msg);
  routeElevatorMessage(msg);
  switch (msg.t) {
    case 'welcome': {
      // A few pings, to line this page's clock up with the office's for the jukebox.
      for (let i = 0; i < 5; i++) setTimeout(() => net.send({ t: 'ping', at: performance.now() }), 200 + i * 500);
      if (firstWelcome) {
        firstWelcome = false;
        // Where the office put you: back in the spot you left (if there's still room there), or in the elevator car.
        setPlace();
        syncStack();
        const spot = standSpot(msg.arrival, (x, y, z) => player.blockedAt(x, z, y));
        if (spot) {
          placeAt(spot);
          arrive('back');
        } else {
          placeInCar(msg.arrival.at);
          arrive();
        }
        const notice = removedFloorNotice(msg.arrival, wasOn, lastSpot(), store.floor);
        if (notice) toast(notice, 'warn');
      } else if (store.floor && store.floor !== wasOn) {
        // Back after the office restarted, but not on your floor: it went while the office was down.
        takenAway();
        if (carrying) setCarrying(null);
        arrive();
        const notice = removedFloorNotice(msg.arrival, wasOn, lastSpot(), store.floor);
        if (notice) toast(notice, 'warn');
      } else if (!store.floor) arrive();
      // After a reconnect the server has forgotten which terminal we had open.
      const openId = openTerminalFor();
      if (openId && store.workers.has(openId)) net.send({ t: 'worker.attach', workerId: openId });
      const watching = openChangesFor();
      if (watching && store.workers.has(watching.workerId)) net.send({ t: 'changes.watch', ...watching });
      renderProject();
      hud.refresh();
      // Back from a restart on another version: this page's code is stale, so load the new one.
      if (!bootVersion) bootVersion = msg.version;
      else if (msg.version !== bootVersion || restarting()) showUpgraded(msg.upgrade);
      upgradePhase = msg.upgrade.phase;
      break;
    }
    case 'floor.enter':
      // Not a trip of yours: the floor you were on was taken off the building, and the elevator took you away.
      if (!trip) takenAway();
      // The card belongs to the board downstairs (or up): the office already put it back there.
      if (carrying) {
        toast(`📌 #${carrying.issue} stayed behind on the other floor's board`);
        setCarrying(null);
      }
      arrive();
      break;
    case 'floors':
      noticeWaiting();
      break;
    case 'worker.worktree':
      routeWorktreeMessage(msg);
      break;
    case 'toast': {
      const el = toast(msg.text, msg.level);
      const id = msg.workerId;
      // About a worker on this floor (a subagent hired, a report back): a click opens its terminal.
      if (id && store.workers.has(id)) {
        el.classList.add('link');
        el.title = 'Open its terminal';
        el.addEventListener('click', () => openWorkerTerminal(id));
      }
      break;
    }
    case 'upgrade':
      if (msg.state.phase === 'restarting') showRestarting(msg.state, net);
      if (msg.state.phase === 'failed' && upgradePhase === 'building') toast(`The upgrade failed, so the office stays on ${msg.state.current?.sha ?? 'this version'}`, 'error');
      upgradePhase = msg.state.phase;
      break;
    case 'gong':
      gongRang(msg.why, msg.pr);
      break;
    case 'horn':
      if (!upTop) break;
      sound.horn();
      if (msg.by !== store.profile.name) toast(`📯 ${msg.by} blew the air horn!`);
      break;
    case 'automation.run': {
      const { id } = msg;
      runCommand(automation, msg.cmd, msg.args).then(
        (value) => net.send({ t: 'automation.result', id, ok: true, value }),
        (err: unknown) => net.send({ t: 'automation.result', id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      break;
    }
  }
});

function renderUpgrade() {
  const u = store.upgrade;
  const banner = $('upgrade-banner');
  banner.classList.toggle('hidden', u.phase !== 'building');
  banner.textContent = `🛠️ ${u.by ?? 'Someone'} is upgrading the office. It restarts on the new version in a minute or two.`;
}
store.on('upgrade', renderUpgrade);

function renderProject() {
  const p = store.project;
  renderTitle();
  if (store.floor === ROOF) {
    const n = builtFloors().length;
    $('project-meta').classList.remove('lobby');
    $('project-name').textContent = `🍸 ${ROOF_NAME}`;
    $('project-meta').textContent = `🛗 on top of ${n} floor${n === 1 ? '' : 's'} · 🎧 drum & bass`;
    return;
  }
  if (!p) {
    $('project-name').textContent = '🏢 Droid Office';
    $('project-meta').textContent = store.floors.length ? '🛗 Take the elevator to a floor' : '🛗 No floors yet — add a project in the elevator';
    // Where to go next, so it shows even with the floor details turned off.
    $('project-meta').classList.add('lobby');
    office.setProjectName(store.floors.length ? 'Pick a floor' : 'Lobby');
    return;
  }
  const n = store.floors.findIndex((f) => f.id === store.floor);
  $('project-meta').classList.remove('lobby');
  $('project-name').textContent = `🏢 ${p.name}`;
  $('project-meta').textContent = [n >= 0 && `🛗 floor ${n + 1} of ${store.floors.length}`, p.branch && `⎇ ${p.branch}`, p.dir, `agent: ${p.agentCmd.split(' ')[0].split(/[\\/]/).pop() ?? 'droid'}`].filter(Boolean).join(' · ');
  office.setProjectName(p.name);
}
store.on('floors', renderProject);
store.on('project', renderProject);

/** The tab title counts the workers waiting on someone, on every floor, so you can see them from another tab. */
function renderTitle() {
  const name = store.project?.name;
  const elsewhere = store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0);
  const waiting = [...store.workers.values()].filter(waitingOnSomeone).length + elsewhere;
  document.title = `${waiting ? `(${waiting}) ` : ''}${name ? `${name} · ` : ''}Droid Office`;
}

// ---- Floors & the elevator ----------------------------------------------------------------------
/** In the car, facing out through the doors: where you are when you arrive on a floor. */
function placeInCar(at?: { x: number; z: number }) {
  const spot = at && inElevator(at.x, at.z) ? at : { x: ELEVATOR.x, z: (ELEVATOR_CAR.minZ + ELEVATOR_CAR.maxZ) / 2 };
  placeAt({ x: spot.x, y: 0, z: spot.z, rotY: 0 });
}

/** On your feet at `at`, facing `rotY` and looking straight ahead. */
function placeAt(at: { x: number; y: number; z: number; rotY: number }) {
  if (player.seat) standUp();
  player.pos.set(at.x, at.y, at.z);
  player.vy = 0;
  player.facing = at.rotY;
  player.camYaw = player.facing - Math.PI;
  player.lookPitch = -0.08;
}

/** Not a trip of yours: the office put you on another floor (yours went), in its elevator car. Whatever you were doing stops. */
function takenAway() {
  closeAllModals();
  if (hanger.active) hanger.cancel();
  if (climber.active) climber.abort();
  if (errand) stopWalking();
  placeInCar();
}

/** Where you're standing, to come back to (see lastSpot): nowhere while you're between floors, or climbing between them. */
function spotHere(): Spot | null {
  if (!store.floor || trip || climber.active) return null;
  // Sitting, it's where you'd get up to.
  const at = player.standingSpot() ?? player.pos;
  const name = store.floor === ROOF ? ROOF_NAME : (store.currentFloor()?.name ?? '');
  return { floor: store.floor, name, x: at.x, y: at.y, z: at.z, facing: player.facing };
}

/** Where to put you back when the office lets you in: where you are now, or before this page was loaded, where you were last time. */
function whereNow(): Spot | null {
  return firstWelcome ? lastSpot() : spotHere();
}

function saveSpot() {
  const s = spotHere();
  if (s) rememberSpot(s);
}
// Closing the tab, or reloading: the frame loop saves it every second, and here's the last word.
window.addEventListener('pagehide', saveSpot);

function fade(on: boolean, quick = false) {
  $('fade').classList.toggle('quick', quick);
  $('fade').classList.toggle('on', on);
}

/** How you're going to another floor: by elevator, straight there from the floor list, or by the ladder or a pole. */
type TripKind = 'elevator' | 'switch' | Grip;
/** A trip under way: the lights are down (and by elevator the doors are shut) until the next floor arrives. */
let trip: { floor: string; how: TripKind; timer: number } | null = null;

function showElevator() {
  openElevator({ net, ride });
}

/** The elevator where you are: the office's, or the one up on the roof. */
function lift() {
  return upTop && roof ? roof.elevator : office.elevator;
}

/** Rides the elevator to another floor (or up to the roof). From outside the car, you step in while the lights are down. */
function ride(floorId: string) {
  if (trip || floorId === store.floor) return;
  holsterGun(true);
  closeAllModals();
  if (hanger.active) hanger.cancel();
  if (climber.active) climber.abort();
  if (golf.active) golf.stop();
  const inside = inElevator(player.pos.x, player.pos.z);
  trip = { floor: floorId, how: 'elevator', timer: window.setTimeout(tripFailed, 10_000) };
  player.enabled = false;
  player.clearKeys();
  lift().setOpen(false);
  // Wait for the doors to shut on you, then dim the lights and go.
  setTimeout(
    () => {
      fade(true);
      setTimeout(() => {
        placeInCar(inside ? player.pos : undefined);
        net.send({ t: 'floor.go', floor: floorId });
      }, 320);
    },
    inside ? 650 : 0,
  );
}

/** Where you are, to arrive at the same spot on floor `to`. Down on the street (or the steps to it), that's the street there too. */
function standingAt(to: string): Arrival {
  const floors = builtFloors();
  const from = floors.findIndex((f) => f.id === store.floor);
  const there = floors.findIndex((f) => f.id === to);
  const below = player.pos.y < -SLAB - 0.05 && from >= 0 && there >= 0;
  return { x: player.pos.x, y: below ? player.pos.y + (from - there) * STOREY : player.pos.y, z: player.pos.z, rotY: player.facing };
}

/** Straight to another floor from the floor list: a blink, and you're standing in the same spot there. */
function switchFloor(floorId: string) {
  // The roof isn't laid out like a floor: to and from it, it's the elevator.
  if (upTop || floorId === ROOF) return ride(floorId);
  if (trip || floorId === store.floor) return;
  holsterGun(true);
  closeAllModals();
  if (hanger.active) hanger.cancel();
  if (climber.active) climber.abort();
  if (golf.active) golf.stop();
  if (player.seat) standUp();
  // The floor list isn't a window, so nothing else stops an errand on this floor.
  if (errand) stopWalking();
  trip = { floor: floorId, how: 'switch', timer: window.setTimeout(tripFailed, 10_000) };
  player.enabled = false;
  player.clearKeys();
  fade(true, true);
  setTimeout(() => net.send({ t: 'floor.go', floor: floorId, at: standingAt(floorId) }), 170);
}

/** Through the ceiling up the ladder, or through the floor down one: the lights dip as you pass. */
function travel(floorId: string, how: Grip, at: Arrival) {
  if (trip) return;
  holsterGun(true);
  trip = { floor: floorId, how, timer: window.setTimeout(tripFailed, 10_000) };
  fade(true, true);
  setTimeout(() => net.send({ t: 'floor.go', floor: floorId, at }), 170);
}

/** The floor never came (it's gone, or the office is unreachable): back where you were. */
function tripFailed() {
  const t = trip;
  if (!t) return;
  trip = null;
  fade(false);
  if (t.how === 'elevator') lift().setOpen(!!store.floor);
  if (t.how === 'ladder' || t.how === 'pole') climber.abort();
  player.enabled = !modalOpen();
}

/** Arrived in a spot that's a pole's hole on this floor: step out of it, the way in. */
function unstick() {
  if (!office.stack.polesGoDown()) return;
  const p = player.pos;
  const spot = office.stack.poles().find((s) => Math.max(Math.abs(p.x - s.x), Math.abs(p.z - s.z)) <= POLE.rail + 0.35);
  if (!spot) return;
  const out = POLE.rail + 0.7;
  p.set(spot.x + Math.sin(spot.open) * out, Math.max(0, p.y), spot.z + Math.cos(spot.open) * out);
}

/** Which of the floor palettes the walls are painted in now. */
let painted = -1;
function paintFloor() {
  const p = store.currentFloor()?.palette ?? 0;
  if (p === painted) return;
  painted = p;
  office.setLook(floorPalette(p));
}
// A brand-new floor can arrive before the elevator's list says what color it is.
store.on('floors', paintFloor);

/**
 * Up on the roof, or back down in the office: shows the one you're in, and walks, sounds, lights and
 * looks as it does there.
 */
function setPlace() {
  const up = store.floor === ROOF;
  if (up === upTop) return;
  upTop = up;
  const r = up ? theRoof() : roof;
  office.group.visible = !up;
  if (r) r.group.visible = up;
  player.colliders = up ? r!.colliders : office.colliders;
  sky.setRoof(up, roofDrop(roofFloors()));
  sound.setDj(up ? djAt : null);
  // You can see the whole city from up there (and its clouds); from the top floors, as far as the haze.
  camera.far = up ? 700 : FAR;
  camera.updateProjectionMatrix();
  // Drinks stay at the bar (what you've had comes down with you).
  if (!up) booze.putDown();
  if (hanger.active) hanger.cancel();
  hintKey = 'stale';
}

/** What you can use where you are, and what's in the way of looking at it. */
function usable(): Interactable[][] {
  return upTop && roof ? [roof.interactables] : [office.interactables, gallery.interactables];
}

/**
 * You're on a floor (or in the building without one): paint it, and open the doors (or carry on down
 * the pole…). `back` is standing in the spot you left from last time, the doors open already.
 */
function arrive(how: TripKind | 'back' = trip?.how ?? 'elevator') {
  // The balls lying about were this floor's, and so were a menu left open and the laptop you typed into.
  balls.clear();
  setPlace();
  paintFloor();
  renderProject();
  noticeWaiting();
  syncStack();
  if (trip) {
    clearTimeout(trip.timer);
    trip = null;
  }
  if (!store.floor) {
    // Nowhere to go yet: the doors stay shut until there's a floor, and the panel says how to add one.
    office.elevator.setOpen(false);
    fade(false);
    player.enabled = !modalOpen();
    showElevator();
    return;
  }
  fade(false);
  if (how === 'back') {
    // The doors stand open, the way the last one out left them.
    lift().setOpen(true);
    player.enabled = !modalOpen();
    if (!upTop) unstick();
    return;
  }
  if (how !== 'elevator') {
    player.enabled = !modalOpen();
    if (how === 'switch') unstick();
    else climber.arrived();
    return;
  }
  setTimeout(() => {
    lift().setOpen(true);
    sound.ding('done');
    player.enabled = !modalOpen();
  }, 450);
}

/** Workers waiting on someone, per floor, the last time the elevator said so. */
const waitingOn = new Map<string, number>();
/** Someone's waiting on another floor: say so, since you can't see or hear it from here. */
function noticeWaiting() {
  let elsewhere = 0;
  for (const f of store.floors) {
    const before = waitingOn.get(f.id);
    waitingOn.set(f.id, f.waiting);
    if (f.id === store.floor) continue;
    elsewhere += f.waiting;
    if (before !== undefined && f.waiting > before) {
      toast(`🙋 A worker on the ${f.name} floor is waiting on someone — take the elevator up`, 'warn');
      sound.ding('needs_input');
    }
  }
  const badge = $('floors-waiting');
  badge.textContent = elsewhere ? String(elsewhere) : '';
  badge.classList.toggle('hidden', !elsewhere);
  $('project').title = elsewhere ? `${elsewhere} worker${elsewhere === 1 ? '' : 's'} on other floors waiting on someone — click to go there` : 'Floors: go to another project';
}

// ---- Walking over to a spot -----------------------------------------------------------------------
/** What you're on your way to from the command palette: where to stand, what it's called, what to turn to and what to do there. */
let errand: { at: { x: number; z: number }; what: string; face?: { x: number; z: number }; then: () => void; end?: (why: WalkEnd) => void } | null = null;
type WalkEnd = 'arrived' | 'cancelled' | 'stuck';

function stopWalking() {
  const e = errand;
  errand = null;
  player.stopWalking();
  e?.end?.('cancelled');
}

/** There: stop, and turn to it. */
function arrivedAt(at: { x: number; z: number }) {
  stopWalking();
  const yaw = Math.atan2(at.x - player.pos.x, at.z - player.pos.z);
  player.facing = yaw;
  player.camYaw = yaw - Math.PI;
}

player.onPathEnd = (why) => {
  if (errand) return errandEnd(why);
};

/**
 * Walks you over to `at` on this floor and does `then` when you get there. Where there's no walking
 * to be done (up on the roof, riding the elevator, on the ladder) it just does it.
 * A key of yours takes over, and then it doesn't happen. `end` hears how the walk ended.
 */
function walkThen(at: { x: number; y?: number; z: number }, what: string, then: () => void, face?: { x: number; z: number }, end?: (why: WalkEnd) => void) {
  const now = () => {
    then();
    end?.('arrived');
  };
  if (upTop || trip || climber.active) return now();
  closeAllModals();
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (golf.active) golf.stop();
  if (errand) stopWalking();
  const to = { x: at.x, y: at.y ?? 0, z: at.z };
  const path = wayTo(player.pos, to);
  if (!path.length) return now();
  errand = { at, what, face, then, end };
  toast(`🚶 Walking over to ${what}`);
  player.walkPath(path);
}

function errandEnd(why: WalkEnd) {
  const e = errand!;
  errand = null;
  if (why === 'cancelled') return e.end?.(why);
  if (why === 'stuck') toast(`🚧 Couldn't find a way over to ${e.what}, so here it is from where you are`, 'warn');
  else if (e.face) arrivedAt(e.face);
  else stopWalking();
  e.then();
  e.end?.(why);
}

// ---- Workers ------------------------------------------------------------------------------------
/** How close (meters) you stop a worker jumping, and how far you go before it starts again. */
const HOLD_NEAR = 4;
const HOLD_LEAVE = 5;

function syncWorkers() {
  for (const w of store.workers.values()) {
    let v = workerViews.get(w.id);
    const desk = office.desks.get(w.deskId);
    if (!desk) continue;
    if (!v) {
      departures.vacate(w.deskId);
      const model = new Worker(w.name, w.color);
      desk.seatAnchor.add(model.root);
      // Its globe floats beside the laptop (or the kiosk's counter), out from behind the card over
      // its head and the back of its chair, so it shows from across the room.
      const beside = desk.def.station ? new THREE.Vector3(0.62, 0.9, 0) : new THREE.Vector3(0.64, 0.5, -0.1);
      model.setPropSpot(model.root.worldToLocal(desk.laptopAnchor.localToWorld(beside)));
      // Called to a meeting just now: out of the elevator and over to the table, one after another.
      if (desk.def.room && !seatedAlready) arrivals.add(model, desk);
      const laptop = new Laptop();
      desk.laptopAnchor.add(laptop.root);
      noOutline(desk.group);
      desk.chair.rotation.y = 0;
      v = { model, laptop, deskId: w.deskId, status: '', acked: true };
      workerViews.set(w.id, v);
    }
    if (v.status !== w.status || v.acked !== w.acked) {
      // It just finished or started waiting on you (not already so when this page first saw it): ding, and notify if you're away.
      if (waitingOnSomeone(w) && v.status !== '' && w.status !== v.status) {
        sound.ding(w.status);
        notifier.alert(w);
        // Playing at the arcade: a worker waiting on input stops the game.
        if (w.status === 'needs_input') cabinet.needsYou(w);
      }
      // Finished what it was on: a little spin and a puff of confetti.
      if (w.status === 'done' && (v.status === 'working' || v.status === 'needs_input')) {
        v.model.celebrate();
        burstOver(w.deskId, 40);
      }
      v.status = w.status;
      v.acked = w.acked;
      v.model.setStatus(w.status, waitingOnSomeone(w));
      noOutline(v.model.root);
    }
    v.model.setAction(w.action);
    v.model.setPr(prBadge(w));
    v.model.setLost(!!w.lost);
    const engineBadge = w.cloud ? cloudBadge(w.cloud) : w.kind === 'agent' ? modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : undefined;
    const deskDef = DESK_BY_ID.get(w.deskId);
    // A cloud worker's card says where it runs even before it has a task.
    const task = w.task ?? (w.cloud ? { name: 'Ready', summary: w.cloud.error ?? 'Waiting for a prompt' } : undefined);
    v.model.setTask(meetingCard(w) ?? (task && w.kind !== 'shell' ? { ...task, name: engineBadge ? `${engineBadge} · ${task.name}` : task.name } : task));
    // Keys clack while it types, not while it reads, watches its tests or browses.
    if (deskDef) sound.setTyping(w.id, deskDef.x, deskDef.z, w.status === 'working' && (!w.action || w.action === 'edit'));
    const again = w.kind === 'shell' ? 'restart' : 'resume';
    const lost = `🌿 ${w.name}'s worktree was deleted — press E to fix it`;
    const outside = w.guest ? `🚪 ${PROVIDER_LABEL[w.guest.provider]}, outside the office · ${w.guest.tty}` : w.cloud && (w.cloud.error ? `☁ ${w.cloud.error}` : `☁ Running on ${w.cloud.computerName} · E to open`);
    v.laptop.setPlaceholder(outside ? outside : w.lost ? lost : w.status === 'offline' ? `💤 ${w.name} is asleep — press R to ${again}` : w.status === 'exited' ? `${w.name} exited` : 'booting…');
    if (w.downedUntil !== undefined) {
      arrivals.forget(v.model);
      casualties.shoot(w.id, v.model, desk.seatAnchor);
    } else if (casualties.revive(w.id)) v.model.cheer(0.8);
  }
  for (const [id, v] of workerViews) {
    if (store.workers.has(id)) continue;
    arrivals.forget(v.model);
    const desk = office.desks.get(v.deskId);
    // A shot worker: the medics take the body instead of the send-home walk-out.
    if (casualties.dying(id)) {
      if (desk) casualties.confirm(id, v.laptop);
      else {
        casualties.revive(id);
        v.model.root.removeFromParent();
        v.laptop.root.removeFromParent();
        v.model.dispose();
        v.laptop.dispose();
      }
    } else if (desk && sentHome.has(id)) departures.add(v.model, v.laptop, desk);
    else {
      v.model.root.removeFromParent();
      v.laptop.root.removeFromParent();
      v.model.dispose();
      v.laptop.dispose();
    }
    sound.removeTypist(id);
    workerViews.delete(id);
  }
  arrangeSeats();
  syncTeamLines();
  renderWorkers((id) => openWorkerTerminal(id));
  renderWaiting();
  notifier.sync(store.workers);
  renderTitle();
}

/** The dashes on the floor from each lead to its subagents, marching while any of them works. */
function syncTeamLines() {
  const seat = (deskId: string) => {
    const desk = office.desks.get(deskId);
    if (!desk) return undefined;
    const p = desk.seatAnchor.getWorldPosition(new THREE.Vector3());
    return { x: p.x, y: desk.group.position.y, z: p.z };
  };
  const links: TeamLink[] = [];
  let working = false;
  for (const w of store.workers.values()) {
    const lead = w.lead ? store.workers.get(w.lead) : undefined;
    const from = lead && seat(lead.deskId);
    const to = seat(w.deskId);
    if (!lead || !from || !to) continue;
    links.push({ from, to, color: lead.color });
    working ||= w.status === 'working';
  }
  teamLines.set(links, working);
}

/**
 * The card over a worker at the meeting table: its role, the round, and whether it has the floor
 * (working on its part) or is listening while the others work on theirs.
 */
function meetingCard(w: WorkerInfo): WorkerTask | undefined {
  const m = store.meeting.current;
  if (!w.meeting || !m || m.id !== w.meeting) return undefined;
  const i = m.seats.findIndex((s) => s.workerId === w.id);
  if (i < 0) return undefined;
  const role = m.seats[i].role;
  const p = MEETING_PATTERNS[m.pattern];
  if (m.status !== 'running') return { name: `${role} · ${p.icon} ${p.label}`, summary: m.status === 'done' ? `✅ The meeting wrote ${m.output}` : `⛔ Stopped: ${m.reason ?? 'stopped'}` };
  const t = m.turns.find((x) => x.seat === i);
  if (!t || t.state === 'done') return { name: `👂 ${role} · round ${m.round} of ${m.rounds}`, summary: t ? 'Part written: listening' : 'Listening' };
  return { name: `💬 ${role} · round ${m.round} of ${m.rounds}`, summary: t.state === 'working' ? t.doing : `${t.doing} (up next)` };
}

/**
 * A seat or kiosk shows it's free (its '+', or the board agent waiting there) only while nobody's at
 * it, and once every desk is taken, bean bags come out for the workers who don't fit.
 */
function arrangeSeats() {
  // Someone sent home still counts until they get up, so a bean bag stays out under them.
  const free = vacantSeats(store.workers.values(), (id) => departures.seated(id));
  for (const [id, desk] of office.desks) desk.vacancy.visible = free.has(id);
  const appeared = office.setBeanbags(beanbagsOut((id) => !free.has(id)));
  // One came out right where you're standing (on the office floor, not down in the garage): you end up on top of it.
  const p = player.pos;
  for (const c of appeared) if (p.y > -0.1 && p.y < c.top && p.x > c.minX - 0.3 && p.x < c.maxX + 0.3 && p.z > c.minZ - 0.3 && p.z < c.maxZ + 0.3) p.y = c.top;
}
store.on('workers', syncWorkers);
// A worker at the meeting table shows its role and round over its head (see meetingCard).
store.on('meeting', syncWorkers);

/** A worker's pull request for its bubble, named the way this floor's forge names it ("🎉 MR !12 merged"). */
function prBadge(w: WorkerInfo): PrBadge | undefined {
  const pr = workerPr(w, store.pulls.items, store.queue.tasks);
  if (!pr) return undefined;
  const { pr: kind, ref } = words();
  return { state: pr.state, label: `${pr.state === 'open' ? '🔀' : '🎉'} ${kind} ${ref(pr.number)} ${pr.state}` };
}
// A worker's bubble shows whether it has a pull request open (green) or merged (purple: send it home).
const paintPrs = () => {
  for (const [id, v] of workerViews) {
    const w = store.workers.get(id);
    if (w) v.model.setPr(prBadge(w));
  }
};
store.on('pulls', paintPrs);
store.on('queue', paintPrs);

// ---- Actions ------------------------------------------------------------------------------------
function freeDesk(): string | null {
  // Prefer the empty desk nearest to you; when they're all taken, the bean bag that's out.
  let best: string | null = null;
  let bestD = Infinity;
  for (const d of DESKS) {
    if (store.workerAtDesk(d.id)) continue;
    const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z);
    if (dist < bestD) {
      bestD = dist;
      best = d.id;
    }
  }
  return best ?? nextFreeSeat((id) => !!store.workerAtDesk(id))?.id ?? null;
}

let askedToNotify = false;

/** The office is at its worker limit: says so, and says yes (the office would refuse the hire anyway). */
function officeIsFull(): boolean {
  const m = store.machine;
  if (!officeFull(m)) return false;
  toast(`🚫 The office is at its limit of ${m.limit} worker${m.limit === 1 ? '' : 's'} — send one home before hiring another`, 'warn');
  return true;
}

function hire(deskId: string, prompt?: string, worktree = false, model?: string, effort?: AgentEffort, issue?: number, repos?: string[], images?: string[]) {
  net.send({ t: 'worker.spawn', deskId, prompt, worktree, model, effort, issue, repos: repos?.length ? repos : undefined, images: images?.length ? images : undefined });
  // The moment notifications start to matter: ask once (it has to come from a key press or click).
  if (settings.notify && notifyPermission() === 'default' && !askedToNotify) {
    askedToNotify = true;
    void askNotifyPermission();
  }
}

/** The building's other projects a new worker can work in too, each in a worktree of its own (see WorkerInfo.repos). */
function repoChoices(): { id: string; name: string }[] {
  return store.floors.filter((f) => f.id !== store.floor && f.branch).map((f) => ({ id: f.id, name: f.name }));
}

function openShell(deskId: string) {
  if (officeIsFull()) return;
  net.send({ t: 'worker.spawn', deskId, kind: 'shell' });
}

function promptAtDesk(deskId: string) {
  const w = store.workerAtDesk(deskId);
  const desk = DESK_BY_ID.get(deskId)!;
  if (!w) {
    if (officeIsFull()) return;
    openPrompt({
      title: `✨ New task at ${desk.label}`,
      subtitle: 'A fresh worker will sit down and start on this right away. Pick its model below.',
      warning: pressureNote(store.machine),
      submitLabel: 'Hire & start',
      modelOption: true,
      worktreeOption: !!store.project?.branch,
      imagesOption: true,
      deskId,
      repoOptions: repoChoices(),
      runsOn: runsOnPicker(),
      onCloud: (text, o) => hireCloud(deskId, text, o),
      onSubmit: (text, o) => hire(deskId, text, o.worktree, o.model, o.effort, undefined, o.repos, o.images),
    });
  } else if (w.cloud) {
    openCloudWindow(net, w.id);
  } else if (w.lost) {
    fixLostWorktree(w);
  } else if (isAsleep(w.status)) {
    toast(`${w.name} is asleep — press R to resume first`, 'warn');
  } else if (w.kind === 'shell') {
    openPrompt({
      title: `🐚 Run in ${w.name}`,
      placeholder: 'npm run dev',
      submitLabel: 'Run ▶',
      onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: w.id, prompt: text }),
    });
  } else {
    openPrompt({
      title: `💬 Prompt ${w.name}`,
      subtitle: w.status === 'working' ? `${w.name} is busy — your message will be queued in their input box.` : undefined,
      imagesOption: true,
      onSubmit: (text, o) => net.send({ t: 'worker.prompt', workerId: w.id, prompt: text, images: o.images.length ? o.images : undefined }),
    });
  }
}

function hireAtDesk(deskId: string) {
  const desk = DESK_BY_ID.get(deskId)!;
  if (officeIsFull()) return;
  openPrompt({
    title: `✨ Hire a worker at ${desk.label}`,
    subtitle: 'Pick its model. You can start with an empty prompt and send work later.',
    warning: pressureNote(store.machine),
    placeholder: 'Optional first task…',
    submitLabel: 'Hire & start',
    allowEmpty: true,
    modelOption: true,
    worktreeOption: !!store.project?.branch,
    imagesOption: true,
    deskId,
    repoOptions: repoChoices(),
    runsOn: runsOnPicker(),
    onCloud: (text, o) => hireCloud(deskId, text, o),
    onSubmit: (text, o) => hire(deskId, text || undefined, o.worktree, o.model, o.effort, undefined, o.repos, o.images),
  });
}

function killWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.downedUntil !== undefined) {
    const revive = `Walk up to ${w.name} and press E to revive — otherwise`;
    return toast(`${revive} the medics take it and delete its worktree and branch`, 'warn');
  }
  if (w.cloud) return sendCloudHome(net, w);
  const where = DESK_BY_ID.get(w.deskId)?.label ?? 'the desk';
  const session = w.kind === 'shell' ? 'shared shell' : 'Droid session';
  if (w.meeting) {
    // The meeting's worktree is the whole table's: it's tidied away once they've all gone.
    const m = store.meeting.current;
    const on = m?.id === w.meeting && m.status === 'running';
    confirmDialog(`Send ${w.name} home?`, on ? `${w.name} is in the meeting on “${m.title}”, which stops without it.` : `${w.name} leaves the meeting room.`, 'Send home', () => net.send({ t: 'worker.kill', workerId: id }));
    return;
  }
  if (w.worktree) {
    // A worker with its own worktree: choose what becomes of the worktree and its branch.
    sendHomeDialog({
      workerId: id,
      name: w.name,
      where,
      worktree: w.worktree,
      repos: w.repos?.length ? [w.worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
      ask: () => net.send({ t: 'worker.worktree', workerId: id }),
      onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: id, cleanup }),
    });
    return;
  }
  const body = DESK_BY_ID.get(w.deskId)?.station
    ? `This stops its ${session} for everyone, and it forgets what it was asked. The next prompt at the ${where} starts a fresh one.`
    : `This stops the ${session} at ${where} for everyone and frees the desk.`;
  confirmDialog(`Send ${w.name} home?`, body, 'Send home', () => net.send({ t: 'worker.kill', workerId: id }));
}
/** E at a board agent: type it a request. It's hired with it when nobody is there yet. */
function askStation(deskId: string) {
  const kind = DESK_BY_ID.get(deskId)?.station;
  if (!kind) return;
  const w = store.workerAtDesk(deskId);
  const name = STATION_AGENT[kind].name;
  const info = STATION_INFO[kind];
  // A prompt typed into a question it's asking would answer it.
  if (w?.status === 'needs_input') {
    toast(`The ${name} is waiting on an answer — here's its terminal`, 'warn');
    return openWorkerTerminal(w.id);
  }
  // Nobody there yet: asking hires the agent.
  if (!w && officeIsFull()) return;
  const subtitle = !w
    ? `${info.does}, in a terminal of my own: press O at the kiosk to watch.`
    : isAsleep(w.status)
      ? `The ${name} is asleep: this wakes it up, and it carries on where it left off.`
      : isBusy(w.status)
        ? `The ${name} is busy. Your prompt waits in its input box until it's done.`
        : undefined;
  openPrompt({
    title: `${info.icon} Ask the ${name}`,
    subtitle,
    placeholder: `e.g. ${info.example}`,
    submitLabel: 'Send ✨',
    warning: w ? undefined : pressureNote(store.machine),
    modelOption: !w,
    imagesOption: true,
    deskId,
    onSubmit: (text, o) => {
      net.send({ t: 'station.prompt', deskId, prompt: text, model: o.model, effort: o.effort, images: o.images.length ? o.images : undefined });
    },
  });
}

/**
 * Makes a droid guest one of the office's workers (see 'guest.bringIn'): once it has sat back down
 * as one, its terminal opens, unless another window took the screen meanwhile.
 */
function bringInGuest(w: WorkerInfo) {
  const g = w.guest;
  if (!g) return;
  if (g.cantBringIn) return toast(`${w.name} can't be brought in: ${g.cantBringIn}`, 'warn');
  const body = `Its droid on ${g.tty} quits, and that terminal goes back to the shell. ${w.name} then carries on the same session at this desk, as one of the office's workers: you type to it here.`;
  confirmDialog(`Bring ${w.name} into the office?`, body, 'Bring it in', () => {
    net.send({ t: 'guest.bringIn', workerId: w.id });
    const { deskId } = w;
    const off = store.on('workers', () => {
      const now = store.workerAtDesk(deskId);
      if (!now || now.guest) return;
      off();
      const open = openTerminalFor();
      if (!open || open === w.id) openWorkerTerminal(now.id);
    });
    setTimeout(off, 15_000);
  });
}

function resumeWorker(w: WorkerInfo) {
  if (w.lost) return fixLostWorktree(w);
  if (!w.sessionId && w.kind !== 'shell') toast(`${w.name} has no saved Droid session — starting a fresh one`, 'warn');
  net.send({ t: 'worker.resume', workerId: w.id });
}

/**
 * Anything done with a worker whose worktree was deleted outside droid-office (see WorkerInfo.lost):
 * it can't work there, so this says so and offers to put the folder back, everyone's at once when
 * more are lost, or to send it home.
 */
function fixLostWorktree(w: WorkerInfo) {
  if (!w.lost || !w.worktree) return;
  const others = [...store.workers.values()].filter((o) => o.lost && o.id !== w.id);
  lostWorktreeDialog({
    name: w.name,
    worktree: w.worktree,
    lost: w.lost,
    workspace: w.repos?.length ? w.worktree.path.replace(/[\\/][^\\/]*$/, '') : undefined,
    others: others.map((o) => o.name),
    openTerminal: isAsleep(w.status) ? undefined : () => openTerminal(net, w.id, () => openWorkerChanges(w.id)),
    rebuild: (all) => {
      toast(all ? `Rebuilding ${others.length + 1} worktrees…` : `Rebuilding ${w.name}'s worktree…`);
      net.send({ t: 'worker.rebuild', workerId: w.id, all });
    },
    sendHome: () => killWorker(w.id),
  });
}

/** Whether a worker's branch can become a PR: it has its own worktree, still there, and isn't mid-turn. */
function prReady(w: WorkerInfo) {
  return !!w.worktree && !w.lost && !isBusy(w.status);
}

/** O at a desk: see the worker's pull request, or push its branch and open one. */
function pullRequestFor(w: WorkerInfo) {
  if (w.cloud) return toast(cloudKeyNote(w), 'warn');
  if (w.repos?.length) return pullRequestsFor(w);
  if (w.pr) {
    const it = store.pulls.items.find((p) => p.number === w.pr!.number);
    if (it) openPull(it, net, boardActions());
    else window.open(w.pr.url, '_blank', 'noopener');
    return;
  }
  if (!w.worktree) return toast(`${w.name} works in the main checkout — only workers with their own worktree can open a PR`, 'warn');
  if (w.lost) return fixLostWorktree(w);
  if (w.prOpening) return;
  if (!prReady(w)) return toast(`${w.name} is still ${STATUS_LABEL[w.status]} — wait until it's done`, 'warn');
  toast(`Pushing ${w.worktree.branch} and opening a pull request…`);
  net.send({ t: 'worker.pr', workerId: w.id });
}

/**
 * O at the desk of a worker across repositories: with no pull request yet, the office opens one in
 * each repository it committed to (and lists them all in each one). Once it has one, O shows each
 * repository's, with a button for the ones still missing.
 */
function pullRequestsFor(w: WorkerInfo) {
  const open = () => {
    const now = store.workers.get(w.id);
    if (!now || now.prOpening) return;
    if (now.lost) return fixLostWorktree(now);
    if (!prReady(now)) return toast(`${now.name} is still ${STATUS_LABEL[now.status]} — wait until it's done`, 'warn');
    toast(`Pushing ${now.worktree?.branch ?? 'its branch'} in each of ${now.name}'s repositories and opening pull requests…`);
    net.send({ t: 'worker.pr', workerId: now.id });
  };
  if (!workerRepos(w).some((r) => r.pr)) return open();
  openRepoPulls(w.id, {
    openPull: (number, url) => {
      const it = store.pulls.items.find((p) => p.number === number);
      if (it) openPull(it, net, boardActions());
      else window.open(url, '_blank', 'noopener');
    },
    openMissing: open,
    changes: (repo) => openWorkerChanges(w.id, repo),
  });
}

/** Puts you in front of a desk, looking at it: the PR board's "Go to desk". */
function goToDesk(deskId: string) {
  const desk = DESK_BY_ID.get(deskId);
  if (!desk) return;
  closeAllModals();
  standAt(desk);
  const w = store.workerAtDesk(deskId);
  toast(w ? `You're at ${desk.label}, ${w.name}'s desk` : `You're at ${desk.label}`);
}

/** Behind the worker, looking over their shoulder at the laptop (or in front of a board agent's kiosk). */
function standAt(desk: DeskDef) {
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (climber.active) climber.abort();
  if (golf.active) golf.stop();
  if (errand) stopWalking();
  const spot = deskSeat(desk, desk.station ? -1.6 : desk.beanbag ? 1.6 : 2.4);
  player.pos.set(spot.x, 0, spot.z);
  player.vy = 0;
  player.facing = Math.atan2(desk.x - spot.x, desk.z - spot.z);
  player.camYaw = player.facing - Math.PI;
  player.lookPitch = -0.2;
}

// ---- Who's waiting on you: N, the count in the Workers panel, and the compass --------------------------
const nextUp = new NextUp();
const compass = new Compass($('compass'));
/** What the last press of N said, which the next press replaces. */
let nextToast: HTMLElement | null = null;

/** N: to the worker that has waited longest on someone, and on each press after, the next. */
function goToNextWaiting() {
  if (trip) return;
  const w = nextUp.next(store.workers.values(), waitingBeside());
  const desk = w && DESK_BY_ID.get(w.deskId);
  nextToast?.remove();
  if (!w || !desk) {
    const other = store.floors.find((f) => f.id !== store.floor && f.waiting > 0);
    nextToast = toast(other ? `🛗 Nobody's waiting on this floor. ${other.waiting} on the ${other.name} floor: take the elevator` : '👍 Nobody is waiting on you');
    return;
  }
  closeAllModals();
  standAt(desk);
  const waiting = waitingInOrder(store.workers.values());
  const of = waiting.length > 1 ? ` (${waiting.findIndex((x) => x.id === w.id) + 1} of ${waiting.length})` : '';
  nextToast = toast(`${w.status === 'needs_input' ? `🙋 ${w.name} needs input` : `✅ ${w.name} is done`}${of}. E opens its terminal`);
}

/** The waiting worker you're standing at, if any: N skips it while anyone else is waiting. */
function waitingBeside(): string | undefined {
  let best: string | undefined;
  let bestD = 2.5;
  for (const w of store.workers.values()) {
    const v = workerViews.get(w.id);
    if (!v || !waitingOnSomeone(w)) continue;
    const d = v.model.root.getWorldPosition(workerPos).distanceTo(player.pos);
    if (d < bestD) {
      bestD = d;
      best = w.id;
    }
  }
  return best;
}

function renderWaiting() {
  const waiting = waitingInOrder(store.workers.values());
  const el = $('waiting');
  el.classList.toggle('hidden', !waiting.length);
  el.classList.toggle(
    'all-done',
    waiting.every((w) => w.status === 'done'),
  );
  if (waiting.length) el.replaceChildren(h('span', {}, waitingLabel(waiting)), h('span.key', {}, 'N'));
}
$('waiting').addEventListener('click', () => goToNextWaiting());

const bearings: Bearing[] = [];
const heads: THREE.Vector3[] = [];
/** Arrows to the waiting workers you can't see from where you're looking. */
function pointToWaiting(now: number) {
  bearings.length = 0;
  if (!trip && !modalOpen()) {
    for (const w of store.workers.values()) {
      const v = workerViews.get(w.id);
      if (!v || !waitingOnSomeone(w)) continue;
      const at = v.model.root.getWorldPosition((heads[bearings.length] ??= new THREE.Vector3()));
      at.y += 1.2;
      bearings.push({ id: w.id, name: w.name, status: w.status, at });
    }
  }
  compass.update(camera, bearings, now);
}

/** Opening a sleeping worker's terminal wakes it, so there's nothing to press first. */
function openWorkerTerminal(id: string, find?: TerminalFind) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.guest) return openTerminal(net, id, undefined, find);
  if (w.cloud) return openCloudWindow(net, id);
  if (w.lost) return fixLostWorktree(w);
  if (isAsleep(w.status)) resumeWorker(w);
  openTerminal(net, id, () => openWorkerChanges(id), find);
}
onOpenTeammate((id) => openWorkerTerminal(id));
onBringIn((id) => {
  const w = store.workers.get(id);
  if (w) bringInGuest(w);
});

/** 🔎 every terminal; a terminal line opens that terminal right at it. */
function showSearch() {
  openSearch(openWorkerTerminal);
}

/** What the worker changed: changed files, diff, commit / discard / open a PR; `repo` for another floor's repository it works in. */
function openWorkerChanges(id: string, repo?: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.guest) return toast(guestKeyNote(w, 'C'), 'warn');
  if (w.cloud) return toast(cloudKeyNote(w), 'warn');
  if (w.lost) return fixLostWorktree(w);
  openChanges(net, id, () => openWorkerTerminal(id), repo);
}

function showQueue() {
  openQueue(net, { openTerminal: openWorkerTerminal });
}

// ---- The command palette (Ctrl+K, ⌘K on a Mac) ------------------------------------------------------
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Where you stand to use something of this kind on this floor, like the Issues board. */
function spotOf(kind: InteractKind): Interactable | undefined {
  return office.interactables.find((it) => it.kind === kind && !it.off);
}

/** Where you stand at a desk: behind the worker, or in front of a kiosk. Meeting chairs are the chair itself. */
function deskSpot(desk: DeskDef): { x: number; z: number } | undefined {
  if (desk.room) return office.interactables.find((it) => it.deskId === desk.id);
  return deskSeat(desk, desk.station ? -1.6 : desk.beanbag ? 1.6 : 2.4);
}

/** The free desk nearest you, for hiring from the palette. A bean bag counts once it's out. */
function nearestFreeDesk(): DeskDef | undefined {
  let best: DeskDef | undefined;
  let bestD = Infinity;
  for (const d of [...DESKS, ...BEANBAGS]) {
    if (d.station || d.room || store.workerAtDesk(d.id)) continue;
    if (d.beanbag && office.interactables.find((it) => it.deskId === d.id)?.off !== false) continue;
    const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z);
    if (dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

/** An entry that walks you over to `kind`'s spot (Shift+Enter) before doing what Enter does. */
function atSpot(kind: InteractKind, what: string, entry: Omit<PaletteEntry, 'walk'>): PaletteEntry {
  const it = spotOf(kind);
  return { ...entry, walk: it ? () => walkThen(it, what, entry.open) : undefined };
}

/** Everything the palette finds, in the order it lists them before you type. */
function paletteEntries(): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const w of store.workers.values()) {
    const desk = DESK_BY_ID.get(w.deskId);
    const spot = desk && deskSpot(desk);
    const open = () => openWorkerTerminal(w.id);
    out.push({
      icon: desk?.station ? STATION_INFO[desk.station].icon : w.kind === 'shell' ? '🐚' : w.cloud ? '☁️' : '🧑‍💻',
      kind: 'Worker',
      title: w.name,
      detail: [w.task?.name, desk?.label, statusWord(w, STATUS_LABEL), w.guest && 'outside the office', w.cloud && cloudBadge(w.cloud)].filter(Boolean).join(' · '),
      keywords: [w.title, w.worktree?.branch],
      open,
      walk: desk && spot ? () => walkThen(spot, `${w.name} at ${desk.label}`, open, desk) : undefined,
    });
  }

  const free = nearestFreeDesk();
  const hireSpot = free && deskSpot(free);
  const hireAt = (d: DeskDef) => () => hireAtDesk(d.id);
  out.push({
    icon: '✨',
    kind: 'Action',
    title: 'Hire a worker',
    detail: free ? `At ${free.label}, the free desk nearest you` : 'Every desk is taken',
    keywords: ['new worker', 'spawn an agent'],
    open: free ? hireAt(free) : () => toast('Every desk on this floor is taken', 'warn'),
    walk: free && hireSpot ? () => walkThen(hireSpot, free.label, hireAt(free), free) : undefined,
  });
  out.push(atSpot('queue', 'the task queue', { icon: '📋', kind: 'Action', title: 'Open the task queue', detail: 'Issues and tasks waiting for a worker', keywords: ['backlog', 'tasks'], open: showQueue }));
  out.push({ icon: '⚙️', kind: 'Action', title: 'Settings', keywords: ['preferences', 'options'], open: () => showSettings() });
  out.push({ icon: '📱', kind: 'Action', title: 'Pair a phone', detail: 'Droid Office for Android', keywords: ['android', 'mobile', 'qr code', 'tailscale'], open: () => openPhone() });
  out.push({ icon: '🖼️', kind: 'Action', title: 'Hang a picture', detail: 'On a wall of this floor', keywords: ['decorate', 'frame', 'art'], open: startHanging });
  out.push({ icon: '🔎', kind: 'Action', title: 'Search every terminal', keywords: ['find'], open: showSearch });

  const prWord = words().pr;
  out.push(atSpot('issues', 'the Issues board', { icon: '📌', kind: 'Board', title: 'Issues board', open: () => openBoard('issues', net, boardActions()) }));
  out.push(atSpot('pulls', `the ${prWord} board`, { icon: '🔀', kind: 'Board', title: `${prWord} board`, keywords: ['pull requests', 'merge requests'], open: () => openBoard('pulls', net, boardActions()) }));
  out.push(atSpot('services', 'the Services board', { icon: '🌐', kind: 'Board', title: 'Services board', detail: 'Web servers the workers are running', open: () => openServices() }));
  out.push(
    atSpot('ci', 'the CI automations board', {
      icon: '🏭',
      kind: 'Board',
      title: 'CI automations',
      detail: 'Droid in GitHub Actions, from Factory',
      keywords: ['factory', 'github actions', 'workflows', 'code review'],
      open: () => showCi(),
    }),
  );
  out.push(
    atSpot('ci', 'the CI automations board', {
      icon: '🤖',
      kind: 'Action',
      title: 'Add Droid code review to a repository',
      detail: 'Factory opens a pull request with the workflow',
      keywords: ['factory', 'ci', 'github actions', 'workflow'],
      open: () => showCi(true),
    }),
  );
  out.push(
    atSpot('computers', 'the compute wall', {
      icon: '🖥️',
      kind: 'Board',
      title: 'Computers',
      detail: 'This machine and your Factory Droid Computers',
      keywords: ['droid computers', 'factory', 'cloud', 'machine', 'cpu'],
      open: () => showComputers(),
    }),
  );
  for (const c of store.factory.computers.items) out.push(atSpot('computers', 'the compute wall', { icon: '🖥️', kind: 'Droid Computer', title: c.name, detail: c.managed ? c.providerType : 'BYOM', open: () => showComputers(c.id) }));
  out.push(atSpot('meeting', 'the meeting room', { icon: '🤝', kind: 'Board', title: 'Meeting room', keywords: ['call a meeting'], open: () => showMeeting() }));

  for (const pr of store.pulls.items) {
    out.push(
      atSpot('pulls', `the ${prWord} board`, {
        icon: '🔀',
        kind: prWord,
        title: `#${pr.number} ${pr.title}`,
        detail: [pr.isDraft ? 'Draft' : pr.state.toLowerCase(), pr.headRefName, pr.author].join(' · '),
        open: () => openPull(pr, net, boardActions()),
      }),
    );
  }
  for (const issue of store.issues.items) {
    out.push(
      atSpot('issues', 'the Issues board', {
        icon: '📌',
        kind: 'Issue',
        title: `#${issue.number} ${issue.title}`,
        detail: [issue.state.toLowerCase(), ...issue.labels.map((l) => l.name), issue.author].join(' · '),
        open: () => openIssue(issue, net, boardActions()),
      }),
    );
  }
  for (const svc of store.services.items) {
    const board = spotOf('services');
    out.push({
      icon: '🌐',
      kind: 'Service',
      title: svc.title || svc.command,
      detail: [`:${svc.port}`, svc.title && svc.command, store.workers.get(svc.workerId)?.name].filter(Boolean).join(' · '),
      keywords: [String(svc.port)],
      open: () => window.open(serviceUrl(svc.port), '_blank', 'noopener'),
      walk: board ? () => walkThen(board, 'the Services board', () => openServices()) : undefined,
    });
  }
  return out;
}

// Ctrl+K (⌘K on a Mac), from anywhere but a text box or a terminal, where the key is theirs.
// In the palette's own box it puts the palette away.
window.addEventListener('keydown', (e) => {
  if (!isPaletteKey(e, IS_MAC)) return;
  const inPalette = paletteOpen() && !!(e.target as HTMLElement | null)?.closest?.('.modal.palette');
  if (!inPalette && isTyping(e)) return;
  e.preventDefault();
  if (!e.repeat) togglePalette(paletteEntries);
});

/** The meeting room's window: how the meeting's going, or the form to call one (prefilled from an issue or a PR). */
function showMeeting(preset?: MeetingPreset) {
  openMeeting(
    net,
    {
      openTerminal: openWorkerTerminal,
      openPr: (id) => {
        const w = store.workers.get(id);
        if (w) pullRequestFor(w);
      },
    },
    preset,
  );
}

function showJukebox() {
  openJukebox(net, () => showSettings('sound'));
}

/** Where a file of the floor's project is on its forge, from the origin remote, or undefined without one. */
function blobBase(): { url: string; site: string } | undefined {
  const repo = normalizeRepo(store.project?.remote);
  if (!repo) return undefined;
  const forge = forgeOf(repo);
  return { url: `${repoWebUrl(repo)}${forge === 'gitlab' ? '/-' : ''}/blob/HEAD`, site: forgeWords(forge).site };
}

function showBookshelf() {
  if (!store.floor) return toast('Take the elevator to a floor first');
  openBookshelf({ floor: store.floor, project: store.project?.name, blob: blobBase(), onTurn: turnPage });
}

/** When a page last rustled, so a quick scroll through a doc isn't one long rustle. */
let rustledAt = 0;
/** You turned a page on the bookshelf: so does the book in your hands, for everyone watching it too. */
function turnPage() {
  me.turnPage();
  hands.turnPage();
  const now = performance.now();
  if (now - rustledAt > 400) sound.paper();
  rustledAt = now;
}

/** A prompt from the boards goes to a new worker at a free desk, or to one already at a desk. */
function sendToWorker(title: string, text: { context?: string; initial?: string }) {
  const desk = freeDesk();
  const awake = [...store.workers.values()].filter((w) => (w.kind === 'agent' || (w.kind === 'cloud' && !w.cloud?.error)) && !w.guest && !isAsleep(w.status));
  if (!desk && !awake.length) {
    toast('Every desk and bean bag is taken — send a worker home first', 'warn');
    return;
  }
  openAsk({
    title,
    ...text,
    newDesk: desk ? DESK_BY_ID.get(desk)!.label : undefined,
    workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status })),
    worktreeOption: !!store.project?.branch,
    modelOption: true,
    repoOptions: repoChoices(),
    onSubmit: (prompt, to, worktree, model, effort, repos, images) => {
      if (to) net.send({ t: 'worker.prompt', workerId: to, prompt, images: images?.length ? images : undefined });
      else if (desk) hire(desk, prompt, worktree, model, effort, undefined, repos, images);
    },
  });
}

function boardActions() {
  return {
    queue: (prompt: string, title: string, issue: number, model?: string, effort?: AgentEffort) => net.send({ t: 'queue.add', prompt, title, issue, model, effort }),
    assign: (prompt: string, title: string) => sendToWorker(`🤖 ${title}`, { initial: prompt }),
    ask: (context: string, title: string) => sendToWorker(`✍️ ${title}`, { context }),
    meeting: (preset: MeetingPreset) => showMeeting(preset),
    goToDesk,
    pickUp,
  };
}

/** `note` is the issue note you're pointing at on the issues board, if any (see aimedNote); `spot` the tab or Jira card (see aimedSpot). */
function interact(target: Interactable | null, key: DeskKey, note = aimedNote, spot = aimedSpot) {
  if (!target) return;
  if ((target.kind === 'desk' || target.kind === 'station') && target.deskId) {
    const w = store.workerAtDesk(target.deskId);
    if (w?.downedUntil !== undefined) {
      if (key === 'E' && !reviveNearby()) hintToast(`Walk closer to ${w.name}'s body to revive`, 'info');
      return;
    }
  }
  if (target.kind !== 'issues') {
    note = null;
    spot = null;
  }
  if (key === 'E' && carrying && dropCard(target, carrying, note)) return;
  if (useSpot(spot, key)) return;
  if (target.kind === 'desk' && target.deskId) {
    const w = store.workerAtDesk(target.deskId);
    // Nobody is hired at the meeting table: a meeting seats its own workers there.
    if (!w && DESK_BY_ID.get(target.deskId)?.room) return key === 'E' ? showMeeting() : undefined;
    if (key === 'B' && !w) return openShell(target.deskId);
    // A guest runs outside the office: there's only what the office knows of it to look at, or bringing it in.
    if (w?.guest && key === 'R') return bringInGuest(w);
    if (w?.guest && key !== 'E') return toast(guestKeyNote(w, key), 'warn');
    if (key === 'P') return promptAtDesk(target.deskId);
    if (key === 'E') return w ? openWorkerTerminal(w.id) : hireAtDesk(target.deskId);
    if (key === 'C' && w) return openWorkerChanges(w.id);
    if (key === 'R' && w && isAsleep(w.status)) return resumeWorker(w);
    if (key === 'X' && w) return killWorker(w.id);
    if (key === 'O' && w) return pullRequestFor(w);
    return;
  }
  if (target.kind === 'station' && target.deskId) {
    const w = store.workerAtDesk(target.deskId);
    if (key === 'E' || key === 'P') return askStation(target.deskId);
    if (key === 'O' && w) return openWorkerTerminal(w.id);
    if (key === 'X' && w) return killWorker(w.id);
    return;
  }
  // A note on the issues board: E takes it straight off the cork, O opens it to read first.
  if (note && key === 'E') return pickUp(note);
  if (note && key === 'O') return openIssue(note, net, boardActions());
  if (key !== 'E') return;
  if (target.kind === 'elevator') showElevator();
  else if (target.kind === 'issues') openBoard('issues', net, boardActions(), issuesTex.tab);
  else if (target.kind === 'pulls') openBoard('pulls', net, boardActions());
  else if (target.kind === 'services') openServices();
  else if (target.kind === 'computers') showComputers();
  else if (target.kind === 'queue') showQueue();
  else if (target.kind === 'ci') showCi();
  else if (target.kind === 'jukebox') showJukebox();
  else if (target.kind === 'bookshelf') showBookshelf();
  else if (target.kind === 'decor' && target.decorId) hanger.view(target.decorId);
  else if (target.kind === 'seat' && target.seatId) useSeat(target.seatId);
  else if (target.kind === 'coffee') drinkCoffee();
  else if (target.kind === 'smoke') {
    if (smokeBreakUntil) {
      setSmoking(false);
      toast('You stub it out in the ashtray');
    } else {
      setSmoking(true);
      toast('🚬 Smoke break');
    }
  } else if (target.kind === 'gong') hitGong();
  else if (target.kind === 'cabinet') cabinet.play();
  else if (target.kind === 'ladder') grabLadder();
  else if (target.kind === 'pole' && target.pole !== undefined) usePole(target.pole);
  else if (target.kind === 'meeting') showMeeting();
  else if (target.kind === 'bar') showBar();
  else if (target.kind === 'dj') blowHorn();
  else if (target.kind === 'golf') teeOff();
}

// ---- The rooftop bar ---------------------------------------------------------------------------------
/** What the bartender says as they slide it over. */
const CHEERS: Record<string, string> = {
  beer: 'Cheers! 🍻',
  wine: 'Salud!',
  martini: 'Shaken, not stirred',
  maitai: 'Aloha!',
  shot: 'Salt, shot, lime… whoa',
  mojito: 'Fresh and minty',
  water: 'Good call. Stay hydrated',
};

/** E at the bar: the menu. */
function showBar() {
  openBar({ cutOff: booze.cutOff(performance.now() / 1000), order: orderDrink });
}

/** The bartender comes over and pours it (a water, if you've had enough), and slides it across to you. */
function orderDrink(d: Drink) {
  const r = roof;
  if (!r || !upTop) return;
  const cut = d.strength > 0 && booze.cutOff(performance.now() / 1000);
  const drink = cut ? DRINK_BY_ID.get('water')! : d;
  r.serve(player.pos.z);
  sound.pour(r.pourAt);
  if (cut) toast("🙅 The bartender slides you a water instead: you've had enough", 'warn');
  setTimeout(() => {
    if (!upTop) return;
    booze.drink(drink, performance.now() / 1000);
    reach();
    if (player.view === 'first') hands.sip();
    if (!cut) toast(`${drink.emoji} ${drink.name}. ${CHEERS[drink.id] ?? 'Enjoy!'}`);
  }, 1500);
}

let lastHorn = 0;
/** E at the DJ booth: the air horn, for everyone on the roof. */
function blowHorn() {
  const now = performance.now();
  if (now - lastHorn < 1500) return;
  lastHorn = now;
  net.send({ t: 'horn' });
}

/** How it's going to your head, the last time it changed, and when the next hiccup comes. */
let feeling: Feeling = 0;
let nextHiccup = 0;
let nextSip = 0;
const FEELINGS = ['😌 You feel sober again', '🥴 You’re feeling a little tipsy', '🌀 Whoa… is the city spinning?', '🤪 You’re wasted. Maybe have some water'];

/** Every frame: how drunk you are, the glass in your hand, hiccups and the odd sip. */
function drinking(now: number) {
  const secs = now / 1000;
  const amount = booze.amount(secs);
  player.drunk = reduceMotion.matches ? 0 : Math.min(1.3, amount);
  const glass = booze.holding(secs);
  me.holdDrink(glass);
  hands.holdDrink(glass);
  if (glass && player.view === 'first' && now > nextSip) {
    if (nextSip) hands.sip();
    nextSip = now + 9000 + Math.random() * 9000;
  }
  const stage = booze.stage(secs);
  if (stage !== feeling) {
    if (stage > feeling || stage === 0) toast(FEELINGS[stage], stage >= 3 ? 'warn' : 'info');
    feeling = stage;
  }
  if (amount > 0.5 && now > nextHiccup) {
    if (nextHiccup) {
      sound.hiccup();
      if (!reduceMotion.matches) thud = Math.max(thud, 0.25);
    }
    nextHiccup = now + 5000 + Math.random() * 12000;
  }
  return amount;
}

/** A cup from the kitchen machine: a minute of quicker feet and higher jumps, and a mug in your hand. */
function drinkCoffee() {
  const jittery = caffeine.drink(performance.now() / 1000);
  sound.coffee();
  if (player.view === 'first') hands.sip();
  if (jittery) toast('☕ One cup too many… you’ve got the jitters!', 'warn');
  else if (caffeine.cups > 1) toast('☕ Another cup: back to a full minute of buzz');
  else toast('☕ Fresh coffee! A minute of quicker feet and higher jumps');
}

// ---- Smoke breaks ------------------------------------------------------------------------------------
/** When your smoke break ends by itself (performance.now()), or 0 when you're not on one. */
let smokeBreakUntil = 0;
const SMOKE_BREAK_MS = 90_000;

function setSmoking(on: boolean) {
  if (on === smokeBreakUntil > 0) return;
  smokeBreakUntil = on ? performance.now() + SMOKE_BREAK_MS : 0;
  me.setSmoking(on);
  hands.setSmoking(on);
}

/** Out on the balcony (a little slack at the door), where smoking is allowed. */
function onBalcony(): boolean {
  const p = player.pos;
  return p.y > -0.5 && p.y < 2 && p.x > BALCONY.minX - 0.5 && p.x < BALCONY.maxX + 0.5 && p.z > BALCONY.minZ - 0.8 && p.z < BALCONY.maxZ + 0.5;
}

/** Ends the break when the cigarette burns down, or when you take it back inside. */
function checkSmokeBreak(now: number) {
  if (!smokeBreakUntil) return;
  if (!onBalcony()) {
    setSmoking(false);
    toast('🚭 No smoking inside, so you put it out');
  } else if (now > smokeBreakUntil) {
    setSmoking(false);
    toast("That one's done. Back to work!");
  }
}

// ---- Carrying an issue card ------------------------------------------------------------------------
function setCarrying(card: CarriedIssue | null) {
  if ((card?.issue ?? 0) === (carrying?.issue ?? 0)) return;
  if (card) holsterGun(true);
  carrying = card;
  me.carry(card);
  hands.carry(card);
  renderIssuesBoard();
  hintKey = '';
}

/** ✋ in an issue's window, or E at its note on the board: its card comes off the board and into your hands. */
function pickUp(it: GhIssue) {
  closeAllModals();
  if (carrying?.issue === it.number) return;
  if (carrying) toast(`📌 #${carrying.issue} went back on the board`);
  setCarrying({ issue: it.number, title: it.title });
  sound.paper();
  toast(`✋ You took #${it.number} off the board: take it to an empty desk, a worker or the 📋 queue and press E`);
}

/** Q, or E at the issues board: the card goes back where it came from. */
function putBack() {
  if (!carrying) return;
  toast(`📌 #${carrying.issue} is back on the board`);
  setCarrying(null);
  sound.paper();
}

/**
 * E with a card in your hands: an empty desk hires a worker for the issue (with the prompt 🤖 Hand
 * to a worker uses), an agent at a desk gets it as its next prompt, the queue board queues it, and
 * the issues board takes it back (or swaps it for the `note` you point at there). False when it's none
 * of those, so E does what it always does there.
 */
function dropCard(it: Interactable, card: CarriedIssue, note: GhIssue | null): boolean {
  if (it.kind === 'issues') {
    if (note) pickUp(note);
    else putBack();
    return true;
  }
  const prompt = issuePrompt({ number: card.issue, title: card.title });
  if (it.kind === 'queue') {
    if (onQueue(card.issue)) toast(`#${card.issue} is already on the queue`, 'warn');
    else {
      const { model, effort } = rememberedChoice('queue');
      net.send({ t: 'queue.add', prompt, title: `#${card.issue} ${card.title}`, issue: card.issue, model, effort });
      putDown();
    }
    return true;
  }
  // At the meeting room: a meeting about it, and the card goes back up on the board.
  if (it.kind === 'meeting' || (it.kind === 'desk' && it.deskId && DESK_BY_ID.get(it.deskId)?.room && !store.workerAtDesk(it.deskId))) {
    putBack();
    showMeeting(issueMeeting(card.issue, card.title));
    return true;
  }
  if (it.kind !== 'desk' || !it.deskId) return false;
  const w = store.workerAtDesk(it.deskId);
  const why = w ? cantTakeCard(w) : '';
  if (why) toast(why, 'warn');
  else if (w) {
    net.send({ t: 'worker.prompt', workerId: w.id, prompt, issue: card.issue });
    putDown();
  } else if (!officeIsFull()) {
    const { model, effort } = rememberedChoice(`desk:${it.deskId}`);
    hire(it.deskId, prompt, !!store.project?.branch && worktreePref(), model, effort, card.issue);
    putDown();
  }
  return true;
}

/** The card left your hands for a desk or the queue (the office says who took it). */
function putDown() {
  setCarrying(null);
  sound.paper();
}

function onQueue(issue: number): boolean {
  const t = store.taskForIssue(issue);
  return !!t && t.status !== 'done';
}

/** Why the worker at a desk can't be handed an issue card right now, or '' when it can. */
function cantTakeCard(w: WorkerInfo): string {
  if (w.downedUntil !== undefined) return `Walk up to ${w.name}'s body and press E to revive first`;
  if (w.kind === 'shell') return `${w.name} is a shell, not an agent`;
  if (w.guest) return guestKeyNote(w, 'P');
  if (w.lost) return `${w.name}'s worktree was deleted — press E at its desk to fix it`;
  if (isAsleep(w.status)) return `${w.name} is asleep — press R to resume first`;
  if (w.status === 'needs_input') return `${w.name} is waiting on an answer — open the terminal first`;
  return '';
}

// ---- Sitting ----------------------------------------------------------------------------------------
/** The free place on a seat nearest you. */
function freePlace(seat: SeatDef): SeatPlace | null {
  let best: SeatPlace | null = null;
  let bestD = Infinity;
  for (let i = 0; i < seat.places.length; i++) {
    const place = seatPlace(seat, i);
    const d = Math.hypot(place.x - player.pos.x, place.z - player.pos.z);
    if (d < bestD) {
      best = place;
      bestD = d;
    }
  }
  return best;
}

/** E at a seat: sit down on it. Sitting there already, get up (or play, or order, where the seat offers it). */
function useSeat(seatId: string) {
  const seat = SEATING_BY_ID.get(seatId);
  if (!seat) return;
  if (player.seat?.seatId === seatId) {
    if (seat.game) arcade.play();
    else if (seat.bar) showBar();
    else standUp();
    return;
  }
  sitOn(seatId);
}

/** Sits down on a free place on a seat. */
function sitOn(seatId: string): boolean {
  const seat = SEATING_BY_ID.get(seatId);
  if (!seat) return false;
  const place = freePlace(seat);
  if (!place) {
    toast(`No room on that ${seat.label.replace(/^\S+ /, '').toLowerCase()} right now`, 'warn');
    return false;
  }
  player.sit(place);
  me.sit(place.hips);
  return true;
}

function standUp() {
  player.stand();
  gotUp();
}

/** On your feet again, by E or by walking off. */
function gotUp() {
  me.sit(null);
}
player.onStand = gotUp;

/** What you're sitting on, so it's what E is about unless you're looking at something else. */
function mySeat(): Interactable | null {
  const id = player.seat?.seatId;
  return (id && usable()[0].find((it) => it.kind === 'seat' && it.seatId === id)) || null;
}

// ---- The gong -------------------------------------------------------------------------------------
let lastHit = 0;
/** E at the gong. The office rings it for everyone on the floor, you included (see gongRang). */
function hitGong() {
  const now = performance.now();
  if (now - lastHit < 500) return;
  lastHit = now;
  net.send({ t: 'gong' });
}

/** Where confetti comes from over a desk: above the worker's head. */
function burstOver(deskId: string, n: number) {
  const d = DESK_BY_ID.get(deskId);
  if (d) confetti.burst(d.x, 2.3, d.z, n);
}

/** Where a worker at `desk` climbs up to dance, in the frame of whatever it sits or stands in. */
function stageOf(desk: DeskView, model: Worker): Stage {
  const seat = model.root.parent!;
  seat.updateWorldMatrix(true, false);
  desk.stage.updateWorldMatrix(true, false);
  const m = seat.matrixWorld.clone().invert().multiply(desk.stage.matrixWorld);
  const pos = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  m.decompose(pos, turn, new THREE.Vector3());
  const ahead = new THREE.Vector3(0, 0, 1).applyQuaternion(turn);
  return { pos, yaw: Math.atan2(ahead.x, ahead.z) };
}

/** A pull request merged: every worker awake on the floor gets up on its desk and dances. */
function danceParty() {
  for (const [id, v] of workerViews) {
    const desk = office.desks.get(v.deskId);
    if (desk && !isAsleep(store.workers.get(id)?.status ?? 'offline')) v.model.dance(stageOf(desk, v.model));
  }
  // The board agents still waiting to be asked, too.
  for (const a of idleAgents) if (a.view.vacancy.visible) a.model.dance(stageOf(a.view, a.model));
}

/** Where confetti rains from downstairs over (x, z): the ceiling, or under the loft, the underside of its floor. */
function ceilingOver(x: number, z: number): number {
  const loft = x > LOFT.minX && x < LOFT.maxX && z > LOFT.minZ && z < LOFT.maxZ;
  return loft ? LOFT.y - 0.35 : WALL_HEIGHT - 0.1;
}
/** Confetti a square meter of floor gets when a pull request merges. */
const CONFETTI_DENSITY = 3.5;
const floorArea = (a: Area) => (a.maxX - a.minX) * (a.maxZ - a.minZ);

/** Someone hit the gong, a pull request merged (a dance party under a confetti rain), or the queue emptied (a party). */
function gongRang(why: GongWhy, pr?: number) {
  office.gong.strike(why === 'hit' ? 0.7 : 1);
  sound.gong(why);
  const top = office.gong.top;
  if (why === 'merged') {
    // Confetti rains down all over the floor, and pops over the desk the PR came from while its worker's still there.
    confetti.rain(FLOOR, floorArea(FLOOR) * CONFETTI_DENSITY, 3, ceilingOver);
    confetti.rain(LOFT, floorArea(LOFT) * CONFETTI_DENSITY, 3, () => LOFT.y + LOFT.height - 0.1);
    const it = store.pulls.items.find((p) => p.number === pr);
    const w = pr === undefined ? undefined : workerForPull(store.workers.values(), it ?? { number: pr, headRefName: '' });
    if (w && workerViews.has(w.id)) burstOver(w.deskId, 220);
    else confetti.burst(top.x, top.y, top.z, 220);
    danceParty();
  } else if (why === 'queue') {
    // Three strokes (sound.gong plays them): a burst at the gong, then every desk, then a cannon.
    confetti.burst(top.x, top.y, top.z, 160);
    setTimeout(() => {
      office.gong.strike(0.85);
      for (const [id, v] of workerViews) {
        burstOver(v.deskId, 120);
        if (!isAsleep(store.workers.get(id)?.status ?? 'offline')) v.model.cheer(4);
      }
    }, 850);
    setTimeout(() => {
      office.gong.strike(1.2);
      confetti.burst(top.x, top.y, top.z, 450, 1.5);
    }, 1700);
  }
}

// ---- Interaction targeting & hint -----------------------------------------------------------------
let target: Interactable | null = null;
let hintKey = '';

function pickTarget(): Interactable | null {
  // Everything you can use is upstairs; down on the street you're under it all.
  if (player.pos.y < -SLAB - 1) return null;
  let best: Interactable | null = null;
  let bestD = Infinity;
  for (const list of usable()) {
    for (const it of list) {
      if (it.off) continue;
      // Up on the loft, or down underneath it.
      if (Math.abs((it.y ?? 0) - player.pos.y) > 1.5) continue;
      const d = Math.hypot(it.x - player.pos.x, it.z - player.pos.z);
      if (d < it.radius && d < bestD) {
        best = it;
        bestD = d;
      }
    }
  }
  return best;
}

function key(k: string, label: string) {
  return h('span', {}, h('span.key', {}, k), label);
}

/** Secondary text in the hint bar. */
function aside(text: string) {
  return h('span', { style: 'opacity:.75;font-weight:600' }, text);
}

interface Hint {
  /** Changes whenever the hint needs redrawing. */
  k: string;
  parts: (HTMLElement | string)[];
}

function renderHint() {
  const el = $('hint');
  if (hanger.active && !modalOpen()) return renderHangHint(el);
  if (climber.active && !modalOpen()) return renderClimbHint(el);
  if (golf.active && !modalOpen()) return renderGolfHint(el);
  const casualty = !modalOpen() && nearbyCasualty();
  if (casualty) {
    const hint = casualtyHint(casualty, true);
    if (hint.k !== hintKey) {
      hintKey = hint.k;
      el.replaceChildren(...hint.parts);
      el.classList.remove('hidden');
    }
    return;
  }
  if (gunOut && !modalOpen()) return renderGunHint(el);
  if ((!target && !carrying) || modalOpen()) {
    // Still up after a redraw was asked for (hintKey cleared) just as you walked away from it, too.
    if (hintKey || !el.classList.contains('hidden')) {
      el.classList.add('hidden');
      hintKey = '';
    }
    return;
  }
  const hint = carrying ? carryHint(carrying, target) : hintFor(target!);
  const k = `${target?.kind}${target?.deskId ?? ''}|${carrying?.issue ?? ''}|${hint.k}`;
  if (k === hintKey) return;
  hintKey = k;
  el.replaceChildren(...hint.parts);
  el.classList.remove('hidden');
}

/** What the hint bar says about the thing you're facing. */
function hintFor(it: Interactable): Hint {
  const title = (text: string) => h('span.title', {}, text);
  const board = (name: string): Hint => ({ k: '', parts: [title(name), key('E', 'Open')] });
  switch (it.kind) {
    case 'desk':
      return it.deskId ? deskHint(it.deskId) : { k: '', parts: [] };
    case 'station':
      return it.deskId ? stationHint(it.deskId) : { k: '', parts: [] };
    case 'issues':
      if (aimedSpot?.kind === 'tab') {
        const label = aimedSpot.tab === 'jira' ? `🎫 Jira · ${store.jiraBoard?.epic ?? 'epic'}` : `📌 ${words().site} issues`;
        return { k: `tab:${aimedSpot.tab}:${issuesTex.tab}`, parts: issuesTex.tab === aimedSpot.tab ? [title(label), aside('showing')] : [title(label), key('E', 'Show it')] };
      }
      if (aimedSpot?.kind === 'ticket') {
        const ticketKey = aimedSpot.key;
        const t = store.jiraBoard?.items.find((x) => x.key === ticketKey);
        return { k: `ticket:${ticketKey}`, parts: [title(clip(`🎫 ${ticketKey} ${t?.summary ?? ''}`, 60)), key('E', 'Read it')] };
      }
      if (issuesTex.tab === 'jira') return board(`🎫 Jira · ${store.jiraBoard?.epic ?? 'epic'}`);
      if (aimedNote) return { k: String(aimedNote.number), parts: [title(clip(`📌 #${aimedNote.number} ${aimedNote.title}`, 60)), key('E', 'Take it'), key('O', 'Read it')] };
      return issuesTex.hasNotes ? { k: 'notes', parts: [title('📌 Issues board'), key('E', 'Open'), aside('or point at a note to take it')] } : board('📌 Issues board');
    case 'pulls':
      return board('🔀 Pull request board');
    case 'services':
      return board('🌐 Services board');
    case 'ci': {
      const ci = store.factory.ci;
      const n = ci.workflows.length;
      const about = !store.factory.connection.connected ? 'connect Factory first' : n ? `${n} Droid workflow${n === 1 ? '' : 's'}` : ci.fetchedAt ? 'no Droid workflows yet' : '';
      return { k: about, parts: [title('🏭 CI automations'), about ? aside(about) : '', key('E', 'Open')] };
    }
    case 'computers': {
      const about = computeWall.view ? wallSummary(computeWall.view) : '';
      return { k: about, parts: [title('🖥️ Compute wall'), aside(about), key('E', 'Open the Computers')] };
    }
    case 'queue': {
      const n = store.queue.tasks.filter((t) => t.status !== 'done').length;
      return { k: String(n), parts: [title(`📋 Task queue${n ? ` · ${n}` : ''}`), key('E', 'Open')] };
    }
    case 'tv':
      return { k: '', parts: [title('📺 Office TV'), aside('standby')] };
    case 'coffee': {
      const buzzed = caffeine.buzzed(performance.now() / 1000);
      return { k: String(buzzed), parts: [title('☕ Coffee machine'), key('E', buzzed ? 'Another cup' : 'Grab a cup')] };
    }
    case 'smoke':
      return { k: String(smokeBreakUntil > 0), parts: [title('🚬 Ashtray'), key('E', smokeBreakUntil ? 'Stub it out' : 'Take a smoke break')] };
    case 'gong':
      return { k: '', parts: [title('🎉 Merge gong'), aside('rings when a PR merges'), key('E', 'Bang it')] };
    case 'golf': {
      const { best, holes } = golfRecord();
      const about = [holes ? `${holes} hole${holes === 1 ? '' : 's'} in one` : '', best !== null ? `your best ${pinText(best)} from the pin` : `the pin's ${Math.round(PIN_DISTANCE)} m out`].filter(Boolean).join(' · ');
      return { k: about, parts: [title('Golf tee'), aside(about), key('E', 'Tee off')] };
    }
    case 'jukebox': {
      const j = store.jukebox;
      const what = j.on ? trackTitle(j) : '';
      return { k: `${j.on}|${what}`, parts: [title('🎵 Jukebox'), aside(j.on ? `♪ ${clip(what, 40)}` : 'off'), key('E', j.on ? 'Change the song' : 'Put on a song')] };
    }
    case 'cabinet': {
      const c = store.cabinet;
      const left = cabinet.leftAt;
      const best = c.scores[0];
      const about = left !== null ? `your game's paused at ${scoreText(left)}` : best ? `🏆 ${clip(best.name, 24)} · ${scoreText(best.score)}` : 'no high score yet';
      return { k: `${left}|${best?.name}|${best?.score}`, parts: [title(`🕹️ ${GAME}`), aside(about), key('E', left !== null ? 'Carry on' : 'Play')] };
    }
    case 'bookshelf': {
      return { k: '', parts: [title('📚 Bookshelf'), aside("the project's docs"), key('E', 'Read the docs')] };
    }
    case 'meeting': {
      const m = store.meeting.current;
      const p = m && MEETING_PATTERNS[m.pattern];
      const what = !m || !p ? 'free' : m.status === 'running' ? `${p.icon} ${p.label} · ${meetingStage(m)}` : `${p.icon} ${p.label} ${m.status === 'done' ? 'done ✅' : 'stopped ⛔'}`;
      return { k: what, parts: [title('🤝 Meeting room'), aside(clip(what, 50)), key('E', m?.status === 'running' ? 'See how it’s going' : m ? 'See it / call a meeting' : 'Call a meeting')] };
    }
    case 'elevator': {
      const f = store.currentFloor();
      const n = store.floors.length;
      return { k: `${f?.name}|${n}`, parts: [title('🛗 Elevator'), f ? aside(`${f.name} · ${n} floor${n === 1 ? '' : 's'}`) : '', key('E', n > 1 ? 'Choose a floor' : 'Floors & projects')] };
    }
    case 'decor': {
      const d = store.decor.find((x) => x.id === it.decorId);
      return { k: `${d?.title}|${d?.by}`, parts: [title(`🖼️ ${d?.title || 'A picture'}`), d ? aside(`hung by ${d.by}`) : '', key('E', 'Look closer')] };
    }
    case 'seat': {
      const seat = SEATING_BY_ID.get(it.seatId ?? '');
      if (!seat) return { k: '', parts: [] };
      if (player.seat?.seatId === seat.id) {
        const use = seat.game ? 'Play Minesweeper' : seat.bar ? 'Order a drink' : '';
        return { k: `${seat.id}|sitting`, parts: [title(seat.label), aside('sitting'), ...(use ? [key('E', use), key('W A S D', 'Get up')] : [key('E', 'Get up')])] };
      }
      const full = !freePlace(seat);
      return { k: `${seat.id}|${full}`, parts: [title(seat.label), seat.game ? aside('💣 Minesweeper on the monitor') : '', full ? aside('no room') : key('E', 'Sit down')] };
    }
    case 'ladder': {
      const up = floorThere(1)?.name;
      const down = floorThere(-1)?.name;
      const where = [up && `⬆ ${up}`, down && `⬇ ${down}`].filter(Boolean).join(' · ');
      return { k: where, parts: [title('🪜 Ladder'), aside(where || 'no other floors yet'), key('E', 'Climb on')] };
    }
    case 'pole': {
      if (office.stack.polesGoDown()) {
        const down = floorThere(-1)?.name ?? 'the floor below';
        return { k: `down|${down}`, parts: [title('🚒 Fire pole'), aside(`down to ${down}`), key('E', 'Slide down!')] };
      }
      const up = floorThere(1)?.name ?? 'upstairs';
      return { k: `landing|${up}`, parts: [title('🚒 Fire pole'), aside(`comes down from ${up}`), key('E', 'Twirl')] };
    }
    case 'bar': {
      const cut = booze.cutOff(performance.now() / 1000);
      return { k: String(cut), parts: [title('🍸 Sky Bar'), aside(cut ? "you've had enough" : 'drinks on the house'), key('E', cut ? 'Ask for water' : 'Order a drink')] };
    }
    case 'dj': {
      const f = djFrame(djAt());
      const what = f.part === 'drop' ? '🔥 the drop' : f.part === 'build' ? 'building up…' : f.part === 'breakdown' ? 'the breakdown' : 'mixing in the next track';
      return { k: what, parts: [title('🎧 DJ Merge Conflict'), aside(`drum & bass · ${what}`), key('E', '📯 Air horn!')] };
    }
  }
}

/** With an issue card in your hands: what E does with it here, and how to put it back. */
function carryHint(card: CarriedIssue, it: Interactable | null): Hint {
  const parts = (...mid: (HTMLElement | string)[]) => [h('span.title', {}, `🗂️ #${card.issue} in hand`), ...mid, key('Q', 'Put it back')];
  if (it?.kind === 'issues') return aimedNote ? { k: String(aimedNote.number), parts: parts(key('E', `Swap it for #${aimedNote.number}`)) } : { k: '', parts: parts(key('E', 'Pin it back up')) };
  if (it?.kind === 'queue') {
    const on = onQueue(card.issue);
    return { k: String(on), parts: parts(on ? aside('already on the queue') : key('E', 'Put it on the queue')) };
  }
  if (it?.kind === 'meeting' || (it?.kind === 'desk' && it.deskId && DESK_BY_ID.get(it.deskId)?.room && !store.workerAtDesk(it.deskId))) {
    return { k: 'meeting', parts: parts(key('E', 'Call a meeting about it')) };
  }
  if (it?.kind === 'desk' && it.deskId) {
    const w = store.workerAtDesk(it.deskId);
    if (!w) return { k: '', parts: parts(key('E', 'Hire a worker for it')) };
    const why = cantTakeCard(w);
    return { k: w.id + w.status + why, parts: parts(why ? aside(why) : key('E', `Hand it to ${w.name}`)) };
  }
  // Anything else works as usual, card in hand.
  if (it) {
    const rest = hintFor(it);
    return { k: rest.k, parts: parts(...rest.parts) };
  }
  return { k: '', parts: parts(aside('take it to an empty desk, a worker or the 📋 queue')) };
}

function casualtyHint(w: WorkerInfo, near: boolean): Hint {
  const seconds = Math.max(0, Math.ceil((w.downedUntil! - store.officeNow()) / 1000));
  return {
    k: `downed|${w.id}|${seconds}|${near}`,
    parts: [h('span.title', {}, `🩹 ${w.name} is down`), seconds ? (near ? key('E', 'Revive') : aside('Walk up to the body to revive')) : aside('Medics on their way'), aside(`${seconds}s · then worktree + branch deleted`)],
  };
}

function deskHint(deskId: string): Hint {
  const w = store.workerAtDesk(deskId);
  if (!w && DESK_BY_ID.get(deskId)?.room) return { k: 'room', parts: [h('span.title', {}, `🤝 ${DESK_BY_ID.get(deskId)!.label} · free`), key('E', 'Call a meeting')] };
  if (!w) {
    const m = store.machine;
    const full = officeFull(m);
    return {
      k: `${full}|${m.workers}|${m.limit}|${!!m.pressure}`,
      parts: [
        h('span.title', {}, `${DESK_BY_ID.get(deskId)!.label} · empty`),
        ...(full
          ? [h('span.cost', {}, `🚫 Office full · ${m.workers} of ${m.limit} workers`)]
          : [m.pressure ? h('span.cost', { title: `This machine is under pressure: ${m.pressure}` }, '⚠️ Machine under pressure') : '', key('E', 'Hire a worker'), key('P', 'Hire with a task'), key('B', 'Shell')]),
      ],
    };
  }
  if (w.downedUntil !== undefined) return casualtyHint(w, nearbyCasualty()?.id === w.id);
  if (w.lost && w.worktree) {
    return {
      k: `lost|${w.id}|${w.lost.branch}`,
      parts: [h('span.title', {}, `${w.name} · 🌿 worktree deleted`), aside('deleted outside droid-office'), key('E', 'Fix it'), key('X', 'Send home')],
    };
  }
  if (w.cloud) {
    const doing = w.cloud.error ? `⚠️ ${clip(w.cloud.error, 48)}` : w.activity ? clip(w.activity, 48) : '';
    return {
      k: `cloud|${w.id}|${w.status}|${doing}|${cloudLine(w)}`,
      parts: [h('span.title', {}, `${w.name} · ${statusWord(w, STATUS_LABEL)}`), aside(cloudLine(w)), doing ? aside(doing) : '', key('E', 'Open'), key('P', 'Prompt'), key('X', 'Send home')],
    };
  }
  if (w.guest) {
    const doing = w.activity ? clip(w.activity, 48) : '';
    return {
      k: `guest|${w.id}|${w.status}|${w.guest.seen}|${doing}|${w.guest.cantBringIn ?? ''}`,
      parts: [h('span.title', {}, `${w.name} · ${statusWord(w, STATUS_LABEL)}`), aside(`🚪 outside the office · ${processLabel(w.guest)}`), doing ? aside(doing) : '', key('E', 'Look'), w.guest.cantBringIn ? '' : key('R', 'Bring it in')],
    };
  }
  const doing = w.activity ? clip(w.activity, 48) : '';
  const shell = w.kind === 'shell';
  const team = [teamNote(w), outsideNote(w)].filter(Boolean).join(' · ');
  return {
    k: w.status + w.id + (w.pr?.number ?? '') + (w.repos?.map((r) => r.pr?.number ?? '-').join() ?? '') + (w.prOpening ? '!' : '') + doing + team,
    parts: [
      h('span.title', {}, `${w.name} · ${STATUS_LABEL[w.status]}`),
      team ? aside(team) : '',
      doing ? aside(doing) : '',
      key('E', 'Open terminal'),
      key('C', 'Changes'),
      isAsleep(w.status) ? key('R', shell ? 'Restart' : 'Resume') : key('P', shell ? 'Run command' : 'Prompt'),
      w.repos?.length ? reposKey(w) : w.pr ? key('O', `PR #${w.pr.number}`) : w.prOpening ? aside('⏳ Opening PR…') : prReady(w) ? key('O', 'Open PR') : '',
      key('X', 'Send home'),
    ],
  };
}

/** Why the office doesn't do something of a local worker's to a cloud one: its session isn't on this machine. */
function cloudKeyNote(w: WorkerInfo): string {
  return `${w.name} works on ${w.cloud ? cloudBadge(w.cloud) : 'a Factory computer'}, not in a checkout here: ask it to commit and open the pull request itself`;
}

/** The hint's word on a worker's team: whose subagent it is, or how its own subagents are doing. */
function teamNote(w: WorkerInfo): string {
  const lead = w.lead ? store.workers.get(w.lead) : undefined;
  if (lead) return `🧭 ${lead.name}'s subagent`;
  return teamSummary(store.teamOf(w.id)) ?? '';
}

/** The O in the desk hint of a worker across repositories: its pull requests so far, or opening them. */
function reposKey(w: WorkerInfo) {
  const repos = workerRepos(w);
  const prs = repos.filter((r) => r.pr).length;
  if (w.prOpening) return aside('⏳ Opening PRs…');
  if (prs) return key('O', `${prs} of ${repos.length} PRs`);
  return prReady(w) ? key('O', `Open PRs (${repos.length} repos)`) : '';
}

function stationHint(deskId: string): Hint {
  const kind = DESK_BY_ID.get(deskId)?.station;
  if (!kind) return { k: '', parts: [] };
  const w = store.workerAtDesk(deskId);
  const info = STATION_INFO[kind];
  if (!w) {
    const m = store.machine;
    const full = officeFull(m);
    return {
      k: `${full}|${m.workers}|${m.limit}`,
      parts: [h('span.title', {}, `${info.icon} ${STATION_AGENT[kind].name}`), aside(info.offer.replace(/^Ask me /, '')), full ? h('span.cost', {}, `🚫 Office full · ${m.workers} of ${m.limit} workers`) : key('E', 'Prompt')],
    };
  }
  if (w.downedUntil !== undefined) return casualtyHint(w, nearbyCasualty()?.id === w.id);
  const doing = w.activity ? clip(w.activity, 48) : '';
  const team = teamNote(w);
  return {
    k: w.status + w.id + doing + team,
    parts: [
      h('span.title', {}, `${info.icon} ${w.name} · ${STATUS_LABEL[w.status]}`),
      team ? aside(team) : '',
      doing ? aside(doing) : '',
      key('E', isAsleep(w.status) ? 'Wake with a prompt' : 'Prompt'),
      key('O', 'Terminal'),
      key('X', 'Send home'),
    ],
  };
}

/** The gun out: fire it, or put it back. */
function renderGunHint(el: HTMLElement) {
  const k = 'gun';
  if (k === hintKey) return;
  hintKey = k;
  el.replaceChildren(h('span.title', {}, '🔫 .44 Magnum'), key('Click', 'Fire'), key('7', 'Holster'));
  el.classList.remove('hidden');
}
/** At the golf tee: how to aim and swing, or how to get back to it while the ball's out there. */
function renderGolfHint(el: HTMLElement) {
  const title = (text: string) => h('span.title', {}, text);
  const stage = golf.doing;
  const k = `golf|${stage}`;
  if (k === hintKey) return;
  hintKey = k;
  const parts =
    stage === 'watch'
      ? [title('Fore!'), key('Space', 'Back to the tee'), key('E', 'Done')]
      : stage === 'charge' || stage === 'swing'
        ? [title('Let go to hit it'), aside('the fuller the meter, the further it goes')]
        : [key('Space', 'Hold to swing'), key('A D', 'Aim'), key('W S', 'Loft'), key('E', 'Done')];
  el.replaceChildren(...parts);
  el.classList.remove('hidden');
}

/** On the ladder: which way it goes from here, and how to get off. Down a pole: just hold on. */
function renderClimbHint(el: HTMLElement) {
  const title = (text: string) => h('span.title', {}, text);
  const l = climber.ladder;
  let k: string;
  let parts: (HTMLElement | string)[];
  if (l) {
    const up = floorThere(1)?.name;
    const down = floorThere(-1)?.name;
    const atFloor = l.y < 0.4 && l.y > -0.05;
    const busy = l.waiting || l.auto;
    k = `ladder|${up}|${down}|${atFloor}|${busy}`;
    parts = busy ? [title('🪜 Climbing…')] : [title('🪜 On the ladder'), up ? key('W', `Up to ${up}`) : aside('top floor'), key('S', down ? `Down to ${down}` : atFloor ? 'Step off' : 'Down'), key('E', atFloor ? 'Step off' : 'Let go')];
  } else {
    const how = climber.sliding;
    k = `pole|${how}`;
    parts = [title(how === 'twirl' ? '🚒 Wheee!' : '🚒 Wheeeeeee!')];
  }
  if (k === hintKey) return;
  hintKey = k;
  el.replaceChildren(...parts);
  el.classList.remove('hidden');
}

function renderHangHint(el: HTMLElement) {
  const spot = hanger.spot;
  const k = `hang|${hanger.moving}|${spot ? spot.ok : '-'}`;
  if (k === hintKey) return;
  hintKey = k;
  const title = !spot ? '🖼️ Aim at a wall' : !spot.ok ? "🚫 Something's in the way" : hanger.moving ? '🖼️ Moving a picture' : '🖼️ Hanging a picture';
  el.replaceChildren(h('span.title', {}, title), key('Click', 'Hang'), key('Scroll', 'Size'), key('Esc', 'Cancel'));
  el.classList.remove('hidden');
}

let crossKey = '';
const finePointer = window.matchMedia('(pointer: fine)').matches;
function renderCrosshair() {
  const show = player.view === 'first' && !modalOpen() && !golf.active;
  const free = show && finePointer && player.canLock && !player.locked;
  const k = `${show}|${!!target}|${free}|${relookOnKey}|${gunOut}`;
  if (k === crossKey) return;
  crossKey = k;
  const el = $('crosshair');
  el.classList.toggle('hidden', !show);
  el.classList.toggle('on', !!target);
  el.classList.toggle('armed', gunOut);
  el.classList.toggle('free', free);
  el.querySelector('.look-hint')!.textContent = relookOnKey ? 'Press a key or click to look around' : 'Click to look around';
}

// ---- Reaching out ---------------------------------------------------------------------------------
/** Plays the reach on your hands and your character. */
function reach() {
  if (player.view === 'first') hands.reach();
  me.reach();
}

// ---- Emotes ---------------------------------------------------------------------------------------
/** One emote at a time, so mashing the keys doesn't stack animations on your character. */
const emoteLimit = new EmoteBucket();
let emoteWarnedAt = 0;
/** Plays an emote on your character and your hands. */
function emote(id: EmoteId) {
  const now = performance.now();
  if (!emoteLimit.take(now)) {
    if (now - emoteWarnedAt > 3000) {
      emoteWarnedAt = now;
      toast('Easy there, one emote at a time', 'warn');
    }
    return;
  }
  me.emote(id);
  hands.emote(id);
  if (player.view === 'first') popEmoji(id);
}
const emoteWheel = new EmoteWheel(emote, (open) => (player.mouseLook = !open));
$('hud').append(emoteWheel.el);

/** In first person you can't see the emoji over your head, so it pops up on the screen instead. */
function popEmoji(id: EmoteId) {
  const e = EMOTE_BY_ID.get(id)!;
  document.querySelector('.emote-pop')?.remove();
  const el = h('div.emote-pop', { style: `--secs:${e.seconds}s`, 'aria-hidden': 'true' }, e.emoji);
  el.addEventListener('animationend', () => el.remove());
  $('hud').append(el);
}

/** G opens the emote wheel (hold it and point, or tap it and click); 1–6 play one straight away. */
function emoteKey(e: KeyboardEvent): boolean {
  if (e.code === 'KeyG') {
    if (!e.repeat) emoteWheel.press();
    return true;
  }
  if (e.code === 'Escape' && emoteWheel.isOpen) {
    emoteWheel.close();
    return true;
  }
  const n = /^(?:Digit|Numpad)([1-6])$/.exec(e.code);
  if (!n) return false;
  emoteWheel.close();
  emote(EMOTES[Number(n[1]) - 1].id);
  return true;
}

/** Keys that use what you're facing: at a desk, each does something else (see interact). */
const DESK_KEYS = { KeyE: 'E', KeyP: 'P', KeyR: 'R', KeyX: 'X', KeyB: 'B', KeyC: 'C', KeyO: 'O' } as const;
type DeskKey = (typeof DESK_KEYS)[keyof typeof DESK_KEYS];

function use(it: Interactable | null, key: DeskKey, note = aimedNote, spot = aimedSpot) {
  if (!it) return;
  reach();
  interact(it, key, note, spot);
}

// ---- Input ----------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (modalOpen() || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (relookOnKey && e.key !== 'Escape' && player.canLock) player.lock();
  if (hanger.active && hangingKey(e.code)) {
    e.preventDefault();
    return;
  }
  // On the ladder, E gets you off it (and nothing else is in reach); W, S and Space climb.
  if (climber.active && (e.code === 'KeyE' || e.code === 'KeyF' || e.code in DESK_KEYS)) {
    if (e.code === 'KeyE') climber.letGo();
    return;
  }
  // At the golf tee, E puts the club back (Space swings, see Golfer); nothing else is in reach, and no emotes mid-swing.
  if (golf.active && (e.code === 'KeyF' || e.code === 'KeyG' || e.code in DESK_KEYS || /^(?:Digit|Numpad)[1-6]$/.test(e.code))) {
    if (e.code === 'KeyE') golf.stop();
    return;
  }
  // A nearby body takes E even with the gun or another object in your hands.
  if (e.code === 'KeyE' && !e.repeat && reviveNearby()) {
    e.preventDefault();
    return;
  }
  // 7 draws and holsters the .44 Magnum (1–6 are emotes).
  if (e.code === 'Digit7' || e.code === 'Numpad7') {
    if (!e.repeat) toggleGun();
    return;
  }
  if (emoteKey(e)) return;
  if (officeKey(e)) player.clearKeys();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyG') emoteWheel.release();
});

/** The office's own keys; false for any other key, which is left to walking and the browser. */
function officeKey(e: KeyboardEvent): boolean {
  const deskKey = DESK_KEYS[e.code as keyof typeof DESK_KEYS];
  if (deskKey) {
    // P opens a text box, which the key mustn't land in.
    if (deskKey === 'P') e.preventDefault();
    use(target, deskKey);
    return true;
  }
  switch (e.code) {
    case 'Tab':
      e.preventDefault();
      hud.toggleMenu();
      return true;
    case 'KeyH':
      openHelp();
      return true;
    case 'KeyF':
      startHanging();
      return true;
    case 'KeyN':
      goToNextWaiting();
      return true;
    case 'KeyQ':
      if (!carrying) return false;
      reach();
      putBack();
      return true;
  }
  // By the character, so it's / on any keyboard layout. The search box opens without it.
  if (e.key === '/') {
    e.preventDefault();
    showSearch();
    return true;
  }
  return false;
}

/** Keys while hanging a picture. Walking works as usual. */
function hangingKey(code: string): boolean {
  switch (code) {
    case 'Escape':
    case 'KeyF':
      hanger.cancel();
      return true;
    case 'KeyE':
    case 'Enter':
      reach();
      hanger.place();
      return true;
    case 'BracketLeft':
    case 'Minus':
      hanger.resize(-1);
      return true;
    case 'BracketRight':
    case 'Equal':
      hanger.resize(1);
      return true;
  }
  return false;
}

/**
 * Set when closing the last window may not have given you the mouse back, so the next key you press
 * takes it instead (a key counts for the browser, where the Esc that closed the window doesn't).
 */
let relookOnKey = false;
/** Whether the last thing you pressed was a mouse button rather than a key (see backToGame). Captured, before a window acts on it. */
let pressedMouse = false;
window.addEventListener('pointerdown', () => (pressedMouse = true), true);
window.addEventListener('keydown', () => (pressedMouse = false), true);
onModalChange((open) => {
  player.enabled = !open;
  player.clearKeys();
  // Reading off the bookshelf: an open book in your hands, and your character's.
  const reading = readingNow();
  me.read(reading);
  hands.read(reading);
  // Opening something on an errand is stopping there.
  if (open && errand && !trip) stopWalking();
  if (open) {
    emoteWheel.close();
    // A phone has no mouse to take back afterwards.
    if (finePointer) player.yieldMouse();
    else player.unlock();
    $('hint').classList.add('hidden');
  } else {
    // A tick later, so closing one window to open the next (Settings → character) doesn't grab the mouse in between.
    setTimeout(backToGame, 0);
  }
  hintKey = '';
});

/** Once the last window is closed, the game has the keyboard again and, in first person, the mouse. */
function backToGame() {
  if (modalOpen()) return;
  if (!isTyping()) canvas.focus({ preventScroll: true });
  if (!player.canLock || player.hasMouse) return;
  // The browser lets a page re-capture the mouse it let go of itself (see yieldMouse), even on Esc
  // (which it doesn't count as a click or key), and any time after a click, like one on ✕. When it
  // won't (nothing of yours opened the window, or a stricter browser), the next key you press does.
  // Closed with a click (Send home, ✕), the view waits for the hand that clicked to come to rest.
  player.lock(pressedMouse);
  relookOnKey = true;
}
document.addEventListener('pointerlockchange', () => {
  if (player.locked) relookOnKey = false;
});

// ---- Clicking the world: use what's under the crosshair (first person) or the mouse (third) ----------
const raycaster = new THREE.Raycaster();
const CROSSHAIR = new THREE.Vector2(0, 0);
/** How close (meters from your eyes) you must be to use each kind of thing. */
const REACH: Record<InteractKind, number> = {
  desk: 4.5,
  station: 4.5,
  coffee: 3,
  issues: 9,
  pulls: 9,
  services: 9,
  queue: 9,
  ci: 9,
  computers: 9,
  tv: 10,
  decor: 9,
  smoke: 3,
  elevator: 4.5,
  gong: 3.5,
  jukebox: 4,
  seat: 3,
  cabinet: 4,
  ladder: 3,
  pole: 4,
  meeting: 7,
  bar: 3.5,
  dj: 6,
  bookshelf: 4,
  golf: 3.5,
};
const eye = new THREE.Vector3();

/** What the ray through `ndc` lands on first, whether it is within reach (plus `slack` meters), and where it hit. */
function aimedAt(ndc: THREE.Vector2, slack = 0): { it: Interactable; near: boolean; hit: THREE.Intersection } | null {
  raycaster.setFromCamera(ndc, camera);
  eye.set(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
  for (const hit of raycaster.intersectObjects(upTop && roof ? roof.pickables : [office.group], true)) {
    let it: Interactable | undefined;
    let shown = true;
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      if (!o.visible) shown = false;
      it ??= o.userData.interact as Interactable | undefined;
    }
    if (!shown) continue;
    if (!it) return null; // a wall, the floor, a plant… is in the way
    return { it, near: hit.point.distanceTo(eye) <= REACH[it.kind] + slack, hit };
  }
  return null;
}

/** The issue whose note on the issues board an aim lands on, or null (bare cork, the frame, anything else). */
function noteUnder(aim: { it: Interactable; hit: THREE.Intersection } | null): GhIssue | null {
  if (aim?.it.kind !== 'issues' || aim.hit.object !== office.boardMeshes.issues || !aim.hit.uv) return null;
  const n = issuesTex.noteAt(aim.hit.uv);
  return n === undefined ? null : (store.issues.items.find((i) => i.number === n) ?? null);
}

/** The tab or Jira card on the issues board an aim lands on, or null. */
function spotUnder(aim: { it: Interactable; hit: THREE.Intersection } | null): BoardSpot | null {
  if (aim?.it.kind !== 'issues' || aim.hit.object !== office.boardMeshes.issues || !aim.hit.uv) return null;
  return issuesTex.spotAt(aim.hit.uv) ?? null;
}

/** E on a tab or Jira card on the issues board: switch to the tab, or open the ticket. False for anything else. */
function useSpot(spot: BoardSpot | null, key: DeskKey): boolean {
  if (!spot || (key !== 'E' && key !== 'O')) return false;
  if (spot.kind === 'tab') {
    if (key !== 'E') return false;
    if (issuesTex.tab !== spot.tab) {
      issuesTex.setTab(spot.tab);
      renderIssuesBoard();
      sound.paper();
    }
    return true;
  }
  const t = store.jiraBoard?.items.find((x) => x.key === spot.key);
  if (!t) return false;
  openTicket(t, boardActions());
  return true;
}

/** The note on the issues board under the crosshair (or, in third person, the mouse), which E takes. */
let aimedNote: GhIssue | null = null;
/** The tab or Jira card on the issues board under the crosshair or the mouse. */
let aimedSpot: BoardSpot | null = null;
/** Where the mouse is over the scene, for pointing at notes in third person; null when it's off it. */
let pointer: THREE.Vector2 | null = null;
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  (pointer ??= new THREE.Vector2()).set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});
canvas.addEventListener('pointerleave', () => (pointer = null));

player.onClick = (ndc) => {
  // At the tee, a click is you steadying the mouse to aim: nothing else is in reach.
  if (modalOpen() || golf.active) return;
  // The gun out: a click fires at what's under the crosshair (or the mouse).
  if (gunOut) {
    fireGun(ndc);
    return;
  }
  if (emoteWheel.isOpen) return emoteWheel.click();
  if (hanger.active) {
    reach();
    hanger.place(ndc);
    return;
  }
  if (player.view === 'first') {
    // Reach out even at nothing, like poking the air.
    reach();
    if (target) interact(target, 'E');
    return;
  }
  const aim = aimedAt(ndc, 2.5);
  if (!aim) return;
  if (!aim.near) {
    toast('Walk closer to that first');
    return;
  }
  use(aim.it, 'E', noteUnder(aim), spotUnder(aim));
};

// Buttons must not keep focus, or Space (jump) would click them again.
$('hud').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) setTimeout(() => btn.blur(), 0);
});
// The project in the corner is the floor you're on; click it for the list of floors to go to.
$('project').addEventListener('click', () => {
  if (!store.floor) return showElevator();
  toggleFloorMenu($('project'), { go: switchFloor, elevator: showElevator, roof: () => ride(ROOF) });
});

// ---- The HUD: a few buttons on the top bar, everything else in the ☰ menu ----------------------------
const waitingNow = () => waitingInOrder(store.workers.values());
const hudActions: HudAction[] = [
  { id: 'issues', icon: '📌', label: 'Issues', section: 'Open', count: () => store.issues.items.filter((i) => i.state === 'OPEN').length, run: () => openBoard('issues', net, boardActions()) },
  { id: 'pulls', icon: '🔀', label: 'Pull requests', section: 'Open', count: () => store.pulls.items.filter((p) => p.state === 'OPEN').length, run: () => openBoard('pulls', net, boardActions()) },
  { id: 'queue', icon: '📋', label: 'Task queue', section: 'Open', count: () => store.queue.tasks.filter((t) => t.status !== 'done').length, title: () => 'Issues and tasks waiting for a worker', run: showQueue },
  { id: 'services', icon: '🌐', label: 'Services', section: 'Open', count: () => store.services.items.length, title: () => 'Web servers the workers are running', run: () => openServices() },
  { id: 'ci', icon: '🏭', label: 'CI automations', section: 'Open', count: () => store.factory.ci.workflows.length, title: () => 'Droid in GitHub Actions, from Factory', run: () => showCi() },
  { id: 'computers', icon: '🖥️', label: 'Computers', section: 'Open', count: () => store.factory.computers.items.length, title: () => 'This machine and your Factory Droid Computers', run: () => showComputers() },
  // Up on the top bar while a meeting is on: what's being worked through in the meeting room.
  {
    id: 'meeting',
    icon: '🤝',
    label: 'Meeting room',
    section: 'Open',
    status: () => store.meeting.current?.status === 'running',
    chip: () => 'In a meeting',
    title: () => 'Call a meeting: workers work through a question or a task together',
    run: () => showMeeting(),
  },
  { id: 'search', icon: '🔎', label: 'Search', section: 'Open', key: '/', title: () => 'Search every terminal', run: showSearch },
  { id: 'elevator', icon: '🛗', label: 'Elevator', section: 'Open', count: () => store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0), title: () => 'Ride to another project', run: showElevator },
  { id: 'roof', icon: '🍸', label: 'Rooftop bar', section: 'Open', shown: () => !upTop && builtFloors().length > 0, title: () => 'Ride the elevator up to the roof: a DJ, drinks and the city', run: () => ride(ROOF) },
  {
    id: 'decor',
    icon: '🖼️',
    label: () => (hanger.active ? 'Stop hanging the picture' : 'Hang a picture'),
    section: 'Together',
    key: 'F',
    on: () => hanger.active,
    status: () => hanger.active,
    run: () => (hanger.active ? hanger.cancel() : startHanging()),
  },
  { id: 'settings', icon: '⚙️', label: 'Settings', section: 'Office', run: showSettings },
  { id: 'phone', icon: '📱', label: 'Pair a phone', section: 'Office', title: () => 'Pair Droid Office for Android with the QR code', run: () => openPhone() },
  { id: 'help', icon: '❓', label: 'Controls', section: 'Office', key: 'H', run: openHelp },
  {
    id: 'upgrade',
    icon: '⬆️',
    label: () => (store.upgrade.phase === 'building' ? 'Upgrading…' : store.upgrade.latest ? 'Update the office' : 'Upgrade the office'),
    section: 'Office',
    shown: () => store.upgrade.available,
    // A new version, or one being built, gets a place on the top bar until it's in.
    status: () => !!store.upgrade.latest || store.upgrade.phase === 'building',
    chip: () => (store.upgrade.phase === 'building' ? 'Upgrading…' : 'Update'),
    tone: () => (store.upgrade.latest && store.upgrade.phase !== 'building' ? 'primary' : undefined),
    title: () => (store.upgrade.latest ? `New version: ${store.upgrade.latest.subject}` : 'Upgrade the office'),
    run: () => openUpgrade(net),
  },
  // Up on the top bar while workers wait on someone (N does the same), next to the Workers button.
  {
    id: 'waiting',
    icon: () => (waitingNow().some((w) => w.status === 'needs_input') ? '🙋' : '✅'),
    label: 'Next worker that needs you',
    section: 'Open',
    key: 'N',
    shown: () => waitingNow().length > 0,
    status: () => waitingNow().length > 0,
    chip: () => waitingLabel(waitingNow()).replace(/^(🙋|✅) /, ''),
    on: () => waitingNow().every((w) => w.status === 'done'),
    tone: () => (waitingNow().some((w) => w.status === 'needs_input') ? 'danger' : undefined),
    title: () => 'Go to the worker that has waited longest on someone (N)',
    run: goToNextWaiting,
  },
];
const hud = mountHud(hudActions, settings, () => saveSettings(settings));
/** F: hang a picture on a wall of this floor. There are no walls for them up on the roof. */
function startHanging() {
  if (upTop) return toast('No walls to hang pictures on up here — take the elevator down to a floor', 'warn');
  hanger.start();
}
function showSettings(pane?: SettingsPane) {
  openSettings(
    net,
    settings,
    (s) => {
      Object.assign(settings, s);
      saveSettings(settings);
      player.setView(settings.view);
      sound.setVolume(settings.volume, settings.muted);
      sound.setMusicVolume(settings.music, settings.musicMuted);
    },
    editProfile,
    () => sound.ding('done'),
    notifier,
    store.sky ? { now: describeSky(store.sky), live: !!store.sky.city } : undefined,
    pane,
  );
}

function editProfile() {
  openCharacter(false, (p) => {
    showMyProfile(p);
    net.send({ t: 'profile', name: p.name, color: p.color, look: p.look });
  });
}

// ---- Main loop ---------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  renderer.setSize(w, hgt, false);
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
  hands.setAspect(w / hgt);
}
window.addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
let spotSavedAt = 0;
const lookDir = new THREE.Vector3();
const workerPos = new THREE.Vector3();
const headPos = new THREE.Vector3();
/** Last frame went through the drunk vision. */
let drunkVisionOn = false;

const fpsEl = $('fps');
let fpsFrames = 0;
let fpsSince = performance.now();
/** Frames drawn since the page loaded, so automation commands can wait for the scene to catch up. */
let framesDrawn = 0;

function frame(ts?: number) {
  framesDrawn++;
  fpsFrames++;
  const fpsNow = performance.now();
  if (fpsNow - fpsSince >= 500) {
    fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (fpsNow - fpsSince))} FPS`;
    fpsFrames = 0;
    fpsSince = fpsNow;
  }
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  const now = performance.now();

  // Coffee: quicker feet, higher jumps, a mug in hand, and maybe the jitters.
  const secs = now / 1000;
  player.speedBoost = caffeine.speed(secs);
  player.jumpBoost = caffeine.jump(secs);
  thud = Math.max(0, thud - dt * 2.5);
  player.jitter = reduceMotion.matches ? 0 : Math.max(caffeine.jitter(secs), thud);
  const mug = caffeine.buzzed(secs);
  // Both hands are on the club at the tee.
  me.holdMug(mug && !golf.active);
  hands.holdMug(mug);
  renderCaffeine(caffeine, secs);
  // Drinks from the rooftop bar: a glass in hand, and the world swaying.
  const drunk = drinking(now);
  player.update(dt);
  // Walked into a pole's hole: you grab the pole on your way down it.
  const hole = office.stack.polesGoDown() ? office.stack.poles().find((s) => Math.hypot(player.pos.x - s.x, player.pos.z - s.z) < POLE.hole - 0.15) : undefined;
  if (hole && !climber.active && !trip && !player.seat && player.enabled && player.pos.y > -1.35 && player.pos.y < 0.6) climber.slide(hole);
  arcade.update(camera, dt);
  cabinet.update(camera, dt);
  // Pulled away from the tee (sat down, off up the ladder, into the elevator): the club goes back.
  if (golf.active && (trip || hanger.active || climber.active || player.seat || upTop)) golf.stop();
  // Pulled away with the gun out (off up the ladder, into the elevator, up to the roof): it goes back.
  if (gunOut && (trip || hanger.active || climber.active || upTop)) holsterGun(true);
  golf.update(dt);
  balls.update(dt);
  office.tee.ball.visible = golf.doing !== 'watch';
  me.root.position.copy(player.pos);
  me.root.position.y += player.stepOffset;
  me.root.rotation.y = player.facing;
  const grip = climber.grip;
  me.setGrip(grip);
  me.update(dt, t, (player.moving && player.grounded) || (grip === 'ladder' && player.moving), !player.grounded && !grip && !golf.active, player.speedBoost);
  const firstPerson = player.view === 'first';
  // In first person you are the camera; in third, hide yourself when it's zoomed in right behind your head.
  // At the tee the camera's behind the ball, and you're the one holding the club.
  me.root.visible = golf.active || (!firstPerson && camera.position.distanceTo(headPos.set(player.pos.x, player.pos.y + 1.3, player.pos.z)) > 1.5);
  if (firstPerson && !golf.active) hands.update(dt, t, { yaw: player.camYaw, pitch: player.lookPitch, walkPhase: player.walkPhase, walking: player.moving && player.grounded, airborne: !player.grounded, jitter: player.jitter, grip });
  // Down a pole: the view widens and the edges streak past.
  const rush = reduceMotion.matches ? 0 : climber.rush;
  const fov = 55 + rush * 16;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 8);
    camera.updateProjectionMatrix();
  }
  whoosh.style.opacity = rush > 0.02 ? String(rush * 0.85) : '0';
  camera.getWorldDirection(lookDir);
  sound.update({ x: player.pos.x, y: player.pos.y + EYE_HEIGHT, z: player.pos.z, fx: lookDir.x, fz: lookDir.z });

  // Where you are, to come back to next time.
  if (now - spotSavedAt > 1000) {
    spotSavedAt = now;
    saveSpot();
  }

  const camPos = camera.position;
  let screens = 0;
  for (const [id, v] of workerViews) {
    const desk = DESK_BY_ID.get(v.deskId)!;
    // A jumping worker holds still while you're near enough to read its card, and jumps again once you walk away.
    const d = v.model.root.getWorldPosition(workerPos).distanceTo(player.pos);
    v.model.held = d < (v.model.held ? HOLD_LEAVE : HOLD_NEAR);
    v.model.update(dt, t);
    // A board agent's kiosk has no laptop to paint (see buildKiosk).
    if (desk.station) continue;
    v.laptop.update(dt, store.screens.get(id), Math.hypot(desk.x - camPos.x, desk.z - camPos.z));
    const glow = (screenGlows[screens] ??= { pos: new THREE.Vector3(), dir: new THREE.Vector3(), power: 0 });
    glow.power = v.laptop.glow(glow.pos, glow.dir);
    if (glow.power > 0.01) screens++;
  }
  sky.setScreens(screenGlows, screens, camPos);
  for (const a of idleAgents) if (a.view.vacancy.visible) a.model.update(dt, t);
  departures.update(dt, t);
  arrivals.update(dt);
  casualties.update(dt, t);
  for (let i = puffs.length - 1; i >= 0; i--) {
    if (puffs[i].update(dt)) continue;
    scene.remove(puffs[i].group);
    puffs[i].dispose();
    puffs.splice(i, 1);
  }
  if (!upTop) {
    office.update(t, dt, [player.pos, ...departures.positions(), ...arrivals.positions(), ...casualties.positions()]);
    office.stack.update(dt, [{ x: player.pos.x, y: player.pos.y, z: player.pos.z, grip }], camera.position);
    office.jukebox.update(t, dt, sound.beat());
  }
  checkSmokeBreak(now);
  smoke.update(dt, camera);
  confetti.update(dt);
  if (!upTop) teamLines.update(reduceMotion.matches ? 0 : dt);
  hanger.update();
  sky.update(dt, t, camera);
  if (upTop && roof) {
    // Everything up there moves to the DJ's set; strobes flash the whole roof as a drop lands.
    const strobe = roof.update(t, dt, djFrame(djAt()), { dark: sky.lampsOn, motion: !reduceMotion.matches });
    ambient.intensity += strobe * 1.5;
    hemi.intensity += strobe * 0.8;
  }
  aimedNote = null;
  aimedSpot = null;
  if (modalOpen() || hanger.active || climber.active || golf.active) target = null;
  else if (firstPerson) {
    const aim = aimedAt(CROSSHAIR);
    target = aim?.near ? aim.it : mySeat();
    if (aim?.near) {
      aimedNote = noteUnder(aim);
      aimedSpot = spotUnder(aim);
    }
  } else {
    target = mySeat() ?? pickTarget();
    // By the issues board, the mouse points at the note you'd take, a tab or a Jira card.
    if (target?.kind === 'issues' && pointer) {
      const aim = aimedAt(pointer, 2.5);
      if (aim?.near) {
        aimedNote = noteUnder(aim);
        aimedSpot = spotUnder(aim);
      }
    }
  }
  issuesTex.lift(aimedNote?.number ?? null);
  issuesTex.hover(aimedSpot);
  renderHint();
  renderCrosshair();

  // A few drinks in, the frame goes to the screen through the drunk vision (see world/drunk.ts).
  const blurry = drunk > 0.01;
  if (blurry) drunkVision.begin();
  else if (drunkVisionOn) drunkVision.release();
  drunkVisionOn = blurry;
  effect.render(scene, camera);
  pointToWaiting(now);
  // Not while the camera's up at the boss's monitor or the arcade, where they'd cover the screen.
  if (firstPerson && !arcade.zoomed && !cabinet.zoomed && !golf.active) {
    // Hands go on top of everything, so they never clip into a desk you walk up to. They have
    // lights of their own, turned down to match wherever you're standing.
    renderer.clearDepth();
    hands.setLight(sky.lightAt(camera.position));
    sky.shading(false);
    effect.render(hands.scene, hands.camera);
    sky.shading(true);
  }
  if (blurry) drunkVision.end(drunk, t, !reduceMotion.matches);
  loading.drew();
}

let loopStarted = false;
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  renderer.setAnimationLoop(frame);
}

// ---- Boot ------------------------------------------------------------------------------------------
function boot() {
  net.connect();
  startLoop();
}

guardLeaving();
// The world is built. Come down once it has drawn, or at the cap if this page never gets that far.
loading.until([]);
{
  // The sign-in page's remembered name, from before there was no signing in: gone once, here.
  try {
    localStorage.removeItem('droid-office.login-name');
  } catch {
    // storage blocked
  }
  const saved = loadProfile();
  if (saved?.look) {
    store.profile = { ...saved, look: saved.look };
    showMyProfile(store.profile);
    boot();
  } else {
    // Pick a character first (people from before there was a choice keep their name and color).
    if (saved) Object.assign(store.profile, { name: saved.name, color: saved.color });
    // Render the office behind the character select screen.
    startLoop();
    openCharacter(true, (p) => {
      showMyProfile(p);
      net.connect();
    });
  }
}

// ---- window.office: the automation API agents and browser tests drive (see automation.ts) ----------
/** The middle of the scene object an interactable belongs to (a board, the coffee machine), to look at. */
function centerOf(spot: Interactable): { x: number; y: number; z: number } | null {
  const root = upTop && roof ? roof.group : office.group;
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.userData.interact === spot) found = o;
  });
  if (!found) return null;
  const c = new THREE.Box3().setFromObject(found).getCenter(new THREE.Vector3());
  return { x: c.x, y: c.y, z: c.z };
}

/** Faces and looks at `face` from where you stand, in either view. */
function aimAt(face: { x: number; y: number; z: number }) {
  player.facing = facingToward(player.pos, face);
  player.camYaw = player.facing - Math.PI;
  player.lookPitch = pitchToward({ x: player.pos.x, y: player.pos.y + EYE_HEIGHT, z: player.pos.z }, face);
  player.updateCamera(true);
}

function setCamera(pose: CameraPose) {
  player.setView(pose.view);
  player.camYaw = pose.camYaw;
  if (pose.lookPitch !== undefined) player.lookPitch = pose.lookPitch;
  if (pose.camPitch !== undefined) player.camPitch = pose.camPitch;
  if (pose.camDist !== undefined) player.camDist = pose.camDist;
  if (pose.view === 'first') player.facing = pose.camYaw + Math.PI;
  player.updateCamera(true);
}

const automation = createAutomation({
  context: () => ({ workers: [...store.workers.values()], spots: usable().flat(), floors: store.floors, floor: store.floor }),
  raw: () => ({
    floor: store.floor,
    floors: store.floors,
    riding: !!trip,
    player: {
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      facing: player.facing,
      lookPitch: player.lookPitch,
      view: player.view,
      seat: player.seat?.seatId ?? null,
      enabled: player.enabled,
      walking: !!errand,
      climbing: climber.active,
    },
    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    using: null,
    modals: openModalList(),
    terminal: openTerminalFor(),
    workers: [...store.workers.values()],
    carrying: carrying?.issue ?? null,
    hanging: hanger.active,
    golfing: golf.active,
    gun: gunOut,
  }),
  busy: () => (trip ? 'riding to another floor' : climber.active ? 'on the ladder or a fire pole' : !store.floor ? 'not on a floor yet: ride the elevator first' : null),
  blocked: (x, z, y) => player.blockedAt(x, z, y),
  centerOf,
  place: (at, face) => {
    closeAllModals();
    if (player.seat) standUp();
    if (hanger.active) hanger.cancel();
    if (climber.active) climber.abort();
    if (golf.active) golf.stop();
    if (errand) stopWalking();
    player.pos.set(at.x, at.y, at.z);
    player.vy = 0;
    aimAt(face);
  },
  aim: aimAt,
  walk: (at, label, done) => walkThen(at, label, () => {}, undefined, done),
  near: () => mySeat() ?? pickTarget(),
  // No note or tab on the issues board: whatever the crosshair happens to be over, E opens the board.
  use: (spot, key) => use(spot, key, null, null),
  commands: () => hudActions.map((a) => ({ id: a.id, label: actionLabel(a), shown: actionOffered(a), blocked: a.blocked?.() })),
  run: (id) => hudActions.find((a) => a.id === id)?.run(),
  closeAll: closeAllModals,
  ride,
  setCamera,
  frames: () => framesDrawn,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
(window as unknown as { office: typeof automation }).office = automation;

// Debug handle for quick checks from the console / headless screenshots.
(window as any).__office = {
  roof: () => roof,
  booze,
  dj: () => djFrame(djAt()),
  store,
  player,
  caffeine,
  camera,
  arcade,
  cabinet,
  workerViews,
  departures,
  arrivals,
  casualties,
  scene,
  net,
  renderer,
  hands,
  me,
  settings,
  gallery,
  hanger,
  office,
  ride,
  switchFloor,
  climber,
  golf,
  balls,
  elevatorPanelOpen,
  confetti,
  sky,
  carried: () => carrying,
  emoteWheel,
  emote,
};
(window as any).__sound = sound;
(window as any).__notify = notifier;
