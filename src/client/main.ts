import './style.css';
import './scrollbars';
import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import {
  BEANBAGS,
  DESK_BY_ID,
  DESKS,
  ELEVATOR,
  ELEVATOR_CAR,
  FLOOR,
  LADDER,
  LOFT,
  SEATING_BY_ID,
  SLAB,
  WALL_HEIGHT,
  inElevator,
  nextFreeSeat,
  roofDrop,
  seatPlace,
  streetBelow,
  type DeskDef,
  type SeatDef,
  type SeatPlace,
} from '../shared/layout';
import { forgeOf, forgeWords, normalizeRepo, repoChoices as otherRepos, repoWebUrl } from '../shared/floors';
import { OFFICE_SHELL_ID } from '../shared/office-shell';
import { ORCHESTRATOR_ID, ORCHESTRATOR_NAME } from '../shared/mission-control';
import { botLine, missionWaiting, missionWorker, orchestratorLine, orchestratorWorker } from './mission';
import { ORCHESTRATOR_SPOT, PHASE_WORD, missionStand, missionTeamLine, orchestratorAwake, orchestratorPhase, orchestratorWaiting } from './mission-office';
import type { AgentEffort, CarriedIssue, FloorInfo, GhIssue, GongWhy, ServerMsg, WorkerInfo } from '../shared/protocol';
import {
  DESK_MOMENT_FX,
  type DeskMoment,
  FLOOR_EVENT_FX,
  FLOOR_MOOD_LIGHTING,
  type FloorEvent,
  isFloorEvent,
  isFloorMood,
  isMonitorSpillTone,
  isWorkerMicroReaction,
  MICRO_REACTION_FX,
  MONITOR_SPILL_HEX,
  MONITOR_SPILL_POWER,
  type MonitorSpillTone,
  resolveVibesSwitchState,
  VibesSwitchToggle,
  type WorkerMicroReaction,
} from '../shared/gemini-vibes';
import { ciForFloor } from '../shared/factory-ci';
import { wikiShelfLine } from '../shared/factory-wiki';
import { isPaletteKey } from '../shared/palette';
import { isAsleep, isBusy, workerActivity } from '../shared/status';
import { Net } from './net';
import { removedFloorNotice, standSpot } from './arrival';
import { floorShortcut } from './floor-shortcuts';
import { nextTerminal, terminalShortcut } from './terminal-cycle';
import { guardLeaving } from './leave';
import { store, connectWhiteboard, lastFloor, lastSpot, loadProfile, loadSettings, rememberSpot, saveSettings, words, workerForPull, type Profile, type Spot } from './state';
import { officeTitle } from './tab-title';
import { PlayerController, groundAt, isTyping } from './player';
import { gongRinging, renderPace, sceneIsMoving, skyFalling, type RenderPace, type SceneMotion } from './render-pace';
import { RenderLoop } from './render-loop';
import { Climber, type Grip, type Way } from './climb';
import { buildOffice, type Collider, type DeskView, type InteractKind, type Interactable } from './world/office';

import { propManifest, propScene } from './world/props';
import { buildRooftop, type Rooftop } from './world/rooftop';

import { ROOF, ROOF_NAME } from '../shared/rooftop';

import { Person, type Worker, type Stage } from './world/character';

import { Hands } from './world/hands';
import { Smoke } from './world/smoke';
import { HAZE_MAX, Sky, describeSky, type ScreenGlow } from './world/sky';
import { Laptop } from './world/laptop';

import type { BoardSpot } from './world/board-layout';
import { loadFonts } from './fonts';
import { Gallery } from './world/gallery';

import { TeamLines } from './world/team-lines';
import { MissionRoom } from './world/mission-control';
import { openBot, openOrchestrator } from './ui/mission-control';
import { stopOrchestrator } from './ui/orchestrator';

import { TEAM_MARK, teamStanding, teamSummary } from '../shared/team';
import { Puff } from './world/gun';
import { GUN_TRICKS } from './world/gun-motion';

import { WAND_SPELLS } from './world/wand-motion';

import { Confetti, type Area } from './world/confetti';
import { VibeFx } from './world/vibe-fx';
import { Hanger } from './hanging';
import { redrawText } from './world/toon';
import { OfficeSound } from './sound';
import { DesktopNotifier, askNotifyPermission, notifyPermission, waitingOnSomeone } from './notify';
import { NextUp, waitingInOrder, waitingLabel } from './nextup';
import { linkStep, parseWorkerLink, type WorkerLink } from './worker-link';
import { $, h, clip, closeAllModals, modalOpen, onModalChange, openModalList, readingNow, toast, STATUS_LABEL } from './ui/dom';
import { deskApproach, type ApproachPose } from './approach';
import { createAutomation, facingToward, pitchToward, runCommand, type CameraPose } from './automation';
import { onOpenTeammate, openOfficeShell, openTerminal, openTerminalFor, routeTerminalMessage, terminalOnTop, type TerminalFind } from './ui/terminal';
import { openSearch } from './ui/search';
import { changesLogFor, openChanges, openChangesFor, routeChangesMessage } from './ui/changes';
import { openRepoPulls, workerRepos } from './ui/repos';
import { openPrompt, confirmDialog, sendHomeDialog, lostWorktreeDialog, routeWorktreeMessage, worktreePref } from './ui/prompt';
import { issuePrompt, openBoard } from './ui/boards';
import { openTicket, routeJiraMessage } from './ui/jira';
import { openLinearTicket, routeLinearMessage } from './ui/linear';
import { bindFactory } from './factory';
import { FactoryTvTexture } from './world/factory-tv';
import { creditsNote } from '../shared/factory-sessions';
import { openIssue, openPull, routePullMessage } from './ui/pull';
import { openAsk } from './ui/ask';
import { paletteOpen, togglePalette, type PaletteEntry } from './ui/palette';
import { loadingScreen } from './ui/loading';
import { openPipelines, routePipelinesMessage, type PipelinesOpen } from './ui/pipelines';
import { isLive, pipelinePolicy, stateWord } from '../shared/pipelines';
import { openUpgrade, restarting, showRestarting, showUpgraded } from './ui/upgrade';
import { openHelp, renderWorkers } from './ui/hud';
import { cloudLine, hireCloud, openCloudWindow, runsOnPicker, sendCloudHome } from './ui/factory-cloud';
import { cloudBadge } from '../shared/factory-cloud';
import { Compass, type Bearing } from './ui/compass';
import { openCharacter } from './ui/character';
import { openSettings, type SettingsPane } from './ui/settings';
import { openWelcome, watchWelcome } from './ui/welcome';
import { OPEN_SETTINGS_EVENT } from './ui/model-picker';
import { resolveSettingsPane, type SettingsCardTitle } from '../shared/settings-nav';
import { officePrompt } from './ui/prompts';
import { forgeVars } from '../shared/prompts';
import { INCLUDE_FILE, SETUP_FILE, describeSetup } from '../shared/worktree-setup';
import { openPhone } from './ui/phone';
import { openCompanion } from './ui/companion';
import { elevatorPanelOpen, openElevator, routeElevatorMessage } from './ui/elevator';
import { routeFolderMessage } from './ui/folder-browser';
import { routeFloorMenuMessage, toggleFloorMenu } from './ui/floormenu';
import { modelBadge, rememberedChoice } from './ui/models';
import { officeFull, pressureNote } from './world/machine';

import { gridSummary } from './world/whiteboard-wall';
import { openCiWindow } from './ui/factory-ci';
import { wallSummary } from './world/factory-computers';

import { openComputers } from './ui/factory-computers';
import { actionLabel, actionOffered, mountHud, type HudAction } from './ui/menu';
import { openJukebox } from './ui/jukebox';
import { openBookshelf, type ShelfTab } from './ui/bookshelf';
import { openWhiteboard, routeWhiteboardMessage, whiteboardChanged } from './ui/whiteboard';
import { trackTitle } from '../shared/jukebox';
import { EMOTES, EMOTE_BY_ID, EmoteBucket, type EmoteId } from '../shared/emotes';
import { EmoteWheel } from './ui/emotes';
import { wayTo } from './walkto';
import { Upscaler } from './world/upscaler';
import { Remaster } from './world/remaster';
import { firstVisibleIntersection, preparePicking } from './world/picking';
import { bakeBudget, bakeKey, loadRemaster, type RemasterSettings, resolveRemaster, saveRemaster } from './remaster-settings';
import { bakeCache } from './gi-cache';
import { SCENE_HASH } from './scene-hash';
import { FrameStats, pacingText } from './frame-stats';
import { presenterStats, reportHdr } from './native-bridge';
import { GpuTimer } from './gpu-timer';
import { gpuBusy, statsText } from './graphics';
import { withToken } from './token';
import { warmOfficeShaders, warmOutlines } from './shader-warmup';
import { WarmupWatch, type WarmupStatus } from './warmup';
import { mountWallBoards } from './runtime/wall-boards';
import { installElevatorPanels } from './world/elevator-panels';
import { installRoofPlanters } from './world/rooftop-planter';
import { installCityFacades } from './world/city-facades';
import { loadOfficeModels } from './runtime/prop-models';
import { createSidearm } from './runtime/sidearm';
import { createWorkerScene, WORKER_HEAD, type WorkerView } from './runtime/worker-scene';
import { createFloorTravel } from './runtime/floor-travel';

// Up from the first paint (index.html) until the office has drawn a frame. Props and shaders are waited on below.
const loading = loadingScreen(() => () => {});

// ---- Renderer & scene ---------------------------------------------------------------------------
const canvas = $('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
/** The ink outline round every solid. Its thickness and alpha are fixed when it's made, so the Remastered renderer makes a new one to change them. */
const outlineEffect = (thickness = 1.8, alpha = 1) => new OutlineEffect(renderer, { defaultThickness: thickness / 1000, defaultColor: [0.035, 0.035, 0.035], defaultAlpha: alpha });
let effect = outlineEffect();
let outlineKey = '1.8|1';
// Draw calls add up over a frame's passes and are cleared once a frame (see drawFrame).
renderer.info.autoReset = false;
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
scene.add(sun);

const office = buildOffice();
scene.add(office.group);
const teamLines = new TeamLines();
office.group.add(teamLines.group);
// Mission Control's building agents: the Orchestrator at the head of the table, the external bots in its chairs.
const mission = new MissionRoom(office.mission, office.interactables);
office.group.add(mission.group);

// The MacBook GLBs load after the scene exists; each laptop swaps its procedural
// stand-in for them the first frame they are cached (see world/laptop.ts). A gun drawn before
// magnum.glb lands stays empty until it does (see world/gun.ts), and so does a wand before wand.glb (world/wand.ts).
const propsReady = loadOfficeModels({
  office,
  get roof() {
    return roof;
  },
});
const sky = new Sky(scene, { sun, hemi, ambient }, office.night);
/** The laptop screens that light the room, reused every frame (see Sky.setScreens). */
const screenGlows: ScreenGlow[] = [];
const peopleScratch: { x: number; y: number; z: number }[] = [];
const climbersScratch: [{ x: number; y: number; z: number; grip: Grip | null }] = [{ x: 0, y: 0, z: 0, grip: null }];
store.on('sky', () => store.sky && sky.set(store.sky));

const NO_OUTLINE = { visible: false };
const noOutline = (obj: THREE.Object3D) =>
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry;
    const flat = geo instanceof THREE.PlaneGeometry || geo instanceof THREE.CircleGeometry;
    if (Array.isArray(m.material)) {
      for (let i = 0; i < m.material.length; i++) {
        const mat = m.material[i];
        if (flat || mat instanceof THREE.MeshBasicMaterial) mat.userData.outlineParameters = NO_OUTLINE;
      }
    } else {
      const mat = m.material;
      if (flat || mat instanceof THREE.MeshBasicMaterial) mat.userData.outlineParameters = NO_OUTLINE;
    }
  });
noOutline(office.group);

const hiddenMatrixHooked = new WeakSet<THREE.Object3D>();
function skipHiddenMatrixWorld(root: THREE.Object3D) {
  if (hiddenMatrixHooked.has(root)) return;
  hiddenMatrixHooked.add(root);
  root.updateMatrixWorld(true);
  let wasHidden = !root.visible;
  root.updateMatrixWorld = function (force?: boolean) {
    if (!this.visible) {
      wasHidden = true;
      return;
    }
    THREE.Object3D.prototype.updateMatrixWorld.call(this, force || wasHidden);
    wasHidden = false;
  };
}

// Boards: each draws onto a canvas texture, redrawn whenever what it shows changes.
/** The issue card in your hands, taken off this floor's issues board, or null. */
let carrying: CarriedIssue | null = null;
const wallBoards = mountWallBoards({
  store,
  office,
  get carrying() {
    return carrying;
  },
  get upTop() {
    return upTop;
  },
  get player() {
    return player;
  },
});
const { issuesTex, pipelinesTex, computeWall, renderIssuesBoard, floorGithubRepo, floorWhiteboard, wallCard } = wallBoards;
/** The Computers window, on one computer when `id` is given. */
const showComputers = (id?: string) => openComputers({ settings: () => showSettings('connections'), id });
const showCi = (add = false) => openCiWindow({ floorRepo: floorGithubRepo(), add });

// Pictures people hung on the walls
const gallery = new Gallery();
office.group.add(gallery.group);
store.on('decor', () => gallery.sync(store.decor));

// Confetti for merges, landing on whatever it falls on
const confetti = new Confetti((x, z, y) => groundAt(office.colliders, x, z, y, false));
scene.add(confetti.mesh);

// Living 3D's shockwaves, beams and sparks (Gemini Decision 1).
const vibeFx = new VibeFx();
scene.add(vibeFx.group);
let vibeFxMoving = false;
let lastFloorEventSeq = 0;
/** The last room-wide event and desk moment this view played (for automation). */
let lastRoomEvent: FloorEvent | 'ship_it' | null = null;
let lastDeskMoment: { kind: DeskMoment; worker: string } | null = null;
/** Whether Living 3D was on at the last `gemini` update, to play the switch-on and switch-off sweeps; null before the first. */
let vibesWasOn: boolean | null = null;

// The lounge TV: the Factory sessions dashboard while the office is connected to Factory, else its
// standby screen (world/factory-tv.ts). It is a board only: nothing opens from it. The same slice
// puts each worker's credits in the Workers panel, its desk hint and its terminal's header.
const tvTex = new FactoryTvTexture();
const renderTv = (force = false) => tvTex.render(store.factory, Date.now(), force);
const tvMat = office.tvScreen.material as THREE.MeshBasicMaterial;
tvMat.color.set('#ffffff');
tvMat.map = tvTex.texture;
tvMat.toneMapped = false;
renderTv(true);
// Running sessions' ages tick by the minute; the texture skips a redraw that would look the same.
setInterval(() => renderTv(), 30_000);
let workerCredits = '';
store.on('factory', () => {
  renderTv();
  const k = JSON.stringify(store.factory.sessions.office);
  if (k === workerCredits) return;
  workerCredits = k;
  renderWorkers((id) => openWorkerTerminal(id));
  hintKey = '';
});
// The world's canvases drew at boot, before the bundled fonts were necessarily in: repaint them
// once Geist and Geist Mono are loaded, so nothing is left in a fallback typeface.
void loadFonts().then(() => {
  wallBoards.repaint();
  renderTv(true);
  redrawText();
});
// A worker laptop upstairs, always showing the floor's login shell.
const bossLaptop = new Laptop();
office.bossLaptopAnchor.add(bossLaptop.root);
noOutline(bossLaptop.root);

// ---- The rooftop ---------------------------------------------------------------------------------
/** Up on the roof: built the first time anyone goes up there. */
let roof: Rooftop | null = null;
function theRoof(): Rooftop {
  if (!roof) {
    roof = buildRooftop(office.night, roofFloors());
    const rooftopPlanter = propScene('rooftop-planter');
    if (rooftopPlanter) installRoofPlanters(rooftopPlanter, roof.group);
    const cityFacades = propScene('city-facades');
    if (cityFacades) installCityFacades(cityFacades, roof.group);
    const elevatorPanels = propScene('elevator-panels');
    if (elevatorPanels) installElevatorPanels(elevatorPanels, roof.elevator.group);
    roof.group.visible = false;
    scene.add(roof.group);
    noOutline(roof.group);
    skipHiddenMatrixWorld(roof.group);
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

// ---- Networking & state -------------------------------------------------------------------------
const net = new Net(() => store.profile, whereNow);
bindFactory(net);

const me = new Person(store.profile.name, store.profile.color, store.profile.look);
me.showLabel(false);
// You are the camera: the hands are all you see of yourself.
me.root.visible = false;
scene.add(me.root);
noOutline(me.root);
const settings = loadSettings();
const player = new PlayerController(camera, canvas, office.colliders);
// Everyone arrives by elevator (the welcome says exactly where).
placeInCar();
const hands = new Hands(store.profile.color, me.skinColor);
/** No shaking the view when the system asks for less motion. */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Muzzle smoke.
const smoke = new Smoke();
scene.add(smoke.group);
const sound = new OfficeSound();
sound.setVolume(settings.volume, settings.muted);
sound.setAlertsMuted(settings.alertsMuted);
sound.setMusicVolume(settings.music, settings.musicMuted);
sound.onMusicError = (text) => toast(text, 'warn');
// One jukebox across the office: changing floors keeps the same player and track position.
store.on('jukebox', () => {
  const j = store.jukebox;
  sound.setJukebox(j.on ? { track: j.track, url: j.url, startedAt: j.startedAt, since: j.since } : null);
  office.jukebox.show(j.on, trackTitle(j));
});
const notifier = new DesktopNotifier(
  () => settings.notify,
  (id) => openWorkerTerminal(id),
);
sky.onThunder = (delay, loud) => sound.thunder(delay, loud);
const hanger = new Hanger(net, camera, canvas, player, office, gallery);
scene.add(hanger.ghost.group);
hanger.onChange = () => {
  hud.refresh();
  // Not '': that reads as "no hint shown", and the hanging hint would stay up.
  hintKey = 'stale';
};

// ---- The ladder ----------------------------------------------------------------
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
  sound: (kind) => {
    if (kind === 'grab') sound.rung(true);
    else if (kind === 'rung') sound.rung();
    else if (kind === 'bonk') {
      sound.bonk();
      toast(`🔝 ${store.currentFloor()?.name ?? 'This'} is the top floor — the hatch won't budge`);
    }
  },
  done: () => {
    // Not '': that reads as "no hint shown", and the climbing hint would stay up.
    hintKey = 'stale';
  },
});
/** How hard the view shakes after a shot, easing off to 0. */
let thud = 0;
office.stack.onHatch = (where, open) => sound.hatch({ x: LADDER.x + 0.3, y: where === 'floor' ? 0 : WALL_HEIGHT, z: LADDER.z }, open);
/** E at the ladder: onto it, facing the wall. */
function grabLadder() {
  if (floorTravel.trip || climber.active) return;
  if (!floorThere(1) && !floorThere(-1)) return toast('No other floors yet — add a project in the elevator', 'warn');
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (errand) stopWalking();
  climber.grabLadder();
}

/**
 * The ladder goes where there are floors to go to from this one, and the building is as
 * tall as there are floors, with the street as far down as this one is up.
 */
function syncStack() {
  const floors = builtFloors();
  const index = floors.findIndex((f) => f.id === store.floor);
  // Up on the roof there's no ladder to take: nothing above, nothing below.
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

const workerScene = createWorkerScene({
  scene,
  office,
  store,
  player,
  sound,
  notifier,
  reduceMotion,
  mission,
  teamLines,
  screenGlows,
  sky,
  noOutline,
  words,
  liftOnto,
  burstOver,
  deskMomentFx,
  shippedFx,
  renderWorkers: () => renderWorkers((id) => openWorkerTerminal(id)),
  modelBadge,
  renderWaiting,
  renderTitle,
  renderWake,
  wandOut: () => wandOut(),
  get lastWandShip() {
    return lastWandShip;
  },
  get vibeFxMoving() {
    return vibeFxMoving;
  },
});
const { workerViews, sentHome, shotWorkers, departures, visitors, casualties, syncWorkers, syncMissionControl, anyWorker, focusTeam, paintPrs, sayVisit, workerMoving } = workerScene;
const sidearm = createSidearm({
  settings,
  store,
  scene,
  camera,
  player,
  hands,
  me,
  sound,
  smoke,
  net,
  office,
  bossLaptop,
  confetti,
  workerViews,
  reduceMotion,
  get climber() {
    return climber;
  },
  get hanger() {
    return hanger;
  },
  get carrying() {
    return carrying;
  },
  get emoteWheel() {
    return emoteWheel;
  },
  get raycaster() {
    return raycaster;
  },
  get crosshair() {
    return CROSSHAIR;
  },
  get upTop() {
    return upTop;
  },
  get confettiDensity() {
    return CONFETTI_DENSITY;
  },
  get thud() {
    return thud;
  },
  set thud(value) {
    thud = value;
  },
  invalidateHint: () => {
    hintKey = 'stale';
  },
  openWorkerTerminal,
  openOfficeShell: () => {
    openOfficeShell(net);
  },
  openPane,
  runUnder,
  danceParty,
  floorArea: (area) => floorArea(area),
  ceilingOver,
});
const {
  wandOut,
  arms,
  gunMotion,
  wandMotion,
  shotCharge,
  lastWandShip,
  wandLight,
  tipTrail,
  puffs,
  tipWorld,
  tipDir,
  clearChargeFeedback,
  cancelShotCharge,
  updateShotCharge,
  toggleGun,
  holsterGun,
  gunTrick,
  wandSpell,
  wandTipAt,
  gunCues,
  wandCues,
  addEffect,
  fireGun,
} = sidearm;
let firstWelcome = true;
/** The server version this page was loaded with. */
let bootVersion = '';
let upgradePhase = '';

connectWhiteboard((msg) => net.send(msg));
net.onStatus((up) => {
  $('conn').classList.toggle('hidden', up);
  store.whiteboard.status(up);
});
/** WebSocket messages that only update DOM windows, RPC callbacks, or other floors' state, never the 3D scene. */
const NO_SCENE_WAKE = new Set<ServerMsg['t']>([
  'term.data',
  'term.snapshot',
  'thread.snapshot',
  'action.result',
  'pong',
  'building.worker',
  'building.remove',
  'building.pulls',
  'floor.branches',
  'floor.repos',
  'floor.folders',
  'floor.added',
  'projectsDir',
  'worker.worktree',
  'worktreeSetup',
  'changes',
  'changes.diff',
  'gh.merged',
  'gh.commented',
  'gh.closed',
  'gh.labeled',
  'pipelines.detail',
  'pipelines.done',
  'jira.setup',
  'linear.setup',
  'factory.setup',
  'whiteboard.pinged',
  'whiteboard.renderer',
  'toast',
  'upgrade',
  'leaveOnMerge',
  'subagents',
  'models.hidden',
  'workerLabels',
  'prompts',
  'setup',
]);

// Decoded Kitty images arrive after the WebSocket handler, but still need a prompt draw.
store.on('screens', (workerId) => {
  if (!upTop && workerId && (workerId === OFFICE_SHELL_ID || workerViews.has(workerId))) renderWake();
});

net.onMessage((msg) => {
  // The floor you asked to come back to (see Net.connect), to tell if the office put you somewhere else.
  const wasOn = msg.t === 'welcome' ? (store.floor ?? lastFloor()) : null;
  if (msg.t === 'welcome' || msg.t === 'floor.enter') {
    departures.clear();
    casualties.clear();
    visitors.clear();
  }
  if (msg.t === 'worker.remove') (msg.shot ? shotWorkers : sentHome).add(msg.workerId);
  store.apply(msg);
  sentHome.clear();
  shotWorkers.clear();
  routeTerminalMessage(msg);
  routeChangesMessage(msg);
  routePullMessage(msg);
  routePipelinesMessage(msg);
  routeJiraMessage(msg);
  routeLinearMessage(msg);
  routeElevatorMessage(msg);
  routeFolderMessage(msg);
  routeFloorMenuMessage(msg);
  routeWhiteboardMessage(msg);
  switch (msg.t) {
    case 'worker.open':
      openWorkerTerminal(msg.workerId);
      break;
    case 'welcome': {
      // A few pings, to line this page's clock up with the office's for the jukebox.
      for (let i = 0; i < 5; i++) setTimeout(() => net.send({ t: 'ping', at: performance.now() }), 200 + i * 500);
      if (firstWelcome) {
        firstWelcome = false;
        // Where the office put you: back in the spot you left (if there's still room there), or in the elevator car.
        setPlace();
        syncStack();
        const spot = standSpot(
          msg.arrival,
          (x, y, z) => player.blockedAt(x, z, y),
          builtFloors().findIndex((f) => f.id === msg.arrival.floor),
        );
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
      if (openId === OFFICE_SHELL_ID) net.send({ t: 'shell.attach' });
      else if (openId && store.worker(openId)) net.send({ t: 'worker.attach', workerId: openId });
      const watching = openChangesFor();
      if (watching && store.workers.has(watching.workerId)) net.send({ t: 'changes.watch', ...watching });
      const following = changesLogFor();
      if (following && following !== openId && store.workers.has(following)) net.send({ t: 'worker.attach', workerId: following });
      renderProject();
      hud.refresh();
      // Back from a restart on another version: this page's code is stale, so load the new one.
      if (!bootVersion) bootVersion = msg.version;
      else if (msg.version !== bootVersion || restarting()) showUpgraded(msg.upgrade);
      upgradePhase = msg.upgrade.phase;
      followWorkerLink();
      break;
    }
    case 'floor.enter':
      // A trip of yours keeps the shell window: it is this floor's shell now. Being taken away closes it.
      if (floorTravel.trip && openTerminalFor() === OFFICE_SHELL_ID) net.send({ t: 'shell.attach' });
      // Not a trip of yours: the floor you were on was taken off the building, and the elevator took you away.
      if (!floorTravel.trip) takenAway();
      if (floorTravel.trip?.how === 'switch' && msg.arrival.at) {
        const at = msg.arrival.at;
        player.pos.set(at.x, at.y, at.z);
        player.vy = 0;
      }
      // The card belongs to the board downstairs (or up): the office already put it back there.
      if (carrying) {
        toast(`📌 #${carrying.issue} stayed behind on the other floor's board`);
        setCarrying(null);
      }
      arrive();
      followWorkerLink();
      break;
    case 'floors':
      noticeWaiting();
      break;
    case 'worker.worktree':
      routeWorktreeMessage(msg);
      break;
    case 'toast': {
      if (msg.level === 'error') sound.ding('error');
      const el = toast(msg.text, msg.level);
      const id = msg.workerId;
      // About a worker on this floor or a building agent (a subagent hired, a report back): a click opens its terminal.
      if (id && anyWorker(id)) {
        el.classList.add('link');
        el.title = 'Open its terminal';
        el.addEventListener('click', () => openWorkerTerminal(id));
      }
      break;
    }
    case 'upgrade':
      if (msg.state.phase === 'restarting') showRestarting(msg.state, net);
      if (msg.state.phase === 'failed' && upgradePhase === 'building') {
        toast(`The upgrade failed, so the office stays on ${msg.state.current?.sha ?? 'this version'}`, 'error');
        sound.ding('error');
      }
      upgradePhase = msg.state.phase;
      break;
    case 'gong':
      gongRang(msg.why, msg.pr);
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
  // The terminal canvas updates on its own. Everything that changes the 3D picture draws promptly.
  if (msg.t !== 'screen' && !NO_SCENE_WAKE.has(msg.t)) {
    renderWake();
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
  const floor = store.floors.find((f) => f.id === store.floor);
  const branch = store.floor === ROOF || !p ? undefined : (floor?.selectedBranch ?? (store.freshMain.on ? floor?.baseBranch : undefined) ?? (floor ?? p).branch);
  const branchLabel = branch === 'HEAD' ? 'Detached HEAD' : branch;
  const indicator = $('project-branch');
  indicator.classList.toggle('hidden', !branchLabel);
  indicator.textContent = branchLabel ? `⎇ ${branchLabel}` : '';
  indicator.title = branchLabel ? `Floor branch: ${branchLabel}${floor?.branch && floor.branch !== branch ? ` · Checkout: ${floor.branch}` : ''}` : '';
  indicator.setAttribute('aria-label', indicator.title);
  renderTitle();
  if (store.floor === ROOF) {
    const n = builtFloors().length;
    $('project-meta').classList.remove('lobby');
    $('project-name').textContent = `🏙️ ${ROOF_NAME}`;
    $('project-meta').textContent = `🛗 on top of ${n} floor${n === 1 ? '' : 's'} · the city all around`;
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
store.on('freshMain', renderProject);

/** The tab title counts workers waiting on someone, on every floor, while this tab is in the background. Focusing it clears the count. */
function renderTitle() {
  const name = store.project?.name;
  const elsewhere = store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0);
  const waiting = [...store.workers.values()].filter(waitingOnSomeone).length + elsewhere + missionWaiting(store.missionControl);
  document.title = officeTitle(name, waiting, document.hidden || !document.hasFocus());
}
window.addEventListener('visibilitychange', renderTitle);
window.addEventListener('focus', renderTitle);
window.addEventListener('blur', renderTitle);

// ---- Floors & the elevator ----------------------------------------------------------------------
/** In the car, facing out through the doors: where you are when you arrive on a floor. */
function placeInCar(at?: { x: number; z: number }) {
  const spot = at && inElevator(at.x, at.z) ? at : { x: ELEVATOR.x, z: (ELEVATOR_CAR.minZ + ELEVATOR_CAR.maxZ) / 2 };
  placeAt({ x: spot.x, y: 0, z: spot.z, rotY: 0 });
}

/** On your feet at `at`, facing `rotY` and looking straight ahead. The elevator arrives this way, level, not at a desk's pitch. */
function placeAt(at: { x: number; y: number; z: number; rotY: number }) {
  if (player.seat) standUp();
  player.pos.set(at.x, at.y, at.z);
  player.vy = 0;
  player.facing = at.rotY;
  player.camYaw = player.facing - Math.PI;
  player.lookPitch = -0.08;
}

const floorTravel = createFloorTravel({
  store,
  player,
  office,
  camera,
  sky,
  net,
  far: FAR,
  get sound() {
    return sound;
  },
  get hanger() {
    return hanger;
  },
  get climber() {
    return climber;
  },
  get roof() {
    return roof;
  },
  get upTop() {
    return upTop;
  },
  set upTop(value) {
    upTop = value;
  },
  get firstWelcome() {
    return firstWelcome;
  },
  get walking() {
    return !!errand;
  },
  builtFloors,
  theRoof,
  roofFloors,
  placeInCar,
  standUp,
  stopWalking,
  holsterGun,
  renderWake,
  liftOnto,
  syncVibesWatch,
  renderProject,
  syncStack,
  showElevator,
  clearLinkedWorker: () => {
    linkedWorker = undefined;
  },
  invalidateHint: () => {
    hintKey = 'stale';
  },
  lastSpot,
  rememberSpot,
});
const { takenAway, saveSpot, ride, switchFloor, travel, plainFloor, paintFloor, setPlace, arrive, noticeWaiting } = floorTravel;
// Closing the tab, or reloading: the frame loop saves it every second, and here's the last word.
window.addEventListener('pagehide', saveSpot);
// A brand-new floor can arrive before the elevator's list says what color it is.
store.on('floors', paintFloor);

function whereNow(): Spot | null {
  return floorTravel.whereNow();
}

function showElevator() {
  openElevator({ net, ride });
}

/** What you can use where you are, and what's in the way of looking at it. */
function usable(): Interactable[][] {
  return upTop && roof ? [roof.interactables] : [office.interactables, gallery.interactables];
}
// ---- Walking over to a spot -----------------------------------------------------------------------
/** What you're on your way to from the command palette: where to stand, what it's called, the pose to arrive in and what to do there. */
let errand: { at: { x: number; z: number }; what: string; pose?: ApproachPose; then: () => void; end?: (why: WalkEnd) => void } | null = null;
type WalkEnd = 'arrived' | 'cancelled' | 'stuck';

function stopWalking() {
  const e = errand;
  errand = null;
  player.stopWalking();
  e?.end?.('cancelled');
}

/** There: stop, and take the pose, pitch included. A desk arrives at DESK_LOOK_PITCH, not a fresh pitchToward. */
function arrivedAt(pose: ApproachPose) {
  stopWalking();
  player.facing = pose.facing;
  player.camYaw = pose.facing - Math.PI;
  player.lookPitch = pose.lookPitch;
}

player.onPathEnd = (why) => {
  if (errand) return errandEnd(why);
};

/**
 * Walks you over to `at` on this floor and does `then` when you get there. Where there's no walking
 * to be done (up on the roof, riding the elevator, on the ladder) it just does it.
 * A key of yours takes over, and then it doesn't happen. `end` hears how the walk ended.
 */
function walkThen(at: { x: number; y?: number; z: number }, what: string, then: () => void, pose?: ApproachPose, end?: (why: WalkEnd) => void) {
  const now = () => {
    then();
    end?.('arrived');
  };
  if (upTop || floorTravel.trip || climber.active) return now();
  closeAllModals();
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (errand) stopWalking();
  const to = { x: at.x, y: at.y ?? 0, z: at.z };
  const path = wayTo(player.pos, to);
  if (!path.length) return now();
  errand = { at, what, pose, then, end };
  toast(`🚶 Walking over to ${what}`);
  player.walkPath(path);
}

function errandEnd(why: WalkEnd) {
  const e = errand!;
  errand = null;
  if (why === 'cancelled') return e.end?.(why);
  if (why === 'stuck') toast(`🚧 Couldn't find a way over to ${e.what}, so here it is from where you are`, 'warn');
  else if (e.pose) arrivedAt(e.pose);
  else stopWalking();
  e.then();
  e.end?.(why);
}

// ---- Workers ------------------------------------------------------------------------------------
/** Something solid just came out right where you're standing (on the office floor, not down in the garage): you end up on top of it. */
function liftOnto(appeared: Collider[]) {
  const p = player.pos;
  for (const c of appeared) if (p.y > -0.1 && p.y < c.top && p.x > c.minX - 0.3 && p.x < c.maxX + 0.3 && p.z > c.minZ - 0.3 && p.z < c.maxZ + 0.3) p.y = c.top;
}
store.on('workers', syncWorkers);
store.on('missionControl', syncMissionControl);
store.on('visits', () => {
  visitors.sync(store.visits);
  renderWake();
});

store.on('visitSay', sayVisit);
store.on('pulls', paintPrs);

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

function hire(deskId: string, prompt?: string, worktree = false, model?: string, effort?: AgentEffort, issue?: number, repos?: string[], images?: string[], linear?: string) {
  const sent = net.send({ t: 'worker.spawn', deskId, prompt, worktree, model, effort, issue, linear, repos: repos?.length ? repos : undefined, images: images?.length ? images : undefined });
  // The moment notifications start to matter: ask once (it has to come from a key press or click).
  if (settings.notify && notifyPermission() === 'default' && !askedToNotify) {
    askedToNotify = true;
    void askNotifyPermission();
  }
  return sent;
}

/** The building's other projects a new worker can work in too, each in a worktree of its own (see WorkerInfo.repos). */
function repoChoices(): { id: string; name: string }[] {
  return otherRepos(store.floors, store.floor);
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
      worktreeOption: !store.currentFloor()?.home && !!store.project?.branch,
      imagesOption: true,
      deskId,
      repoOptions: repoChoices(),
      runsOn: runsOnPicker(),
      onCloud: (text, o) => hireCloud(net, deskId, text, o),
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
      recall: false,
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
    worktreeOption: !store.currentFloor()?.home && !!store.project?.branch,
    imagesOption: true,
    deskId,
    repoOptions: repoChoices(),
    runsOn: runsOnPicker(),
    onCloud: (text, o) => hireCloud(net, deskId, text, o),
    onSubmit: (text, o) => hire(deskId, text || undefined, o.worktree, o.model, o.effort, undefined, o.repos, o.images),
  });
}

/** The hire window at the nearest free desk, with a task to write this repository's worktree setup and open a pull request. */
function hireForWorktreeSetup() {
  const desk = nearestFreeDesk();
  if (!desk) return toast('Every desk on this floor is taken — send a worker home first', 'warn');
  if (officeIsFull()) return;
  const now = store.worktreeSetup ? describeSetup(store.worktreeSetup.resolved) : 'runs what the office detects from its lockfiles';
  openPrompt({
    title: `🌿 Set up worktrees at ${desk.label}`,
    subtitle: 'A worker writes this repository’s worktree setup, tests it, and opens a pull request with it. Pick its model, edit the task if you like, then hire.',
    warning: pressureNote(store.machine),
    initial: officePrompt('worktree.setup', { file: SETUP_FILE, include: INCLUDE_FILE, now, ...forgeVars(store.project?.forge) }),
    submitLabel: 'Hire & start',
    modelOption: true,
    worktreeOption: true,
    worktreeChecked: true,
    imagesOption: true,
    deskId: desk.id,
    onSubmit: (text, o) => hire(desk.id, text, o.worktree, o.model, o.effort, undefined, o.repos, o.images),
  });
}

function killWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.cloud) return sendCloudHome(net, w);
  const where = DESK_BY_ID.get(w.deskId)?.label ?? 'the desk';
  const session = w.kind === 'shell' ? 'shared shell' : 'Droid session';
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
  const body = `This stops the ${session} at ${where} for everyone and frees the desk.`;
  confirmDialog(`Send ${w.name} home?`, body, 'Send home', () => net.send({ t: 'worker.kill', workerId: id }));
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

/** Behind the worker, looking over their shoulder at the laptop. */
function standAt(desk: DeskDef) {
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (climber.active) climber.abort();
  if (errand) stopWalking();
  const pose = deskApproach(desk);
  player.pos.set(pose.at.x, pose.at.y, pose.at.z);
  player.vy = 0;
  player.facing = pose.facing;
  player.camYaw = pose.facing - Math.PI;
  player.lookPitch = pose.lookPitch;
}

// ---- Who's waiting on you: N, the count in the Workers panel, and the compass --------------------------
const nextUp = new NextUp();
const compass = new Compass($('compass'));
/** What the last press of N said, which the next press replaces. */
let nextToast: HTMLElement | null = null;

/** Everyone who waits on you here: this floor's workers, and the Orchestrator, which is on every floor. */
function waitingHere(): WorkerInfo[] {
  const o = orchestratorWaiting(store.missionControl);
  return o ? [...store.workers.values(), o] : [...store.workers.values()];
}

/** N: to the worker that has waited longest on someone, and on each press after, the next. */
function goToNextWaiting() {
  if (floorTravel.trip) return;
  const w = nextUp.next(waitingHere(), waitingBeside());
  const desk = w && DESK_BY_ID.get(w.deskId);
  const orchestrator = w?.id === ORCHESTRATOR_ID;
  nextToast?.remove();
  if (!w || (!desk && !orchestrator)) {
    const other = store.floors.find((f) => f.id !== store.floor && f.waiting > 0);
    nextToast = toast(other ? `🛗 Nobody's waiting on this floor. ${other.waiting} on the ${other.name} floor: take the elevator` : '👍 Nobody is waiting on you');
    return;
  }
  closeAllModals();
  if (desk) standAt(desk);
  else standAtOrchestrator();
  const waiting = waitingInOrder(waitingHere());
  const of = waiting.length > 1 ? ` (${waiting.findIndex((x) => x.id === w.id) + 1} of ${waiting.length})` : '';
  nextToast = toast(`${w.status === 'needs_input' ? `🙋 ${w.name} needs input` : `✅ ${w.name} is done`}${of}. ${orchestrator ? 'O' : 'E'} opens its terminal`);
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
  const o = mission.orchestrator;
  if (o && orchestratorWaiting(store.missionControl) && o.model.root.getWorldPosition(workerPos).distanceTo(player.pos) < bestD) best = ORCHESTRATOR_ID;
  return best;
}

/** On your feet beside the Orchestrator, looking up at it. */
function standAtOrchestrator() {
  if (player.seat) standUp();
  if (hanger.active) hanger.cancel();
  if (climber.active) climber.abort();
  if (errand) stopWalking();
  const pose = missionPose('orchestrator', ORCHESTRATOR_SPOT);
  player.pos.set(pose.at.x, pose.at.y, pose.at.z);
  player.vy = 0;
  aimAt(pose);
  renderWake();
}

/** Where you stand to talk to a building agent at (x, z), and how you look at it. */
function missionPose(kind: 'orchestrator' | 'bot', spot: { x: number; z: number }): ApproachPose {
  const { at, face } = missionStand({ kind, x: spot.x, z: spot.z });
  return { at, face, facing: facingToward(at, face), lookPitch: pitchToward({ x: at.x, y: at.y + player.eyeHeight, z: at.z }, face), pitchFixed: false };
}

function renderWaiting() {
  const waiting = waitingInOrder(waitingHere());
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
  if (!floorTravel.trip && !modalOpen()) {
    for (const w of store.workers.values()) {
      const v = workerViews.get(w.id);
      if (!v || !waitingOnSomeone(w)) continue;
      const at = v.model.root.getWorldPosition((heads[bearings.length] ??= new THREE.Vector3()));
      at.y += 1.2;
      bearings.push({ id: w.id, name: w.name, status: w.status, at });
    }
    const o = orchestratorWaiting(store.missionControl);
    const v = o && mission.orchestrator;
    if (o && v) {
      const at = v.model.root.getWorldPosition((heads[bearings.length] ??= new THREE.Vector3()));
      at.y += 1.4;
      bearings.push({ id: o.id, name: o.name, status: o.status, at });
    }
  }
  compass.update(camera, bearings, now);
}

/** A worker a link asked to open (`#worker=<id>&floor=<id>`, see worker-link.ts) until the office has it here. */
let linkedWorker = takeWorkerLink();

/** Reads a worker link from the address and takes it off, so a reload doesn't open the terminal again. */
function takeWorkerLink(): WorkerLink | undefined {
  const link = parseWorkerLink(location.hash);
  if (link) history.replaceState(history.state, '', location.pathname + location.search);
  return link;
}

// The Mac app's menu bar sets the hash of a page that is already open.
window.addEventListener('hashchange', () => {
  const link = takeWorkerLink();
  if (!link) return;
  linkedWorker = link;
  followWorkerLink();
});

/** Opens the linked worker's terminal, after a floorTravel.trip to its floor when it's on another one. */
function followWorkerLink() {
  const link = linkedWorker;
  if (!link || firstWelcome || floorTravel.trip) return;
  const step = linkStep(link, { floor: store.floor, hasWorker: (id) => !!anyWorker(id), hasFloor: (id) => store.floors.some((f) => f.id === id) });
  // The floor's arrival (floor.enter) comes back here.
  if (step === 'go' && link.floor) return switchFloor(link.floor);
  linkedWorker = undefined;
  if (step === 'open') openWorkerTerminal(link.worker);
  else toast('👋 That worker is no longer in the office', 'warn');
}

/** Opening a sleeping worker's terminal wakes it, so there's nothing to press first. */
function openWorkerTerminal(id: string, find?: TerminalFind) {
  if (id === ORCHESTRATOR_ID) return openOrchestratorTerminal(find);
  if (!store.workers.has(id) && missionWorker(store.missionControl, id)) return showBot(id);
  const w = store.workers.get(id);
  if (!w) return;
  if (w.cloud) return openCloudWindow(net, id);
  if (w.lost) return fixLostWorktree(w);
  if (isAsleep(w.status)) resumeWorker(w);
  openTerminal(net, id, () => openWorkerChanges(id), find);
}
onOpenTeammate((id) => openWorkerTerminal(id));

/** The Orchestrator's terminal, from any floor. Before its first prompt, or asleep, there's no session to show: its prompt box wakes it. */
function openOrchestratorTerminal(find?: TerminalFind) {
  if (!orchestratorAwake(store.missionControl)) return showOrchestrator();
  openTerminal(net, ORCHESTRATOR_ID, undefined, find);
}

/** E at the Orchestrator, M, the ☰ menu or the palette: its prompt box, or what stops it. */
function showOrchestrator() {
  openOrchestrator(net, { terminal: () => openOrchestratorTerminal(), settings: (pane = 'orchestrator') => showSettings(pane) });
}

/** M from anywhere: the Orchestrator's terminal while it waits on you, else its prompt box. */
function orchestratorKey() {
  if (orchestratorWaiting(store.missionControl)) openOrchestratorTerminal();
  else showOrchestrator();
}

/** E at a bot at the table: its card, whose team rows open a subagent here or after a ride to its floor. */
function showBot(id: string) {
  openBot(id, {
    openMember: (m) => {
      if (m.floor === store.floor) return openWorkerTerminal(m.id);
      linkedWorker = { worker: m.id, floor: m.floor };
      followWorkerLink();
    },
  });
}

/** 🔎 every terminal; a terminal line opens that terminal right at it. */
function showSearch() {
  openSearch(openWorkerTerminal);
}

/** What the worker changed: changed files, diff, commit / discard / open a PR; `repo` for another floor's repository it works in. */
function openWorkerChanges(id: string, repo?: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.cloud) return toast(cloudKeyNote(w), 'warn');
  if (w.lost) return fixLostWorktree(w);
  if (plainFloor()) return toast('This floor is a plain folder, not a git checkout, so there are no changes to show', 'warn');
  openChanges(net, id, () => openWorkerTerminal(id), repo);
}

/** The Pipelines window: on one run, or on its Run workflow form. */
function showPipelines(open: PipelinesOpen = {}) {
  openPipelines(net, open);
}

// ---- The command palette (Ctrl+K, ⌘K on a Mac) ------------------------------------------------------
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Where you stand to use something of this kind on this floor, like the Issues board. */
function spotOf(kind: InteractKind): Interactable | undefined {
  return office.interactables.find((it) => it.kind === kind && !it.off);
}

/** The free desk nearest you, for hiring from the palette. A bean bag counts once it's out. */
function nearestFreeDesk(): DeskDef | undefined {
  let best: DeskDef | undefined;
  let bestD = Infinity;
  for (const d of [...DESKS, ...BEANBAGS]) {
    if (store.workerAtDesk(d.id)) continue;
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
    const pose = desk && deskApproach(desk);
    const open = () => openWorkerTerminal(w.id);
    out.push({
      icon: w.kind === 'shell' ? '🐚' : w.cloud ? '☁️' : '🧑‍💻',
      kind: 'Worker',
      title: w.name,
      detail: [w.task?.name, desk?.label, STATUS_LABEL[w.status] ?? w.status, w.cloud && cloudBadge(w.cloud)].filter(Boolean).join(' · '),
      keywords: [w.title, w.worktree?.branch],
      open,
      walk: desk && pose ? () => walkThen(pose.at, `${w.name} at ${desk.label}`, open, pose) : undefined,
    });
  }

  const mc = store.missionControl;
  if (mc) {
    const o = orchestratorWorker(mc);
    const pose = missionPose('orchestrator', ORCHESTRATOR_SPOT);
    out.push({
      icon: '🛰️',
      kind: 'Building agent',
      title: o?.name ?? ORCHESTRATOR_NAME,
      detail: orchestratorLine(mc),
      keywords: ['orchestrator', 'mission control', 'building agent', 'lead', 'every floor'],
      open: showOrchestrator,
      walk: () => walkThen(pose.at, 'the Orchestrator', showOrchestrator, pose),
    });
    for (const b of mc.bots) {
      const v = mission.views.get(b.worker.id);
      const botPose = v && missionPose('bot', v.it);
      const open = () => showBot(b.worker.id);
      out.push({
        icon: '🤖',
        kind: 'Building agent',
        title: b.worker.name,
        detail: [botLine(b), missionTeamLine(b.team)].filter(Boolean).join(' · '),
        keywords: ['mission control', 'tailscale', 'mcp', 'bot'],
        open,
        walk: botPose ? () => walkThen(botPose.at, b.worker.name, open, botPose) : undefined,
      });
    }
  }

  const free = nearestFreeDesk();
  const hirePose = free && deskApproach(free);
  const hireAt = (d: DeskDef) => () => hireAtDesk(d.id);
  out.push({
    icon: '✨',
    kind: 'Action',
    title: 'Hire a worker',
    detail: free ? `At ${free.label}, the free desk nearest you` : 'Every desk is taken',
    keywords: ['new worker', 'spawn an agent'],
    open: free ? hireAt(free) : () => toast('Every desk on this floor is taken', 'warn'),
    walk: free && hirePose ? () => walkThen(hirePose.at, free.label, hireAt(free), hirePose) : undefined,
  });
  out.push({ icon: '⚙️', kind: 'Action', title: 'Settings', keywords: ['preferences', 'options'], open: () => showSettings() });
  out.push({ icon: '📱', kind: 'Action', title: 'Pair a phone', detail: 'Droid Office for Android', keywords: ['android', 'mobile', 'qr code', 'tailscale'], open: () => openPhone() });
  out.push({ icon: '🌐', kind: 'Action', title: 'Web companion', detail: 'The office in a desktop browser', keywords: ['dashboard', 'browser', 'web server', 'url', 'link', 'tailscale', 'localhost', 'remote'], open: () => openCompanion() });
  out.push({ icon: '🖼️', kind: 'Action', title: 'Hang a picture', detail: 'On a wall of this floor', keywords: ['decorate', 'frame', 'art'], open: startHanging });
  out.push({ icon: '🔎', kind: 'Action', title: 'Search every terminal', keywords: ['find'], open: showSearch });
  const prWord = words().pr;
  const git = !plainFloor();
  if (git) out.push(atSpot('issues', 'the Issues board', { icon: '📌', kind: 'Board', title: 'Issues board', open: () => openBoard('issues', net, boardActions()) }));
  if (git) out.push(atSpot('pulls', `the ${prWord} board`, { icon: '🔀', kind: 'Board', title: `${prWord} board`, keywords: ['pull requests', 'merge requests'], open: () => openBoard('pulls', net, boardActions()) }));
  if (git)
    out.push(
      atSpot('actions', 'the Pipelines board', {
        icon: '🚀',
        kind: 'Board',
        title: 'Pipelines board',
        detail: pipelinePolicy(store.project?.forge).copy.paletteDetail,
        keywords: ['ci', 'actions', 'workflows', 'pipelines', 'builds', 'runs'],
        open: () => showPipelines(),
      }),
    );
  if (git)
    out.push(
      atSpot('actions', 'the Pipelines board', {
        icon: '▶',
        kind: 'Action',
        title: pipelinePolicy(store.project?.forge).copy.runAction,
        detail: 'Start CI by hand on a branch',
        keywords: ['kick off', 'dispatch', 'trigger', 'ci', 'deploy', 'release'],
        open: () => showPipelines({ run: true }),
      }),
    );
  if (git && store.factory.connection.connected) {
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
        title: 'Add Droid code review',
        detail: 'Factory opens a pull request in this floor’s repository',
        keywords: ['factory', 'ci', 'github actions', 'workflow'],
        open: () => showCi(true),
      }),
    );
  }
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
  out.push(atSpot('bookshelf', 'the bookshelf', { icon: '📚', kind: 'Board', title: 'Bookshelf', detail: "The project's docs", keywords: ['docs', 'readme', 'markdown'], open: () => showBookshelf() }));
  out.push(
    atSpot('bookshelf', 'the bookshelf', { icon: '🏭', kind: 'Board', title: 'AutoWiki', detail: "Factory's wiki of this repository, on the bookshelf", keywords: ['wiki', 'factory', 'documentation'], open: () => showBookshelf('wiki') }),
  );
  {
    const sw = vibesSwitchStateNow();
    const detail =
      sw === 'on'
        ? `On${store.vibes ? ` · ${FLOOR_MOOD_LIGHTING[store.vibes.mood]?.label ?? 'active'}` : ''}`
        : sw === 'off'
          ? 'Off · Living 3D pulses paused'
          : sw === 'rejected'
            ? 'Key rejected · fix in Settings'
            : sw === 'airgapped'
              ? 'Unavailable in airgapped mode'
              : 'Connect Gemini Decisions API in Settings';
    out.push(
      atSpot('vibes', 'the Living 3D switch', {
        icon: sw === 'on' ? '🟢' : sw === 'off' ? '🔴' : '✨',
        kind: 'Action',
        title: 'Living 3D reactions & mood lighting',
        detail,
        keywords: ['gemini', 'decisions', 'mood', 'lighting', 'vibes', 'switch', 'button', 'pedestal'],
        open: () => useVibesSwitch('E'),
      }),
    );
  }

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
  for (const t of store.linearBoard?.items ?? []) {
    out.push(
      atSpot('issues', 'the Issues board', {
        icon: '◆',
        kind: 'Linear ticket',
        title: `${t.identifier} ${t.title}`,
        detail: [t.state.name, t.worker ? `with ${t.worker.name}` : (t.assignee ?? 'unassigned'), ...t.labels.map((l) => l.name)].join(' · '),
        keywords: ['linear'],
        open: () => openLinearTicket(t, boardActions()),
      }),
    );
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

function showBookshelf(tab?: ShelfTab) {
  if (!store.floor) return toast('Take the elevator to a floor first');
  openBookshelf({ floor: store.floor, project: store.project?.name, blob: blobBase(), onTurn: turnPage, tab, openFactorySettings: () => showSettings('connections') });
}

// The bookshelf's AutoWiki volumes: there once Factory has a wiki of this floor's repository, a
// "writing" label while /wiki runs. Set only when that changes, not on every Factory broadcast.
let shelfWiki = '';
const paintShelfWiki = () => {
  const f = store.floor ? store.factory.wiki.floors[store.floor] : undefined;
  const job = f?.job?.state;
  const next = job === 'starting' || job === 'running' ? 'writing' : f?.latest ? 'wiki' : 'none';
  if (next === shelfWiki) return;
  shelfWiki = next;
  office.setShelfWiki(next);
};
store.on('factory', paintShelfWiki);
store.on('floor', paintShelfWiki);

/** You turned a page on the bookshelf: so does the book in your hands, for everyone watching it too. */
function turnPage() {
  me.turnPage();
  hands.turnPage();
}

/** A prompt from the boards goes to a new worker at a free desk, or to one already at a desk. With `issue`, that worker takes the issue, as with a carried card; with `linear`, that Linear ticket. */
function sendToWorker(title: string, text: { context?: string; initial?: string }, issue?: number, linear?: string) {
  const desk = freeDesk();
  const awake = [...store.workers.values()].filter((w) => (w.kind === 'agent' || (w.kind === 'cloud' && !w.cloud?.error)) && !isAsleep(w.status));
  if (!desk && !awake.length) {
    toast('Every desk and bean bag is taken — send a worker home first', 'warn');
    return;
  }
  openAsk({
    title,
    ...text,
    newDesk: desk ? DESK_BY_ID.get(desk)!.label : undefined,
    workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status })),
    worktreeOption: !store.currentFloor()?.home && !!store.project?.branch,
    modelOption: true,
    repoOptions: repoChoices(),
    onSubmit: (prompt, to, worktree, model, effort, repos, images) => {
      if (to) net.send({ t: 'worker.prompt', workerId: to, prompt, issue, linear, images: images?.length ? images : undefined });
      else if (desk) hire(desk, prompt, worktree, model, effort, issue, repos, images, linear);
    },
  });
}

function boardActions() {
  return {
    assign: (prompt: string, title: string, issue?: number, linear?: string) => sendToWorker(`🤖 ${title}`, { initial: prompt }, issue, linear),
    ask: (context: string, title: string) => sendToWorker(`✍️ ${title}`, { context }),
    goToDesk,
    pickUp,
  };
}

/** `note` is the issue note you're pointing at on the issues board, if any (see aimedNote); `spot` the tab or Jira card (see aimedSpot). */
function interact(target: Interactable | null, key: DeskKey, note = aimedNote, spot = aimedSpot) {
  if (!target) return;
  if (target.kind !== 'issues') {
    note = null;
    spot = null;
  }
  if (key === 'E' && carrying && dropCard(target, carrying, note)) return;
  if (useSpot(spot, key)) return;
  if (target.kind === 'desk' && target.deskId) {
    const w = store.workerAtDesk(target.deskId);
    if (key === 'B' && !w) return openShell(target.deskId);
    if (key === 'P') return promptAtDesk(target.deskId);
    if (key === 'E') return w ? openWorkerTerminal(w.id) : hireAtDesk(target.deskId);
    if (key === 'C' && w) return openWorkerChanges(w.id);
    if (key === 'R' && w && isAsleep(w.status)) return resumeWorker(w);
    if (key === 'X' && w) return killWorker(w.id);
    if (key === 'O' && w) return pullRequestFor(w);
    return;
  }
  if (target.kind === 'orchestrator') return useOrchestrator(key);
  if (target.kind === 'vibes') return useVibesSwitch(key);
  if (target.kind === 'bot' && target.agentId) {
    if (key === 'E') showBot(target.agentId);
    return;
  }
  // A note on the issues board: E takes it straight off the cork, O opens it to read first.
  if (note && key === 'E') return pickUp(note);
  if (note && key === 'O') return openIssue(note, net, boardActions());
  if (key !== 'E') return;
  if (openPane(target, aimedRun)) return;
  if (target.kind === 'seat' && target.seatId) useSeat(target.seatId);
  else if (target.kind === 'gong') hitGong();
  else if (target.kind === 'ladder') grabLadder();
}

/** At the Orchestrator: E talks to it, O opens its terminal, X stops its turn. */
function useOrchestrator(key: DeskKey) {
  if (key === 'E') return showOrchestrator();
  if (key === 'O') return openOrchestratorTerminal();
  const w = orchestratorAwake(store.missionControl);
  if (key === 'X' && w && isBusy(w.status)) stopOrchestrator(net, w.name);
}

/** Opening a pane is safe from across the room; physical controls still need a nearby E. */
function openPane(target: Interactable, runId?: number): boolean {
  if (target.off) return false;
  if (target.kind === 'elevator') showElevator();
  else if (target.kind === 'issues') openBoard('issues', net, boardActions(), issuesTex.tab);
  else if (target.kind === 'pulls') openBoard('pulls', net, boardActions());
  else if (target.kind === 'computers') showComputers();
  else if (target.kind === 'actions') showPipelines(runId !== undefined ? { runId } : {});
  else if (target.kind === 'ci') showCi();
  else if (target.kind === 'whiteboard') openWhiteboard(net, { card: wallCard()?.id });
  else if (target.kind === 'jukebox') showJukebox();
  else if (target.kind === 'bookshelf') showBookshelf();
  else if (target.kind === 'decor' && target.decorId) hanger.view(target.decorId);
  else return false;
  return true;
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
  toast(`✋ You took #${it.number} off the board: take it to an empty desk or a worker and press E`);
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
 * to a worker uses), an agent at a desk gets it as its next prompt, and the issues board takes it back (or swaps it for the `note` you point at there). False when it's none
 * of those, so E does what it always does there.
 */
function dropCard(it: Interactable, card: CarriedIssue, note: GhIssue | null): boolean {
  if (it.kind === 'issues') {
    if (note) pickUp(note);
    else putBack();
    return true;
  }
  const prompt = issuePrompt({ number: card.issue, title: card.title });
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

/** The card left your hands for a desk (the office says who took it). */
function putDown() {
  setCarrying(null);
  sound.paper();
}

/** Why the worker at a desk can't be handed an issue card right now, or '' when it can. */
function cantTakeCard(w: WorkerInfo): string {
  if (w.kind === 'shell') return `${w.name} is a shell, not an agent`;
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

/** E at a seat: sit down on it. Sitting there already, get up (or open the shell, in the boss's chair). */
function useSeat(seatId: string) {
  const seat = SEATING_BY_ID.get(seatId);
  if (!seat) return;
  if (player.seat?.seatId === seatId) {
    if (seat.shell) openOfficeShell(net);
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

// ---- The Living 3D reactions & mood lighting pedestal switch --------------------------------------
const vibesToggle = new VibesSwitchToggle();

function vibesSwitchStateNow() {
  return resolveVibesSwitchState(store.gemini, { airgapped: store.setup.airgapped });
}

function syncVibesSwitch() {
  office.vibesSwitch.setState(vibesSwitchStateNow());
  hintKey = '';
  activeAt = performance.now();
  renderWake();
}

function useVibesSwitch(key: DeskKey) {
  if (key === 'O') {
    showSettings(undefined, 'Gemini Decisions API');
    return;
  }
  if (key !== 'E') return;
  const now = performance.now();
  const outcome = vibesToggle.press(store.gemini, { airgapped: store.setup.airgapped, netUp: net.up });
  if (outcome.kind === 'open-settings') {
    office.vibesSwitch.press('blocked');
    sound.vibesSwitch('blocked');
    activeAt = now;
    renderWake();
    showSettings(undefined, 'Gemini Decisions API');
    return;
  }
  if (outcome.kind === 'offline') {
    office.vibesSwitch.press('blocked');
    sound.vibesSwitch('blocked');
    activeAt = now;
    renderWake();
    toast('Reconnecting to the office — try again in a moment', 'warn');
    return;
  }
  if (outcome.kind === 'busy') {
    office.vibesSwitch.depress();
    sound.vibesSwitch('blocked');
    activeAt = now;
    renderWake();
    return;
  }
  office.vibesSwitch.depress();
  sound.vibesSwitch('press');
  hintKey = '';
  activeAt = now;
  renderWake();
  void net.request({ t: 'gemini.vibes', on: outcome.target }, 5000).then((receipt) => {
    const settled = vibesToggle.settle(outcome.token, receipt, store.gemini, { airgapped: store.setup.airgapped });
    hintKey = '';
    if (settled.kind === 'stale') return;
    office.vibesSwitch.setState(settled.state);
    activeAt = performance.now();
    renderWake();
    if (settled.kind === 'confirmed') {
      office.vibesSwitch.ripple(settled.state);
      sound.vibesSwitch(settled.state);
      toast(settled.state === 'on' ? '🟢 Living 3D reactions & mood lighting on' : '🔴 Living 3D reactions & mood lighting off');
      return;
    }
    office.vibesSwitch.ripple('blocked');
    sound.vibesSwitch('blocked');
    if (settled.error && (!net.up || /not confirm|timed out|Disconnected|active floor changed/i.test(settled.error))) {
      toast(settled.error, 'warn');
    }
  });
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
}

/** Where confetti rains from downstairs over (x, z): the ceiling, or under the loft, the underside of its floor. */
function ceilingOver(x: number, z: number): number {
  const loft = x > LOFT.minX && x < LOFT.maxX && z > LOFT.minZ && z < LOFT.maxZ;
  return loft ? LOFT.y - 0.35 : WALL_HEIGHT - 0.1;
}
/** Confetti a square meter of floor gets when a pull request merges. */
const CONFETTI_DENSITY = 3.5;
const floorArea = (a: Area) => (a.maxX - a.minX) * (a.maxZ - a.minZ);

/** When the gong was last struck. The swing is part of the render pace (see render-pace.ts). */
let gongStruckAt = 0;

/** Someone hit the gong, or a pull request merged (a dance party under a confetti rain). */
function gongRang(why: GongWhy, pr?: number) {
  gongStruckAt = performance.now();
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
  if (sidearm.gunOut && !modalOpen()) return renderGunHint(el);
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
    case 'issues':
      if (aimedSpot?.kind === 'tab') {
        const label = aimedSpot.tab === 'jira' ? `🎫 Jira · ${store.jiraBoard?.epic ?? 'epic'}` : aimedSpot.tab === 'linear' ? `◆ Linear · ${store.linearBoard?.team ?? 'team'}` : `📌 ${words().site} issues`;
        return { k: `tab:${aimedSpot.tab}:${issuesTex.tab}`, parts: issuesTex.tab === aimedSpot.tab ? [title(label), aside('showing')] : [title(label), key('E', 'Show it')] };
      }
      if (aimedSpot?.kind === 'ticket') {
        const ticketKey = aimedSpot.key;
        if (issuesTex.tab === 'linear') {
          const t = store.linearBoard?.items.find((x) => x.identifier === ticketKey);
          return { k: `ticket:${ticketKey}`, parts: [title(clip(`◆ ${ticketKey} ${t?.title ?? ''}`, 60)), key('E', 'Read it'), ...(t?.worker ? [aside(`with ${t.worker.name}`)] : [])] };
        }
        const t = store.jiraBoard?.items.find((x) => x.key === ticketKey);
        return { k: `ticket:${ticketKey}`, parts: [title(clip(`🎫 ${ticketKey} ${t?.summary ?? ''}`, 60)), key('E', 'Read it')] };
      }
      if (issuesTex.tab === 'jira') return board(`🎫 Jira · ${store.jiraBoard?.epic ?? 'epic'}`);
      if (issuesTex.tab === 'linear') return board(`◆ Linear · ${store.linearBoard?.team ?? 'team'}`);
      if (aimedNote) return { k: String(aimedNote.number), parts: [title(clip(`📌 #${aimedNote.number} ${aimedNote.title}`, 60)), key('E', 'Take it'), key('O', 'Read it')] };
      return issuesTex.hasNotes ? { k: 'notes', parts: [title('📌 Issues board'), key('E', 'Open'), aside('or point at a note to take it')] } : board('📌 Issues board');
    case 'pulls':
      return board('🔀 Pull request board');
    case 'ci': {
      const ci = store.factory.ci;
      const n = ciForFloor(ci, floorGithubRepo()).workflows.length;
      const about = !store.factory.connection.connected ? 'connect Factory first' : n ? `${n} Droid workflow${n === 1 ? '' : 's'}` : ci.fetchedAt ? 'no Droid workflows yet' : '';
      return { k: about, parts: [title('🏭 CI automations'), about ? aside(about) : '', key('E', 'Open')] };
    }
    case 'whiteboard': {
      const board = floorWhiteboard();
      const card = wallCard();
      const sum = board && gridSummary(board);
      const about = card ? clip(card.title || 'Untitled', 40) : sum ? (sum.changed ? `${sum.cards} · ${sum.changed} changed` : board.cards.length ? sum.cards : 'nothing on it yet') : '';
      return { k: about, parts: [title('🗒️ Whiteboard'), about ? aside(about) : '', key('E', card ? 'Open this card' : 'Open')] };
    }
    case 'computers': {
      const about = computeWall.view ? wallSummary(computeWall.view) : '';
      return { k: about, parts: [title('🖥️ Compute wall'), aside(about), key('E', 'Open the Computers')] };
    }
    case 'actions': {
      const p = store.pipelines;
      const run = aimedRun !== undefined ? p.runs.find((r) => r.id === aimedRun) : undefined;
      if (run) return { k: `run:${run.id}:${run.state}`, parts: [title(clip(`🚀 ${run.workflow} #${run.number} · ${run.title}`, 60)), aside(stateWord(run)), key('E', 'Open the run')] };
      const live = p.runs.filter((r) => isLive(r.state)).length;
      const about = p.error ? "can't read the runs" : live ? `${live} running or waiting` : p.runs.length ? 'all quiet' : '';
      return { k: about, parts: [title(pipelinePolicy(store.project?.forge).copy.hint), about ? aside(about) : '', key('E', 'Open')] };
    }
    case 'gong':
      return { k: '', parts: [title('🎉 Merge gong'), aside('rings when a PR merges'), key('E', 'Bang it')] };
    case 'vibes': {
      const state = vibesSwitchStateNow();
      if (state === 'airgapped') {
        return { k: 'airgapped', parts: [title('✨ Living 3D · unavailable'), aside('airgapped mode is on'), key('E', 'Settings')] };
      }
      if (state === 'disconnected') {
        return { k: 'disconnected', parts: [title('✨ Living 3D · not connected'), aside('needs Gemini Decisions API'), key('E', 'Connect in Settings')] };
      }
      if (state === 'rejected') {
        return { k: `rejected|${store.gemini.rejected}`, parts: [title('⚠️ Living 3D · key rejected'), aside('paused until key is fixed'), key('E', 'Fix in Settings')] };
      }
      const pending = vibesToggle.pendingTarget;
      if (pending !== null) {
        const label = state === 'on' ? '🟢 Living 3D · ON' : '🔴 Living 3D · OFF';
        return { k: `pending|${state}|${pending}`, parts: [title(label), aside(pending ? 'switching on…' : 'switching off…'), key('O', 'Settings')] };
      }
      if (state === 'on') {
        const mood = store.vibes ? FLOOR_MOOD_LIGHTING[store.vibes.mood]?.label : undefined;
        const about = mood ?? 'reactions & mood lighting';
        return { k: `on|${about}`, parts: [title('🟢 Living 3D · ON'), aside(about), key('E', 'Turn off'), key('O', 'Settings')] };
      }
      return { k: 'off', parts: [title('🔴 Living 3D · OFF'), aside('Living 3D pulses paused'), key('E', 'Turn on'), key('O', 'Settings')] };
    }
    case 'jukebox': {
      const j = store.jukebox;
      const what = j.on ? trackTitle(j) : '';
      return { k: `${j.on}|${what}`, parts: [title('🎵 Jukebox'), aside(j.on ? `♪ ${clip(what, 40)}` : 'off'), key('E', j.on ? 'Change the song' : 'Put on a song')] };
    }
    case 'bookshelf': {
      const wiki = store.factory.connection.connected && store.floor ? wikiShelfLine(store.factory.wiki.floors[store.floor]) : '';
      return { k: wiki, parts: [title('📚 Bookshelf'), aside(wiki ? `the project's docs · ${wiki}` : "the project's docs"), key('E', 'Read the docs')] };
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
        if (seat.shell) return { k: `${seat.id}|sitting|shell`, parts: [title(seat.label), aside('sitting'), key('E', 'Open the shell'), key('W A S D', 'Get up')] };
        return { k: `${seat.id}|sitting`, parts: [title(seat.label), aside('sitting'), key('E', 'Get up')] };
      }
      const full = !freePlace(seat);
      return { k: `${seat.id}|${full}`, parts: [title(seat.label), seat.shell ? aside('shell on the laptop') : '', full ? aside('no room') : key('E', 'Sit down')] };
    }
    case 'orchestrator':
      return orchestratorHint();
    case 'bot':
      return botHint(it.agentId ?? '');
    case 'ladder': {
      const up = floorThere(1)?.name;
      const down = floorThere(-1)?.name;
      const where = [up && `⬆ ${up}`, down && `⬇ ${down}`].filter(Boolean).join(' · ');
      return { k: where, parts: [title('🪜 Ladder'), aside(where || 'no other floors yet'), key('E', 'Climb on')] };
    }
  }
}

/** At the Orchestrator: what it's doing and its team, and E, O and X. */
function orchestratorHint(): Hint {
  const mc = store.missionControl;
  const title = (text: string) => h('span.title', {}, text);
  if (!mc) return { k: 'none', parts: [title('🛰️ Orchestrator'), aside('restart the office to get one')] };
  const phase = orchestratorPhase(mc);
  if (phase === 'off') return { k: 'off', parts: [title('🛰️ Orchestrator · off'), aside('directs workers on every floor'), key('E', 'Turn it on')] };
  if (phase === 'blocked') return { k: `blocked|${mc.orchestrator.blocked}`, parts: [title("🛰️ Orchestrator · can't start"), aside(clip(mc.orchestrator.blocked ?? '', 56)), key('E', 'See why')] };
  const w = orchestratorWorker(mc)!;
  const started = !!orchestratorAwake(mc);
  const busy = isBusy(w.status);
  const doing = phase === 'fresh' ? 'ready for a task anywhere in the building' : clip(workerActivity(w) ?? w.task?.name ?? '', 48);
  const team = missionTeamLine(mc.orchestrator.team) ?? '';
  return {
    k: ['orch', w.name, phase, doing, team, busy].join('|'),
    parts: [title(`🛰️ ${w.name} · ${PHASE_WORD[phase]}`), doing ? aside(doing) : '', team ? aside(team) : '', key('E', busy ? 'Steer or queue' : 'Prompt'), started ? key('O', 'Terminal') : '', busy ? key('X', 'Stop') : ''],
  };
}

/** At an external bot: what it last reported, and its team. */
function botHint(id: string): Hint {
  const b = store.missionControl?.bots.find((x) => x.worker.id === id);
  if (!b) return { k: '', parts: [] };
  const team = missionTeamLine(b.team) ?? '';
  const doing = clip(botLine(b), 48);
  return { k: ['bot', id, b.worker.name, b.worker.status, doing, team].join('|'), parts: [h('span.title', {}, `🤖 ${b.worker.name} · external`), aside(doing), team ? aside(team) : '', key('E', 'Details')] };
}

/** With an issue card in your hands: what E does with it here, and how to put it back. */
function carryHint(card: CarriedIssue, it: Interactable | null): Hint {
  const parts = (...mid: (HTMLElement | string)[]) => [h('span.title', {}, `🗂️ #${card.issue} in hand`), ...mid, key('Q', 'Put it back')];
  if (it?.kind === 'issues') return aimedNote ? { k: String(aimedNote.number), parts: parts(key('E', `Swap it for #${aimedNote.number}`)) } : { k: '', parts: parts(key('E', 'Pin it back up')) };
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
  return { k: '', parts: parts(aside('take it to an empty desk or a worker')) };
}

function deskHint(deskId: string): Hint {
  const w = store.workerAtDesk(deskId);
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
  if (w.lost && w.worktree) {
    return {
      k: `lost|${w.id}|${w.lost.branch}`,
      parts: [h('span.title', {}, `${w.name} · 🌿 worktree deleted`), aside('deleted outside droid-office'), key('E', 'Fix it'), key('X', 'Send home')],
    };
  }
  if (w.cloud) {
    const doing = w.cloud.error ? `⚠️ ${clip(w.cloud.error, 48)}` : w.activity ? clip(w.activity, 48) : '';
    const credits = creditsNote(store.factory.sessions, w.sessionId);
    return {
      k: `cloud|${w.id}|${w.status}|${doing}|${cloudLine(w)}|${credits}`,
      parts: [
        h('span.title', {}, `${w.name} · ${STATUS_LABEL[w.status]}`),
        credits ? h('span.cost', { title: 'Factory credits its Droid session (and its subagents) used' }, credits) : '',
        aside(cloudLine(w)),
        doing ? aside(doing) : '',
        key('E', 'Open'),
        key('P', 'Prompt'),
        key('X', 'Send home'),
      ],
    };
  }
  const doing = w.activity ? clip(w.activity, 48) : '';
  const shell = w.kind === 'shell';
  const team = teamNote(w);
  const credits = creditsNote(store.factory.sessions, w.sessionId);
  return {
    k: w.status + w.id + (w.pr?.number ?? '') + (w.repos?.map((r) => r.pr?.number ?? '-').join() ?? '') + (w.prOpening ? '!' : '') + doing + team + credits,
    parts: [
      h('span.title', {}, `${w.name} · ${STATUS_LABEL[w.status]}`),
      credits ? h('span.cost', { title: 'Factory credits its Droid session (and its subagents) used' }, credits) : '',
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

/**
 * The hint's word on a worker's team: what its markings say ("Team lead", "Ada's team · Follower",
 * "Ada's team · Lead has left") with the team's emblem, and how a lead's subagents are doing.
 */
function teamNote(w: WorkerInfo): string {
  const standing = teamStanding(w, anyWorker);
  const summary = teamSummary(store.teamOf(w.id));
  if (standing) return [`${TEAM_MARK[standing.badge.emblem]} ${standing.label}`, summary].filter(Boolean).join(' · ');
  const lead = w.lead ? anyWorker(w.lead) : undefined;
  if (lead) return `🧭 ${lead.name}'s subagent`;
  return summary ?? '';
}

/** The O in the desk hint of a worker across repositories: its pull requests so far, or opening them. */
function reposKey(w: WorkerInfo) {
  const repos = workerRepos(w);
  const prs = repos.filter((r) => r.pr).length;
  if (w.prOpening) return aside('⏳ Opening PRs…');
  if (prs) return key('O', `${prs} of ${repos.length} PRs`);
  return prReady(w) ? key('O', `Open PRs (${repos.length} repos)`) : '';
}

/** The spells on 1–5 as the hint and the wheel name them: Lumos is Nox while it's lit. */
function wandSpells() {
  return WAND_SPELLS.map((x) => (x.id === 'lumos' && sidearm.lumos ? { ...x, emoji: '🌑', label: 'Nox' } : x));
}
/** The tricks (with the gun) or spells (with the wand) on 1–6, in key order. */
const armMoves = (): readonly { id: string; emoji: string; label: string }[] => (sidearm.drawnArm === 'wand' ? wandSpells() : GUN_TRICKS);

/** The gun (or the wand) out: fire it, or put it back. */
function renderGunHint(el: HTMLElement) {
  const wand = sidearm.drawnArm === 'wand';
  const now = wand ? wandMotion.doing : gunMotion.doing;
  const doing = now === 'cast' ? { id: 'cast', emoji: '✨', label: 'Casting' } : armMoves().find((x) => x.id === now);
  const k = `gun|${doing?.id ?? ''}|${sidearm.drawnArm}|${sidearm.lumos}`;
  if (k === hintKey) return;
  hintKey = k;
  const a = arms();
  const title = doing ? `${doing.emoji} ${doing.label}` : wand && sidearm.lumos ? '🪄 Wand · 💡 Lumos' : a.name;
  el.replaceChildren(h('span.title', {}, title), key('Click', a.fire), key('Hold', 'Charge'), key(wand ? '1–5' : '1–6', wand ? 'Spells' : 'Tricks'), key('7', a.away));
  el.classList.remove('hidden');
}
/** On the ladder: which way it goes from here, and how to get off. */
function renderClimbHint(el: HTMLElement) {
  const title = (text: string) => h('span.title', {}, text);
  const l = climber.ladder;
  if (!l) return;
  const up = floorThere(1)?.name;
  const down = floorThere(-1)?.name;
  const atFloor = l.y < 0.4 && l.y > -0.05;
  const busy = l.waiting || l.auto;
  const k = `ladder|${up}|${down}|${atFloor}|${busy}`;
  const parts = busy ? [title('🪜 Climbing…')] : [title('🪜 On the ladder'), up ? key('W', `Up to ${up}`) : aside('top floor'), key('S', down ? `Down to ${down}` : atFloor ? 'Step off' : 'Down'), key('E', atFloor ? 'Step off' : 'Let go')];
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
  const show = !modalOpen();
  const free = show && finePointer && player.canLock && !player.locked;
  const k = `${show}|${!!target}|${free}|${relookOnKey}|${sidearm.gunOut}`;
  if (k === crossKey) return;
  crossKey = k;
  const el = $('crosshair');
  el.classList.toggle('hidden', !show);
  el.classList.toggle('on', !!target);
  el.classList.toggle('armed', sidearm.gunOut);
  el.classList.toggle('free', free);
  el.querySelector('.look-hint')!.textContent = relookOnKey ? 'Press a key or click to look around' : 'Click to look around';
}

// ---- Reaching out ---------------------------------------------------------------------------------
/** Plays the reach on your hands and your character. */
function reach() {
  hands.reach();
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
  popEmoji(id);
}
/** Number `i` on the keys (0 for 1) and round the wheel: a trick with the gun out, else an emote. */
function emoteOrTrick(i: number) {
  if (sidearm.gunOut && sidearm.drawnArm === 'wand') {
    const spell = WAND_SPELLS[i];
    if (spell) wandSpell(spell.id);
    return;
  }
  if (sidearm.gunOut) return gunTrick(GUN_TRICKS[i].id);
  emote(EMOTES[i].id);
}
const emoteWheel = new EmoteWheel(
  emoteOrTrick,
  (open) => (player.mouseLook = !open),
  () => (sidearm.gunOut ? { title: sidearm.drawnArm === 'wand' ? 'Spell' : 'Trick', items: [...armMoves()] } : { title: 'Emote', items: EMOTES }),
);
$('hud').append(emoteWheel.el);

/** In first person you can't see the emoji over your head, so it pops up on the screen instead. */
function popEmoji(id: EmoteId) {
  const e = EMOTE_BY_ID.get(id)!;
  document.querySelector('.emote-pop')?.remove();
  const el = h('div.emote-pop', { style: `--secs:${e.seconds}s`, 'aria-hidden': 'true' }, e.emoji);
  el.addEventListener('animationend', () => el.remove());
  $('hud').append(el);
}

/**
 * G opens the emote wheel (hold it and point, or tap it and click); 1–6 play one straight away.
 * With the gun out they're its tricks instead.
 */
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
  // A held key doesn't machine-gun tricks: each press is one.
  if (!(sidearm.gunOut && e.repeat)) emoteOrTrick(Number(n[1]) - 1);
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
window.addEventListener('keydown', (e) => floorShortcut(e, store.floors, (floor) => switchFloor(floor, true)), true);
window.addEventListener(
  'keydown',
  (e) => {
    if (!store.floor || upTop || floorTravel.trip || climber.active || hanger.active) return;
    if (modalOpen() ? !terminalOnTop() : isTyping(e)) return;
    terminalShortcut(e, (direction) => {
      const o = orchestratorAwake(store.missionControl);
      const id = nextTerminal(o ? [...store.workers.values(), o] : store.workers.values(), openTerminalFor(), direction);
      if (id === OFFICE_SHELL_ID) openOfficeShell(net);
      else openWorkerTerminal(id);
    });
  },
  true,
);
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
  // 7 draws and holsters the wand or the .44 Magnum (1–6 are emotes).
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
      openHelp(settings.sidearm);
      return true;
    case 'KeyF':
      startHanging();
      return true;
    case 'KeyN':
      goToNextWaiting();
      return true;
    case 'KeyM':
      orchestratorKey();
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
  if (open && errand && !floorTravel.trip) stopWalking();
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

/** Once the last window is closed, the game has the keyboard again and the mouse. */
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

// ---- Clicking the world: use what's under the crosshair ----------
const raycaster = new THREE.Raycaster();
const CROSSHAIR = new THREE.Vector2(0, 0);
/** How close (meters from your eyes) you must be to use each kind of thing. */
const REACH: Record<InteractKind, number> = {
  desk: 4.5,
  issues: 9,
  pulls: 9,
  actions: 9,
  ci: 9,
  whiteboard: 9,
  computers: 9,
  decor: 9,
  elevator: 4.5,
  gong: 3.5,
  vibes: 3.5,
  jukebox: 4,
  seat: 3,
  ladder: 3,
  bookshelf: 4,
  // Up on its plinth, and on the screen over the table.
  orchestrator: 7,
  bot: 4,
};
const MAX_REACH = Math.max(...Object.values(REACH));
/** What the ray through `ndc` lands on first, whether it is within reach (plus `slack` meters), and where it hit. */
function aimedAt(ndc: THREE.Vector2, slack = 0): { it: Interactable; near: boolean; hit: THREE.Intersection } | null {
  raycaster.setFromCamera(ndc, camera);
  const prevFar = raycaster.far;
  raycaster.far = Math.min(prevFar, MAX_REACH + slack + 0.01);
  let hit: THREE.Intersection | null;
  try {
    hit = firstVisibleIntersection(raycaster, upTop && roof ? roof.pickables : [office.group]);
  } finally {
    raycaster.far = prevFar;
  }
  if (!hit) return null;
  let it: Interactable | undefined;
  let shown = true;
  for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
    if (!o.visible) shown = false;
    it ??= o.userData.interact as Interactable | undefined;
  }
  if (!shown || !it) return null; // a wall, the floor… is in the way
  return { it, near: hit.point.distanceTo(camera.position) <= REACH[it.kind] + slack, hit };
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
  if (issuesTex.tab === 'linear') {
    const lt = store.linearBoard?.items.find((x) => x.identifier === spot.key);
    if (!lt) return false;
    openLinearTicket(lt, boardActions());
    return true;
  }
  const t = store.jiraBoard?.items.find((x) => x.key === spot.key);
  if (!t) return false;
  openTicket(t, boardActions());
  return true;
}

/** The run on the Pipelines board an aim lands on, or undefined. */
function runUnder(aim: { it: Interactable; hit: THREE.Intersection } | null): number | undefined {
  if (aim?.it.kind !== 'actions' || aim.hit.object !== office.boardMeshes.actions || !aim.hit.uv) return undefined;
  return pipelinesTex.runAt(aim.hit.uv);
}

/** The note on the issues board under the crosshair, which E takes. */
let aimedNote: GhIssue | null = null;
/** The run on the Pipelines board under the crosshair, which E opens. */
let aimedRun: number | undefined;
/** The tab or Jira card on the issues board under the crosshair. */
let aimedSpot: BoardSpot | null = null;

player.onPress = () => {
  if (modalOpen() || emoteWheel.isOpen || !sidearm.gunOut) return false;
  shotCharge.begin(performance.now());
  renderWake();
  return true;
};
player.onRelease = () => {
  const shot = shotCharge.release(performance.now());
  clearChargeFeedback();
  if (!shot || !sidearm.gunOut || modalOpen() || emoteWheel.isOpen) return cancelShotCharge();
  fireGun(shot.superShot);
};
player.onCancelPress = cancelShotCharge;

player.onClick = () => {
  if (modalOpen()) return;
  if (emoteWheel.isOpen) return emoteWheel.click();
  // Armed primary input fires on release instead.
  if (sidearm.gunOut) return;
  if (hanger.active) {
    reach();
    hanger.place();
    return;
  }
  // Reach out even at nothing, like poking the air.
  reach();
  if (target) interact(target, 'E');
};

// Buttons must not keep focus, or Space (jump) would click them again.
$('hud').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) setTimeout(() => btn.blur(), 0);
});
// The project in the corner is the floor you're on; click it for the list of floors to go to.
$('project').addEventListener('click', () => {
  if (!store.floor) return showElevator();
  toggleFloorMenu($('project'), { net, go: switchFloor, elevator: showElevator, roof: () => ride(ROOF) });
});

// ---- The HUD: a few buttons on the top bar, everything else in the ☰ menu ----------------------------
const waitingNow = () => waitingInOrder(waitingHere());
const hudActions: HudAction[] = [
  { id: 'issues', icon: '📌', label: 'Issues', section: 'Open', shown: () => !plainFloor(), count: () => store.issues.items.filter((i) => i.state === 'OPEN').length, run: () => openBoard('issues', net, boardActions()) },
  { id: 'pulls', icon: '🔀', label: 'Pull requests', section: 'Open', shown: () => !plainFloor(), count: () => store.pulls.items.filter((p) => p.state === 'OPEN').length, run: () => openBoard('pulls', net, boardActions()) },
  {
    id: 'pipelines',
    icon: '🚀',
    label: 'Pipelines',
    section: 'Open',
    shown: () => !plainFloor(),
    count: () => store.pipelines.runs.filter((r) => isLive(r.state)).length,
    title: () => pipelinePolicy(store.project?.forge).copy.menuTitle,
    run: () => showPipelines(),
  },
  {
    id: 'ci',
    icon: '🏭',
    label: 'CI automations',
    section: 'Open',
    shown: () => store.factory.connection.connected && !plainFloor(),
    count: () => ciForFloor(store.factory.ci, floorGithubRepo()).workflows.length,
    title: () => 'Droid in GitHub Actions for this floor’s repository',
    run: () => showCi(),
  },
  {
    id: 'whiteboard',
    icon: '🧑‍🎨',
    label: 'Whiteboard',
    section: 'Open',
    shown: () => !upTop && !!store.floor,
    count: whiteboardChanged,
    title: () => "The floor's Whiteboard: artifacts from workers, your marks on them",
    run: () => openWhiteboard(net),
  },
  { id: 'computers', icon: '🖥️', label: 'Computers', section: 'Open', count: () => store.factory.computers.items.length, title: () => 'This machine and your Factory Droid Computers', run: () => showComputers() },
  {
    id: 'environments',
    icon: '⧉',
    label: 'Environments',
    section: 'Open',
    shown: () => store.factory.connection.connected,
    count: () => store.factory.environments.items.length,
    title: () => 'Your Factory Environments: what computers start from',
    run: () => openComputers({ settings: () => showSettings('connections'), tab: 'environments' }),
  },
  { id: 'search', icon: '🔎', label: 'Search', section: 'Open', key: '/', title: () => 'Search every terminal', run: showSearch },
  { id: 'autowiki', icon: '🏭', label: 'AutoWiki', section: 'Open', title: () => "Factory's wiki of this repository, on the bookshelf", run: () => showBookshelf('wiki') },
  { id: 'elevator', icon: '🛗', label: 'Elevator', section: 'Open', count: () => store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0), title: () => 'Ride to another project', run: showElevator },
  { id: 'roof', icon: '🏙️', label: 'Rooftop', section: 'Open', shown: () => !upTop && builtFloors().length > 0, title: () => 'Ride the elevator up to the roof', run: () => ride(ROOF) },
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
  {
    id: 'welcome',
    icon: '👋',
    label: 'Welcome',
    section: 'Office',
    // On the top bar while workers can't start: Droid is missing or signed out.
    status: droidMissing,
    chip: () => 'Set up Droid',
    tone: () => (droidMissing() ? 'primary' : undefined),
    title: () => 'Droid, your Factory account and Subscriptions',
    run: () => openWelcome(net),
  },
  { id: 'phone', icon: '📱', label: 'Pair a phone', section: 'Office', title: () => 'Pair Droid Office for Android with the QR code', run: () => openPhone() },
  { id: 'companion', icon: '🌐', label: 'Web companion', section: 'Office', title: () => 'Open the office in a desktop browser: its links for this computer, Wi-Fi and Tailscale', run: () => openCompanion() },
  { id: 'help', icon: '❓', label: 'Controls', section: 'Office', key: 'H', run: () => openHelp(settings.sidearm) },
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
  // Up on the top bar while it works or waits on you.
  {
    id: 'orchestrator',
    icon: '🛰️',
    label: 'Orchestrator',
    section: 'Open',
    key: 'M',
    shown: () => !!store.missionControl,
    status: () => orchestratorPhase(store.missionControl) === 'working' || !!orchestratorWaiting(store.missionControl),
    chip: () => `Orchestrator · ${orchestratorWaiting(store.missionControl)?.status === 'done' ? 'done' : PHASE_WORD[orchestratorPhase(store.missionControl)]}`,
    on: () => orchestratorPhase(store.missionControl) === 'working',
    tone: () => (orchestratorPhase(store.missionControl) === 'needs_input' ? 'danger' : undefined),
    title: () => `Mission Control's Orchestrator: ${orchestratorLine(store.missionControl)} (M)`,
    run: orchestratorKey,
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
// A model picker's "Use your Claude or ChatGPT plan": Settings on that pane, or the open Settings turned to it.
window.addEventListener(OPEN_SETTINGS_EVENT, (e) => {
  const want = (e as CustomEvent<{ pane?: string }>).detail?.pane;
  const pane = resolveSettingsPane(want);
  const tab = pane && document.getElementById(`settings-tab-${pane}`);
  if (tab) tab.click();
  else showSettings(pane);
});
function droidMissing(): boolean {
  const d = store.setup.droid;
  return d.busy !== 'checking' && (!d.path || (store.setup.airgapped ? !store.setup.customModels?.length : d.signedIn === false));
}
/** F: hang a picture on a wall of this floor. There are no walls for them up on the roof. */
function startHanging() {
  if (upTop) return toast('No walls to hang pictures on up here — take the elevator down to a floor', 'warn');
  hanger.start();
}
function showSettings(pane?: SettingsPane, focusCard?: SettingsCardTitle) {
  openSettings(net, {
    surface: 'office',
    first: pane,
    focusCard,
    hireForSetup: hireForWorktreeSetup,
    office: {
      settings,
      onChange: (s) => {
        Object.assign(settings, s);
        saveSettings(settings);
        sound.setVolume(settings.volume, settings.muted);
        sound.setAlertsMuted(settings.alertsMuted);
        sound.setMusicVolume(settings.music, settings.musicMuted);
        applyGraphics();
        // The hint names what's in your hand; the hands swap props by themselves next frame.
        hintKey = 'stale';
      },
      onCharacter: editProfile,
      previewSound: () => sound.floorChime(),
      previewAlerts: () => sound.previewAlerts(),
      notifier,
      outside: store.sky ? { now: describeSky(store.sky), live: !!store.sky.city } : undefined,
      renderer: {
        remastered: () => remasterSettings.enabled,
        set: (on) => changeRemaster({ ...remasterSettings, enabled: on }),
        hdr: () => remasterSettings.hdr,
        setHdr: (on) => changeRemaster({ ...remasterSettings, hdr: on }),
        hdrNote: () => {
          if (!remasterSettings.enabled || !remasterSettings.hdr) return '';
          const h = remaster.hdr;
          if (h.state === 'starting') return 'Starting HDR output…';
          if (h.state === 'unsupported') return `HDR is off: ${h.reason}.`;
          return h.reason ? `HDR is on, but ${h.reason}.` : '';
        },
      },
    },
  });
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
  // Before the Remastered renderer exists on the first call; it is told of every resize after.
  remasterResized?.();
}
let remasterResized: (() => void) | undefined;
window.addEventListener('resize', () => {
  resize();
  renderWake();
});
resize();

let spotSavedAt = 0;
const lookDir = new THREE.Vector3();
const workerPos = new THREE.Vector3();
const deskFloor = new THREE.Vector3();

const fpsEl = $('fps');
let fpsFrames = 0;
let fpsSince = performance.now();
const upscaler = new Upscaler(renderer);
// Timer queries can't nest, so the scene and the hands with the frame's finish are timed one after the other.
const gpuScene = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);
const gpuHands = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);
const frameStats = new FrameStats();
/** The window the overlay's pacing line covers, in ms. */
const PACING_WINDOW_MS = 5000;
/** GPU time per pass over the overlay's last half second, while something times it. */
let lastGpuPass: { scene: number | null; hands: number | null } | null = null;
const warmup = new WarmupWatch();
/** Set once shader warmup has finished, so a later outline rebuild can compile before the next frame. */
let shadersWarmed = false;
const warmupEl = $('warmup');
let warmupKey = '';
/** The warm-up line at the bottom of the view: what is costing frame rate for now, and how far through it is. */
function renderWarmup(s: WarmupStatus | null) {
  const pct = s?.progress == null ? null : Math.floor(s.progress * 100);
  const k = s ? `${s.say}|${pct}|${s.done}` : '';
  if (k === warmupKey) return;
  warmupKey = k;
  warmupEl.classList.toggle('on', !!s);
  warmupEl.setAttribute('aria-hidden', s ? 'false' : 'true');
  // Fading out, it keeps the last words it had.
  if (!s) return;
  warmupEl.classList.toggle('indeterminate', pct === null);
  warmupEl.classList.toggle('done', s.done);
  $('warmup-say').textContent = s.say;
  $('warmup-pct').textContent = pct === null || s.done ? '' : `${pct}%`;
  $('warmup-fill').style.width = pct === null ? '' : `${pct}%`;
  $('warmup-note').textContent = s.done ? 'Done.' : 'The frame rate is lower until this is done.';
}
/** The Mac's whole-GPU load from the office's server, when this page runs on the office's own Mac. */
let systemGpu: number | null = null;
let systemGpuPoll = 0;
let systemGpuBusy = false;
/** The overhead lights' brightness last applied; -1 before the first time, when the renderer isn't set up yet. */
let appliedOverhead = -1;
async function pollSystemGpu() {
  if (systemGpuBusy) return;
  systemGpuBusy = true;
  try {
    const res = await fetch(withToken('/api/gpu'), { credentials: 'same-origin', cache: 'no-store' });
    const body = res.ok ? ((await res.json()) as { stats?: { device?: unknown } | null }) : null;
    const device = body?.stats?.device;
    systemGpu = typeof device === 'number' && Number.isFinite(device) ? device : null;
  } catch {
    systemGpu = null;
  } finally {
    systemGpuBusy = false;
  }
}
/** Graphics settings to the renderer and the overlay. The counter's text still updates while hidden: recording rigs read it. */
function applyGraphics() {
  upscaler.configure(settings.graphics);
  player.rawInput = settings.graphics.rawMouse;
  player.lookSensitivity = settings.graphics.lookSensitivity;
  const overhead = settings.graphics.overhead;
  sky.setOverhead(overhead);
  // The next frame gives the bounce light its new bake key: the old brightness stays up until it's loaded or baked.
  if (appliedOverhead >= 0 && overhead !== appliedOverhead) renderWake();
  appliedOverhead = overhead;
  fpsEl.classList.toggle('hidden', !settings.graphics.stats);
  window.clearInterval(systemGpuPoll);
  systemGpu = null;
  if (settings.graphics.stats) {
    void pollSystemGpu();
    systemGpuPoll = window.setInterval(() => document.visibilityState === 'visible' && renderLoop.mode !== 'paused' && void pollSystemGpu(), 1000);
  }
}
applyGraphics();

/** Frames drawn since the page loaded, so automation commands can wait for the scene to catch up. */
let framesDrawn = 0;
/** Pointer or keys just asked the camera to move. Keeps full rate before the player controller has caught up. */
let lookedUntil = 0;
/** When the scene last moved or the page last came into view. Full rate holds for IDLE_AFTER_MS after it. */
let activeAt = performance.now();
const renderLoop = new RenderLoop({
  pace: currentPace,
  fpsCap: () => settings.graphics.fpsCap,
  draw: drawFrame,
  animation: (callback) => renderer.setAnimationLoop(callback),
  delay: (callback, ms) => window.setTimeout(callback, ms),
  cancelDelay: (id) => window.clearTimeout(id),
  now: () => performance.now(),
  paused: () => {
    fpsEl.textContent = '';
    fpsFrames = 0;
    fpsSince = performance.now();
  },
});

// ---- The Remastered renderer (Settings → Display → Renderer; the picture is fixed) --------------
let remasterSettings: RemasterSettings = loadRemaster();
let remasterParams = resolveRemaster(remasterSettings);
const remaster = new Remaster(
  renderer,
  scene,
  { sun, hemi, ambient },
  remasterParams,
  () => {
    reportHdr(remaster.hdr.active);
    window.dispatchEvent(new Event('office:hdr'));
    renderWake();
  },
  bakeCache,
);
// Who is on this floor (the workers, their laptops, the free-seat signs, the bean bags and team lines) changes from
// floor to floor; the room around them doesn't, so the bounce light is baked without them and fits every floor.
remaster.gi.hideWhileBaking = () => [...office.occupants, teamLines.group, mission.group, vibeFx.group, ...office.vibesSwitch.bakeHidden];
let remasterSavedAt = 0;
let remasterSaveTimer = 0;
/** A new outline effect has empty caches. Compile them before the next frame, for the draw that's on now. */
function rewarmOutlines() {
  try {
    warmOutlines(renderer, (scene, camera) => effect.renderOutline(scene, camera), [
      { scene, camera, pipeline: remaster.active ? 'float' : upscaler.active ? 'srgb' : 'canvas' },
      { scene: hands.scene, camera: hands.camera, pipeline: 'canvas' },
    ]);
    warmup.seed(renderer.info.programs?.length ?? 0);
  } catch (err) {
    console.warn('office: outline shaders failed to compile', err);
  }
}
function applyRemaster() {
  const s = (remasterParams = resolveRemaster(remasterSettings));
  remaster.configure(s);
  const key = s.enabled ? `${s.outlineThickness}|${s.outlineOpacity}` : '1.8|1';
  if (key !== outlineKey) {
    outlineKey = key;
    effect = s.enabled ? outlineEffect(s.outlineThickness, s.outlineOpacity) : outlineEffect();
    if (shadersWarmed) rewarmOutlines();
  }
  effect.enabled = !s.enabled || s.outlines;
  // The classic upscaler stands aside while the Remastered pipeline draws.
  if (s.enabled) upscaler.reset();
  // A setting changing is the scene changing: back to full rate, so what it costs shows straight away.
  activeAt = performance.now();
  renderWake();
}
/** Applies and saves whether Remastered is on, and whether HDR is on. The picture itself does not change. */
function changeRemaster(s: RemasterSettings) {
  remasterSettings = s;
  applyRemaster();
  window.clearTimeout(remasterSaveTimer);
  const now = performance.now();
  if (now - remasterSavedAt > 400) {
    remasterSavedAt = now;
    saveRemaster(s);
  } else remasterSaveTimer = window.setTimeout(() => saveRemaster(remasterSettings), 400);
}
applyRemaster();
remasterResized = () => remaster.resized();
/** WebGL's name for the GPU. Chromium gives the real one as RENDERER; others only through the debug extension. */
function gpuRendererName(): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
}

/** Traffic is the thing you're looking at, not just the street outside the windows. */
function trafficInView(): boolean {
  if (upTop) return true;
  const { x, y, z } = player.pos;
  if (y < -0.4) return true;
  return x < FLOOR.minX || x > FLOOR.maxX || z < FLOOR.minZ || z > FLOOR.maxZ;
}

/** What the pace decision needs. Hidden covers a background tab and, on macOS, a fully covered window. */
function sceneMotion(): SceneMotion {
  const now = performance.now();
  const playerBusy =
    player.moving ||
    player.changingHeight ||
    !player.grounded ||
    player.vy !== 0 ||
    player.jitter > 0 ||
    thud > 0 ||
    climber.active ||
    hanger.active ||
    !!errand ||
    !!gunMotion.doing ||
    !!wandMotion.doing ||
    shotCharge.held ||
    !!me.emoteId ||
    readingNow() ||
    now < lookedUntil;
  return {
    player: playerBusy,
    worker: workerMoving(),
    confetti: confetti.count > 0,
    gong: gongRinging(now, gongStruckAt),
    smoke: smoke.group.children.length > 0 || puffs.length > 0,
    cars: trafficInView(),
    elevator: !!floorTravel.trip,
    // Cards snap on and off the board. One carried while you walk is the player moving.
    boardCard: false,
    sky: skyFalling(sky.rain, sky.snow),
  };
}

/** `?pace=full` on this tab's address: a recording tab that must never idle or pause (see RenderSignals). */
const fullRate = new URLSearchParams(location.search).get('pace') === 'full';

function currentPace(): RenderPace {
  const now = performance.now();
  const motion = sceneMotion();
  if (sceneIsMoving(motion)) activeAt = now;
  // A full GI bake runs in slices, one a frame: at the idle pace it would take minutes.
  // Render pace "full" never idles, but still stops while the window is hidden.
  if (remaster.active && remaster.gi.baking && !remaster.gi.paused) activeAt = now;
  // The warm-up line goes once a frame says the work is done; at the idle pace it would hang about.
  if (warmup.showing) activeAt = now;
  return renderPace({
    hidden: document.visibilityState !== 'visible',
    // Occlusion arrives as visibilityState "hidden" (see RenderSignals). hasFocus() is not used:
    // it is also false when this window is visible beside another one.
    covered: false,
    fullRate,
    motion,
    quietMs: now - activeAt,
  });
}

let lastBakeParams: typeof remasterParams | null = null;
let lastBakeOverhead = Number.NaN;
let lastBakeHash = '\0';
let cachedBakeKey = '';

function drawFrame(dt: number, t: number, frame: { at: number; paced: boolean }) {
  const frameStart = performance.now();
  framesDrawn++;
  fpsFrames++;
  const fpsNow = performance.now();
  if (fpsNow - fpsSince >= 500) {
    const windowMs = fpsNow - fpsSince;
    const fps = (fpsFrames * 1000) / windowMs;
    const timed = settings.graphics.stats;
    const gpuPass = timed ? { scene: gpuScene.take(), hands: gpuHands.take() } : null;
    lastGpuPass = gpuPass;
    const gpuMs = gpuPass?.scene == null || gpuPass.hands == null ? null : gpuPass.scene + gpuPass.hands;
    const { render, output } = remaster.active ? remaster.sizes() : upscaler.sizes();
    if (settings.graphics.stats) {
      fpsEl.textContent = statsText({
        fps,
        frameMs: windowMs / fpsFrames,
        fpsCap: settings.graphics.fpsCap,
        // Frames skipped while queries were in flight count at the timed frames' average.
        gpu: gpuMs === null ? null : { ms: gpuMs, busy: gpuBusy(gpuMs * fpsFrames, windowMs) },
        gpuNote: gpuScene.supported ? 'timing…' : 'timing unavailable in this browser',
        pacing: pacingText(frameStats.pacing({ fpsCap: settings.graphics.fpsCap, refreshMs: renderLoop.refreshMs, since: frame.at - PACING_WINDOW_MS })),
        system: systemGpu,
        render,
        output,
        scale: remaster.active ? remasterParams.resolution : settings.graphics.scale,
        taa: settings.graphics.taa,
        mode: remaster.active ? remaster.describe() : undefined,
      });
    } else fpsEl.textContent = `${Math.round(fps)} FPS`;
    fpsFrames = 0;
    fpsSince = fpsNow;
  }
  const now = performance.now();

  thud = Math.max(0, thud - dt * 2.5);
  player.jitter = reduceMotion.matches ? 0 : thud;
  player.update(dt);
  bossLaptop.update(dt, store.screens.get(OFFICE_SHELL_ID));
  // Under an upstairs floor, inside the building, with no ladder or elevator carrying you:
  // there is nowhere down there to be. However you got under the slab (a rebuild that dropped the
  // floor, a spot saved mid-fall), you are put back on top of it rather than left on the street
  // under the building with the floor gone for good. The ground floor keeps its street and garage.
  if (
    !upTop &&
    !floorTravel.trip &&
    !climber.active &&
    !hanger.active &&
    !player.seat &&
    store.floor &&
    player.pos.y < -SLAB - 0.05 &&
    player.pos.x > FLOOR.minX &&
    player.pos.x < FLOOR.maxX &&
    player.pos.z > FLOOR.minZ &&
    player.pos.z < FLOOR.maxZ &&
    builtFloors().findIndex((f) => f.id === store.floor) > 0
  ) {
    if (player.blockedAt(player.pos.x, player.pos.z, 0)) placeInCar();
    else placeAt({ x: player.pos.x, y: 0, z: player.pos.z, rotY: player.facing });
  }
  // Pulled away with the gun out (off up the ladder, into the elevator, up to the roof): it goes back.
  if (sidearm.gunOut && (floorTravel.trip || hanger.active || climber.active || upTop)) holsterGun(true);
  const grip = climber.grip;
  // Switched in Settings with one drawn: the other comes out in its place.
  if (sidearm.gunOut && sidearm.drawnArm !== settings.sidearm) {
    holsterGun(true);
    toggleGun();
  }
  updateShotCharge(now);
  const gunCuesNow = gunMotion.update(dt);
  const wandCuesNow = wandMotion.update(dt);
  if (me.root.visible || me.emoteId) {
    me.root.position.copy(player.pos);
    me.root.position.y += player.stepOffset;
    me.root.rotation.y = player.facing;
    me.setGrip(grip);
    me.setGunPose(gunMotion.pose);
    me.update(dt, t, (player.moving && player.grounded) || (grip === 'ladder' && player.moving), !player.grounded && !grip);
  }
  hands.setGunPose(gunMotion.pose);
  hands.setWandPose(wandMotion.pose);
  hands.update(dt, t, { yaw: player.camYaw, pitch: player.lookPitch, walkPhase: player.walkPhase, walking: player.moving && player.grounded, airborne: !player.grounded, jitter: player.jitter, grip });
  gunCues(gunCuesNow);
  wandCues(wandCuesNow);
  // The wand's light on the room (Lumos, and the flash of a spell leaving it), and the trail its tip draws.
  const wandPose = wandMotion.pose;
  const tipNow = wandPose ? wandTipAt(tipWorld) : null;
  tipTrail.emit(tipWorld, tipNow && wandPose ? wandPose.trail : 0);
  tipTrail.update(dt);
  const wandGlow = 2.4 * hands.lumos + 1.6 * (wandPose?.glow ?? 0);
  // Keep the same glow cutoff; only an exactly dark light leaves the shader's point-light count.
  wandLight.intensity = tipNow && wandGlow > 0.02 ? wandGlow : 0;
  wandLight.visible = wandLight.intensity > 0;
  if (tipNow) {
    // A touch ahead of the tip, so it lights what's in front of you rather than the shaft's own shadow side.
    hands.wandDir(tipDir);
    wandLight.position.copy(tipNow).add(tipDir.transformDirection(camera.matrixWorld).multiplyScalar(0.12));
  }
  camera.getWorldDirection(lookDir);
  sound.update({ x: camera.position.x, y: camera.position.y, z: camera.position.z, fx: lookDir.x, fz: lookDir.z });

  // Where you are, to come back to next time.
  if (now - spotSavedAt > 1000) {
    spotSavedAt = now;
    saveSpot();
  }

  const camPos = camera.position;
  let screens = workerScene.updateWorkers(dt, t, camPos);
  const bossGlow = (screenGlows[screens] ??= { pos: new THREE.Vector3(), dir: new THREE.Vector3(), power: 0 });
  bossGlow.power = bossLaptop.glow(bossGlow.pos, bossGlow.dir);
  bossGlow.color = undefined;
  if (bossGlow.power > 0.01) screens++;
  workerScene.updateMission(dt, t, camPos);
  sky.setScreens(screenGlows, screens, camPos);
  departures.update(dt, t);
  casualties.update(dt, t);
  for (let i = puffs.length - 1; i >= 0; i--) {
    if (puffs[i].update(dt)) continue;
    scene.remove(puffs[i].group);
    puffs[i].dispose();
    puffs.splice(i, 1);
  }
  if (!upTop) {
    peopleScratch.length = 1;
    peopleScratch[0] = player.pos;
    departures.fillPositions(peopleScratch);
    office.update(t, dt, peopleScratch);
    const climberState = climbersScratch[0];
    climberState.x = player.pos.x;
    climberState.y = player.pos.y;
    climberState.z = player.pos.z;
    climberState.grip = grip;
    office.stack.update(dt, climbersScratch, camera.position);
    office.jukebox.update(t, dt, sound.beat());
  }
  smoke.update(dt, camera);
  confetti.update(dt);
  vibeFxMoving = !upTop && vibeFx.update(dt);
  if (!upTop) teamLines.update(reduceMotion.matches ? 0 : dt);
  hanger.update();
  sky.update(dt, t, camera);
  if (upTop && roof) roof.update(t, dt, { dark: sky.lampsOn });
  aimedNote = null;
  aimedSpot = null;
  aimedRun = undefined;
  if (modalOpen() || hanger.active || climber.active) target = null;
  else {
    const aim = aimedAt(CROSSHAIR);
    target = aim?.near ? aim.it : mySeat();
    if (aim?.near) {
      aimedNote = noteUnder(aim);
      aimedSpot = spotUnder(aim);
      aimedRun = runUnder(aim);
    }
  }
  focusTeam(target);
  issuesTex.lift(aimedNote?.number ?? null);
  issuesTex.hover(aimedSpot);
  pipelinesTex.hover(aimedRun ?? null);
  renderHint();
  renderCrosshair();

  const timing = settings.graphics.stats;
  if (timing) gpuScene.begin();
  renderer.info.reset();
  const drawStart = performance.now();
  if (remaster.active) {
    remaster.gi.paused = upTop;
    remaster.gi.overhead = settings.graphics.overhead;
    remaster.gi.budgetMs = bakeBudget(settings.graphics.fpsCap, renderLoop.refreshMs);
    // The welcome paints the floor's palette (`paintFloor`): a bake started before it would save the default room's colours.
    const bakedHash = bootVersion ? SCENE_HASH : '';
    if (remasterParams !== lastBakeParams || settings.graphics.overhead !== lastBakeOverhead || bakedHash !== lastBakeHash) {
      lastBakeParams = remasterParams;
      lastBakeOverhead = settings.graphics.overhead;
      lastBakeHash = bakedHash;
      cachedBakeKey = bakeKey(remasterParams, settings.graphics.overhead, bakedHash);
    }
    remaster.gi.setKey(cachedBakeKey);
    remaster.draw(() => effect.render(scene, camera));
  } else upscaler.draw(camera, () => effect.render(scene, camera));
  const sceneEnd = performance.now();
  if (timing) {
    gpuScene.end();
    gpuHands.begin();
  }
  const gi = remaster.gi;
  renderWarmup(
    warmup.update({
      now: performance.now(),
      programs: renderer.info.programs?.length ?? 0,
      drawMs: sceneEnd - drawStart,
      bake: remaster.active && gi.baking && !gi.paused ? gi.progress : null,
    }),
  );
  pointToWaiting(now);
  // Classic leaves scene depth on the canvas. Remastered's last full-screen pass already clears
  // that depth without writing it, so another clear only interrupts the GPU's pass before the hands.
  // The hands have lights of their own, turned down to match wherever you're standing.
  if (!remaster.active) renderer.clearDepth();
  hands.setLight(sky.lightAt(camera.position));
  sky.shading(false);
  // The outline effect draws without clearing, but with outlines turned off it is a plain render, which would.
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    effect.render(hands.scene, hands.camera);
  } finally {
    renderer.autoClear = autoClear;
    sky.shading(true);
  }
  const handsEnd = performance.now();
  if (remaster.active) remaster.finishFrame();
  if (timing) gpuHands.end();
  loading.drew();
  frameStats.record({ at: frame.at, paced: frame.paced, cpu: { update: drawStart - frameStart, scene: sceneEnd - drawStart, hands: handsEnd - sceneEnd, finish: performance.now() - handsEnd } });
}

/** Draw on the next frame instead of waiting out an idle gap. Input and scene changes both call this. */
function renderWake() {
  renderLoop.wake();
}

/** The camera is being driven. Full rate starts before the player controller has stepped. */
function renderLook() {
  lookedUntil = performance.now() + 200;
  renderWake();
}

function startLoop() {
  renderLoop.start();
}

/** Shaders first, then the loop, so the first frame is not where they compile. */
async function startWhenReady() {
  await shadersReady;
  warmup.seed(renderer.info.programs?.length ?? 0);
  startLoop();
}

/** Strict view-aware cost gating for Gemini Decision 1: active only while this 3D canvas is open, visible, and on an indoor floor. */
const indoorHere = () => !upTop && Boolean(store.floor && store.floor !== ROOF);
let vibesWatching = false;
function syncVibesWatch() {
  if (!net.up) {
    vibesWatching = false;
    return;
  }
  const want = document.visibilityState === 'visible' && indoorHere();
  if (want === vibesWatching) return;
  vibesWatching = want;
  net.send({ t: 'vibes.watch', active: want });
}
/** Living 3D runs here: connected, switched on, key accepted, and standing on an indoor floor. */
function vibesLiveHere(): boolean {
  const g = store.gemini;
  return g.connected && g.vibesOn && !g.rejected && !store.setup.airgapped && indoorHere();
}

sky.calmMotion = vibeFx.calmMotion = reduceMotion.matches;
reduceMotion.addEventListener('change', () => {
  sky.calmMotion = vibeFx.calmMotion = reduceMotion.matches;
});

/** Where a worker's head is, and the floor under its desk. */
function deskPoints(v: WorkerView): { head: THREE.Vector3; feet: THREE.Vector3 } {
  const feet = v.model.root.getWorldPosition(new THREE.Vector3());
  const deskView = office.desks.get(v.deskId);
  const head = feet.clone().setY(feet.y + WORKER_HEAD);
  if (deskView) feet.setY(deskFloor.setFromMatrixPosition(deskView.group.matrixWorld).y);
  return { head, feet };
}

/** A worker's micro-reaction, around it: sparks, and confetti, smoke or a warning strobe. */
function vibeReactionFx(_id: string, v: WorkerView, kind: WorkerMicroReaction) {
  if (!vibeFx.enabled) return;
  const { head, feet } = deskPoints(v);
  const fx = MICRO_REACTION_FX[kind];
  const down = kind === 'setback' || kind === 'frustrated' || kind === 'corner_cut';
  vibeFx.react(fx.hex, head, feet, { sparks: kind === 'breakthrough' || kind === 'eureka' ? 56 : 32, lift: down ? -0.6 : 1 });
  if (kind === 'breakthrough') burstOver(v.deskId, 90);
  else if (kind === 'risky_move') sky.flashRoom(fx.hex, 1.4, 2, 3.2);
  else if (down && !reduceMotion.matches) addEffect(new Puff(head, new THREE.Vector3(0, 1, 0)));
}

/**
 * Something the office knows happened at a desk, played without Gemini while Living 3D is on: a
 * beam of light for a hire, a ring closing in for a send-off, a crimson flash for a shot.
 */
function deskMomentFx(id: string, v: WorkerView, kind: DeskMoment) {
  if (!vibeFx.enabled) return;
  const { head, feet } = deskPoints(v);
  const fx = DESK_MOMENT_FX[kind];
  vibeFx.deskMoment(fx.hex, head, feet, { beam: kind === 'hired' || kind === 'shipped', implode: kind === 'sent_home' || kind === 'shot', sparks: kind === 'shot' ? 70 : 40 });
  if (kind === 'shot') sky.flashRoom(fx.hex, 2.4, 1, 2.6);
  else if (kind === 'sent_home') sky.flashRoom(fx.hex, 0.9, 1, 1.4);
  lastDeskMoment = { kind, worker: id };
  activeAt = performance.now();
  renderWake();
}

/** A worker on this floor opened a pull request: a chair spin, a beam, confetti and the whole room flashing gold. */
function shippedFx(id: string, v: WorkerView) {
  if (!vibeFx.enabled) return;
  v.model.triggerReaction('shipped');
  burstOver(v.deskId, 180);
  deskMomentFx(id, v, 'shipped');
  playFloorEvent('ship_it');
}

/** Pairs of graded desks at odds for a collision: the struggling or drifting ones when there are two, else every graded desk, chained left to right. */
function collisionPairs(points: { id: string; head: THREE.Vector3 }[]): [THREE.Vector3, THREE.Vector3][] {
  const graded = store.vibes?.workers ?? {};
  const atOdds = points.filter((p) => {
    const w = graded[p.id];
    return w && (w.spill === 'amber' || w.spill === 'crimson' || w.posture === 'struggling');
  });
  const chain = (atOdds.length >= 2 ? atOdds : points).slice().sort((a, b) => a.head.x - b.head.x);
  const pairs: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 1; i < chain.length; i++) pairs.push([chain[i - 1].head, chain[i].head]);
  return pairs;
}

/**
 * A room-wide moment: the whole room flashes in its color, a ring races across the floor, and every
 * graded desk lights up as it passes. A collision crackles between the desks at odds; a crisis calls
 * out the desks in trouble; things coming together raise a beam at every desk.
 */
function playFloorEvent(kind: FloorEvent | 'ship_it') {
  const fx = FLOOR_EVENT_FX[kind];
  sky.flashRoom(fx.hex, kind === 'crisis' || kind === 'collision' ? 3.2 : 2.6, fx.pulses, kind === 'ship_it' ? 2.2 : 1.7);
  const center = new THREE.Vector3((FLOOR.minX + FLOOR.maxX) / 2, 0, (FLOOR.minZ + FLOOR.maxZ) / 2);
  const graded = store.vibes?.workers ?? {};
  const troubled = (id: string) => graded[id]?.spill === 'crimson' || graded[id]?.posture === 'struggling';
  const anyTroubled = Object.keys(graded).some(troubled);
  const heads: { id: string; head: THREE.Vector3; feet: THREE.Vector3 }[] = [];
  for (const [id, v] of workerViews) {
    if (!graded[id]) continue;
    if (kind === 'crisis' && anyTroubled && !troubled(id)) continue;
    heads.push({ id, ...deskPoints(v) });
  }
  vibeFx.roomWave(center, fx.hex, heads);
  if (kind === 'collision') vibeFx.links(collisionPairs(heads), fx.hex);
  if (kind === 'convergence') for (const h of heads) vibeFx.deskMoment(fx.hex, h.head, h.feet, { beam: true, sparks: 20 });
  if (kind === 'ship_it') confetti.rain(FLOOR, floorArea(FLOOR) * 1.2, 2.5, ceilingOver);
  lastRoomEvent = kind;
}

function syncFloorVibes(snap = false) {
  const vibes = store.vibes;
  const live = vibesLiveHere();
  vibeFx.setEnabled(live);
  const nextMood = vibes && isFloorMood(vibes.mood) ? vibes.mood : 'calm_planning';
  let changed = snap || nextMood !== sky.currentMood;
  sky.setMood(nextMood, snap);
  sky.setMoodStakes(vibes?.stakes ?? 0.5);
  const nowMs = store.officeNow();
  for (const [wid, v] of workerViews) {
    const wVibe = vibes?.workers[wid];
    const tone: MonitorSpillTone = wVibe && isMonitorSpillTone(wVibe.spill) ? wVibe.spill : 'neutral';
    if (tone !== v.spillTone) changed = true;
    v.spillTone = tone;
    v.spillTarget.set(MONITOR_SPILL_HEX[tone]);
    v.spillPowerTarget = MONITOR_SPILL_POWER[tone];
    if (snap) {
      v.spillColor.copy(v.spillTarget);
      v.spillPower = v.spillPowerTarget;
    }
    const prevPosture = v.model.activeVibePosture;
    const prevReaction = v.model.activeReaction;
    v.model.applyVibe(wVibe, nowMs);
    const reaction = v.model.activeReaction;
    if (reaction && reaction !== prevReaction && isWorkerMicroReaction(reaction)) vibeReactionFx(wid, v, reaction);
    if (v.model.activeVibePosture !== prevPosture || reaction !== prevReaction) changed = true;
  }
  const ev = vibes?.event;
  if (ev && isFloorEvent(ev.kind) && ev.seq !== lastFloorEventSeq) {
    lastFloorEventSeq = ev.seq;
    if (live && nowMs - ev.at <= 10_000) {
      playFloorEvent(ev.kind);
      changed = true;
    }
  }
  if (changed || vibeFx.enabled) {
    activeAt = performance.now();
    renderWake();
  }
}

/** Living 3D switched on or off (here, from Settings, or from another window): a sweep across the room you can't miss. */
function syncVibesPower() {
  const g = store.gemini;
  const on = g.connected && g.vibesOn && !g.rejected && !store.setup.airgapped;
  vibeFx.setEnabled(on && indoorHere());
  if (vibesWasOn !== null && on !== vibesWasOn && g.connected && indoorHere()) {
    const from = new THREE.Vector3(player.pos.x, groundAt(office.colliders, player.pos.x, player.pos.z, player.pos.y + 0.5, false), player.pos.z);
    if (!Number.isFinite(from.y)) from.y = player.pos.y;
    vibeFx.power(on, from);
    sky.flashRoom(on ? '#ff7a1a' : '#9aa3b2', on ? 1.8 : 1, 1, on ? 1.8 : 0.7);
    // The pedestal switch toasts its own press once the server confirms it.
    if (vibesToggle.pendingTarget === null) toast(on ? 'Living 3D on: the room now reacts to your workers' : 'Living 3D off: lighting and postures are back to neutral');
    activeAt = performance.now();
    renderWake();
  }
  vibesWasOn = on;
}

net.onStatus((up) => {
  if (!up) vibesWatching = false;
  syncVibesWatch();
});
store.on('floor', () => {
  vibeFx.clear();
  syncFloorVibes(true);
  syncVibesWatch();
  syncVibesSwitch();
});
store.on('vibes', () => {
  syncFloorVibes(false);
  if (target?.kind === 'vibes') hintKey = '';
});
store.on('gemini', () => {
  syncVibesSwitch();
  syncVibesPower();
});
store.on('setup', () => {
  syncVibesSwitch();
  syncVibesPower();
});
syncVibesSwitch();

// A background tab and a fully covered window both show up as visibilityState "hidden".
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') activeAt = performance.now();
  syncVibesWatch();
  renderWake();
});
window.addEventListener('pageshow', () => {
  activeAt = performance.now();
  syncVibesWatch();
  renderWake();
});
window.addEventListener('pagehide', () => {
  if (vibesWatching && net.up) {
    vibesWatching = false;
    net.send({ t: 'vibes.watch', active: false });
  }
});
// Typing in a window is the terminal's canvas, not the 3D scene.
window.addEventListener('keydown', () => {
  if (modalOpen() || isTyping()) return;
  renderLook();
});
window.addEventListener('pointerdown', () => {
  if (modalOpen()) return;
  renderLook();
});
window.addEventListener(
  'wheel',
  () => {
    if (modalOpen()) return;
    renderLook();
  },
  { passive: true },
);
player.onLook = renderLook;

// ---- Boot ------------------------------------------------------------------------------------------
function boot() {
  net.connect();
  void startWhenReady();
}

guardLeaving();
// Prop models, then every shader a session can reach, then the first frame. A compile keeps the cap moving.
const shadersReady = propsReady
  .then(async () => {
    theRoof();
    const extras = Object.keys(propManifest()).flatMap((name) => {
      const loaded = propScene(name);
      return loaded ? [loaded] : [];
    });
    preparePicking(scene);
    await warmOfficeShaders({
      renderer,
      outline: (scene, camera) => effect.renderOutline(scene, camera),
      world: { scene, camera, wandLight },
      hands: { scene: hands.scene, camera: hands.camera },
      grid: remaster.gi.grid,
      pipeline: remaster.active ? 'float' : upscaler.active ? 'srgb' : 'canvas',
      passes: [...remaster.shaderPasses(), ...upscaler.shaderPasses()],
      extras,
      pulse: () => loading.stillGoing(),
    });
    office.freezeStatics([teamLines.group, mission.group, gallery.group]);
    skipHiddenMatrixWorld(office.group);
    if (roof) skipHiddenMatrixWorld(roof.group);
    skipHiddenMatrixWorld(me.root);
    skipHiddenMatrixWorld(confetti.mesh);
    skipHiddenMatrixWorld(teamLines.group);
    for (const { id } of BEANBAGS) skipHiddenMatrixWorld(office.desks.get(id)!.group);
    shadersWarmed = true;
  })
  .catch((err) => console.warn('office: shader warmup failed', err));
loading.until([
  { say: 'Unpacking the office', done: propsReady },
  { say: 'Compiling shaders', done: shadersReady },
]);
watchWelcome(net, shadersReady);
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
    // The office draws behind the character select screen once its shaders are in.
    void startWhenReady();
    openCharacter(true, (p) => {
      showMyProfile(p);
      net.connect();
    });
  }
}

// ---- window.office: the automation API agents and browser tests drive (see automation.ts) ----------
/** The middle of the scene object an interactable belongs to (a board, the gong), to look at. */
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

/** Faces the pose from where you stand. A desk keeps its pitch; anything else looks with pitchToward. */
function aimAt(pose: ApproachPose) {
  if (pose.pitchFixed) {
    player.facing = pose.facing;
    player.camYaw = pose.facing - Math.PI;
    player.lookPitch = pose.lookPitch;
    player.updateCamera();
    return;
  }
  player.facing = facingToward(player.pos, pose.face);
  player.camYaw = player.facing - Math.PI;
  player.updateCamera();
  player.lookPitch = pitchToward(camera.position, pose.face);
  player.updateCamera();
}

function setCamera(pose: CameraPose) {
  player.camYaw = pose.camYaw;
  player.lookPitch = pose.lookPitch;
  player.facing = pose.camYaw + Math.PI;
  player.updateCamera();
  renderWake();
}

/** Mission Control's building agents as workers: the Orchestrator while it's on (its stand-in before the first prompt), then the bots. */
function missionAgentsNow(): WorkerInfo[] {
  const mc = store.missionControl;
  const o = orchestratorWorker(mc);
  return [...(o ? [o] : []), ...(mc?.bots.map((b) => b.worker) ?? [])];
}

const automation = createAutomation({
  context: () => ({ workers: [...store.workers.values()], spots: usable().flat(), floors: store.floors, floor: store.floor, agents: missionAgentsNow() }),
  raw: () => ({
    floor: store.floor,
    floors: store.floors,
    riding: !!floorTravel.trip,
    player: {
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      eyeHeight: player.eyeHeight,
      facing: player.facing,
      lookPitch: player.lookPitch,
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
    ...(store.missionControl ? { agents: missionAgentsNow() } : {}),
    carrying: carrying?.issue ?? null,
    hanging: hanger.active,
    gun: sidearm.gunOut,
    gunMove: sidearm.drawnArm === 'wand' ? wandMotion.doing : gunMotion.doing,
    sidearm: settings.sidearm,
    ...(upTop || !store.floor ? {} : { vibesSwitch: office.vibesSwitch.state }),
    ...(store.gemini.connected
      ? {
          vibes: {
            on: store.gemini.vibesOn,
            live: vibesLiveHere(),
            watching3d: store.gemini.watching3d,
            calls: store.gemini.calls,
            inputTokens: store.gemini.inputTokens,
            mood: sky.currentMood,
            stakes: store.vibes?.stakes ?? 0.5,
            event: lastRoomEvent,
            moment: lastDeskMoment,
            roomFlash: sky.roomFlash,
            workers: [...store.workers.values()].map((w) => {
              const v = workerViews.get(w.id);
              return {
                id: w.id,
                name: w.name,
                posture: v?.model.activeVibePosture ?? 'steady',
                spill: v?.spillTone ?? 'neutral',
                stakes: v?.model.activeVibeStakes ?? 0.5,
                reaction: v?.model.activeReaction ?? null,
              };
            }),
          },
        }
      : {}),
  }),
  busy: () => (floorTravel.trip ? 'riding to another floor' : climber.active ? 'on the ladder: interact("E") gets off it' : !store.floor ? 'not on a floor yet: ride the elevator first' : null),
  blocked: (x, z, y) => player.blockedAt(x, z, y),
  centerOf,
  place: (pose) => {
    closeAllModals();
    if (player.seat) standUp();
    if (hanger.active) hanger.cancel();
    if (climber.active) climber.abort();
    if (errand) stopWalking();
    player.pos.set(pose.at.x, pose.at.y, pose.at.z);
    player.vy = 0;
    aimAt(pose);
    renderWake();
  },
  aim: (pose) => {
    aimAt(pose);
    renderWake();
  },
  walk: (at, label, done) => {
    walkThen(at, label, () => {}, undefined, done);
    renderWake();
  },
  near: () => mySeat() ?? pickTarget(),
  // No note or tab on the issues board: whatever the crosshair happens to be over, E opens the board.
  use: (spot, key) => use(spot, key, null, null),
  letGo: () => {
    const why = climber.letGo();
    renderWake();
    return why;
  },
  commands: () => hudActions.map((a) => ({ id: a.id, label: actionLabel(a), shown: actionOffered(a), blocked: a.blocked?.() })),
  run: (id) => hudActions.find((a) => a.id === id)?.run(),
  closeAll: closeAllModals,
  ride: (floor) => {
    ride(floor);
    renderWake();
  },
  teleport: (floor) => switchFloor(floor, true),
  setCamera,
  setHeight: (scale) => {
    player.setHeight(scale);
    renderWake();
  },
  frames: () => framesDrawn,
  presenterStats: (reset, samples) => presenterStats(reset, 1000 / Math.min(settings.graphics.fpsCap, 1000 / renderLoop.refreshMs), samples),
  frameStats: (reset) => {
    if (reset) frameStats.reset();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      ...frameStats.report({ fpsCap: settings.graphics.fpsCap, refreshMs: renderLoop.refreshMs, gpu: lastGpuPass ?? undefined }),
      renderer: remaster.active ? remaster.describe() : 'Classic',
      backend: gpuRendererName(),
      pace: renderLoop.mode,
      output: { width: size.x, height: size.y },
      rawMouse: player.rawMouse,
    };
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  visits: () => ({
    visits: store.visits,
    workers: [...store.workers.values()].map((w) => {
      const model = workerViews.get(w.id)?.model;
      return { id: w.id, name: w.name, deskId: w.deskId, visit: visitors.info(w.id), says: model?.saying ?? null };
    }),
  }),
});
(window as unknown as { office: typeof automation }).office = automation;

// Debug handle for quick checks from the console / headless screenshots.
(window as any).__office = {
  roof: () => roof,
  store,
  player,
  camera,
  workerViews,
  departures,
  casualties,
  visitors,
  scene,
  net,
  renderer,
  renderLoop,
  upscaler,
  gpuScene,
  gpuHands,
  frameStats,
  hands,
  me,
  settings,
  gallery,
  hanger,
  office,
  ride,
  switchFloor,
  climber,
  elevatorPanelOpen,
  confetti,
  sky,
  carried: () => carrying,
  emoteWheel,
  emote,
  gunMotion,
  wandMotion,
  toggleGun,
  gunTrick,
  wandSpell,
  lumos: () => sidearm.lumos,
};
(window as any).__sound = sound;
(window as any).__notify = notifier;
