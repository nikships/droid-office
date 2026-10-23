import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { floorPalette } from '../shared/floors';
import { beanbagsOut, DESK_BY_ID } from '../shared/layout';
import type { WorkerInfo } from '../shared/protocol';
import { isAsleep } from '../shared/status';
import { teamLinks } from '../shared/team';
import { forkLinks } from '../shared/worker-fork';
import { waitingOnSomeone } from './notify';
import {
  blendView,
  cameraAt,
  clampTarget,
  easeInOut,
  easeOut,
  focusView,
  homeView,
  MAP_FOV,
  MAX_ZOOM_OUT,
  MIN_DISTANCE,
  type MapDirection,
  type MapView,
  nearestInDirection,
  type SeatSpot,
  seatSpot,
  tagsDotsOnly,
  tagsExpanded,
  tagWidth,
  type TagBox,
  tuckedTags,
  viewOf,
} from './office-map-view';
import { h } from './ui/dom';
import { setTeamKit, setWorkerModel, Worker } from './world/character';
import { buildFloorMap, type FloorMap, type MapSeat } from './world/floor-map';
import { Laptop, type ScreenState } from './world/laptop';
import { loadPropManifest, preloadProps, propScene } from './world/props';
import { TeamLines, type TeamLink } from './world/team-lines';

/**
 * The web companion's Overview: the floor as a live dollhouse seen from above (world/floor-map.ts),
 * with every worker at its real desk, its laptop showing its terminal, and a name tag over its head.
 * Click a worker (or its tag) to fly in and open its terminal; click a free desk to hire there.
 * The page around it (dashboard.ts) owns the data; this draws it and reports what was clicked.
 */

/** Which floor the map shows, and how it looks. */
export interface MapFloor {
  id: string;
  name: string;
  palette: number;
  plain: boolean;
  /** The building's bottom floor, the only one with an exit door. */
  bottom: boolean;
}

/** What a worker's tag and card say, worded by the page (so the map and the list agree). */
export interface MapWords {
  status: string;
  doing: string;
  kind: string;
  /** A short chip after it: the model, a branch, a PR number. */
  chip?: string;
}

export interface OfficeMapHooks {
  /** A worker was clicked: open it. */
  open(id: string): void;
  /** A free desk was clicked. */
  hire(deskId: string): void;
  /** Whether a click on a free desk can hire right now. */
  canHire(): boolean;
  screen(id: string): ScreenState | undefined;
  /** Fills the hover card's live terminal preview. */
  preview(into: HTMLElement, id: string): void;
  words(w: WorkerInfo): MapWords;
  /** The highlighted worker changed (hover, keys or a roster chip), or '' for none. */
  focused?(id: string): void;
  /** WebGL went away: the page shows its grid instead. */
  lost?(): void;
}

/** The props the map is built from, fetched once and shared (props.ts caches them for the page). */
const MAP_PROPS = [
  'workbench',
  'task-chair',
  'macbook-base',
  'macbook-lid',
  'droid-worker',
  'droid-team-kit',
  'agent-kiosk',
  'lounge-sofa',
  'lounge-table',
  'lounge-beanbag',
  'conference-table',
  'droid-rack',
  'balcony-bench',
  'balcony-stool',
  'balcony-table',
  'loft-couch',
  'executive-desk',
  'loft-stairs',
  'merge-gong',
  'bookshelf',
  'jukebox',
  'robot-arm',
  'conveyor',
] as const;

/** The status light colors, the same as the droids' beacon bulbs (world/character.ts). */
const STATUS_COLOR: Record<string, string> = {
  starting: '#8c8c8c',
  idle: '#5aa9e6',
  working: '#f2b84b',
  needs_input: '#ef4444',
  done: '#3ccf91',
  exited: '#6c757d',
  offline: '#6c757d',
};
const ACCENT = '#ee6018';
/** A map laptop's screen canvas: enough to read a line from close up, light enough to refresh a floorful. */
const MAP_SCREEN = { width: 1024, height: 680 } as const;

interface Seated {
  info: WorkerInfo;
  model: Worker;
  laptop: Laptop | null;
  seat: MapSeat;
  spot: SeatSpot;
  tag: HTMLButtonElement;
  tagKey: string;
  /** The tag's size shown in full, measured while it isn't tucked. */
  tagSize: { w: number; h: number };
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  status: string;
  acked: boolean;
}

interface Flight {
  from: MapView;
  to: MapView;
  start: number;
  ms: number;
  ease: (t: number) => number;
  done: () => void;
}

const reduceMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;

/** A soft round glow, white in the middle and clear at the edge, tinted by the material. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The dark ground far under the building: a faint survey grid that fades out to the edge of the world. */
function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, 1024, 1024);
  const step = 1024 / 60;
  for (let i = 0; i <= 60; i++) {
    ctx.fillStyle = i % 5 === 0 ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.025)';
    ctx.fillRect(Math.round(i * step), 0, 1, 1024);
    ctx.fillRect(0, Math.round(i * step), 1024, 1);
  }
  const fade = ctx.createRadialGradient(512, 512, 120, 512, 512, 512);
  fade.addColorStop(0, 'rgba(5,5,5,0)');
  fade.addColorStop(1, 'rgba(5,5,5,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 1024, 1024);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hideLabels(root: THREE.Object3D) {
  // The page draws names and cards in the DOM, crisp at any zoom; the droid's own floating sprites stay hidden.
  for (const child of root.children) if ((child as THREE.Sprite).isSprite) child.visible = false;
}

export class OfficeMap {
  /** True when this browser can draw the map at all. */
  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  readonly el: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(MAP_FOV, 1, 0.5, 400);
  private readonly controls: MapControls;
  private readonly map: FloorMap;
  private readonly lines = new TeamLines();
  private readonly tags: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardPreview: HTMLElement;
  private readonly vacancy: HTMLElement;
  private readonly seated = new Map<string, Seated>();
  private readonly ringGeo = new THREE.RingGeometry(0.66, 0.74, 56).rotateX(-Math.PI / 2);
  private readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly haloRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly tmp = new THREE.Vector3();
  private floor: MapFloor | undefined;
  private raf = 0;
  private active = false;
  private last = 0;
  private clock = 0;
  private flight: Flight | null = null;
  /** The flight under way is to the whole floor, so a resize mid-way retargets it to the new framing. */
  private homing = false;
  /** Where the camera was before flying in to a worker, to fly back out to. */
  private returnView: MapView | null = null;
  /** The owner moved the camera themselves: a resize keeps their view rather than refitting the floor. */
  private moved = false;
  private hovered = '';
  /** The highlighted worker by keys or roster, which a hover overrides while it lasts. */
  private cursor = '';
  private hoverDesk = '';
  private down: { x: number; y: number; at: number } | null = null;
  private cardFor = '';
  /** Whether the cursor (not a hover) shows its card: yes for keys and the roster, no for coming back from a terminal. */
  private cursorCard = false;
  private cardAt = 0;
  /** The last pointer was a finger or a pen: a tap shows a worker's card first, and a second tap opens it. */
  private touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  /** A free desk a tap picked: its "Hire here" stays up for a second tap. */
  private tapDesk = '';
  private propsIn = false;
  private size = { w: 1, h: 1 };
  /** The page's panels over the map's left and bottom edges (px): the camera frames the floor beside them. */
  private inset = { left: 0, bottom: 0, top: 0 };
  private resize: ResizeObserver;
  private pxPerMeter = 30;
  private slow = 0;
  private dpr: number;
  readonly ready: Promise<void>;

  constructor(private readonly hooks: OfficeMapHooks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.className = 'omap-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stop();
      this.hooks.lost?.();
    });

    const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.background = new THREE.Color('#050505');
    this.scene.add(new THREE.HemisphereLight('#e4ebf5', '#1d1712', 1.25));
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.12));
    const key = new THREE.DirectionalLight('#ffe9d2', 2.3);
    key.position.set(-14, 28, 18);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -24, right: 24, top: 20, bottom: -20, near: 2, far: 80 });
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.03;
    this.scene.add(key, key.target);
    const rim = new THREE.DirectionalLight('#7f95ff', 0.55);
    rim.position.set(20, 14, -18);
    this.scene.add(rim);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: groundTexture() }));
    ground.position.y = -4.7;
    this.scene.add(ground);

    this.map = buildFloorMap();
    this.scene.add(this.map.group);
    this.map.group.add(this.lines.group);

    const glowMap = glowTexture();
    this.halo = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowMap, color: ACCENT, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    this.halo.renderOrder = 2;
    this.haloRing = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.94, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    this.haloRing.renderOrder = 3;
    this.scene.add(this.halo, this.haloRing);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = 1.12;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.addEventListener('start', () => {
      this.moved = true;
      this.cancelFlight();
    });

    this.tags = h('div.omap-tags');
    this.cardPreview = h('pre.dash-preview.omap-card-preview', { 'aria-hidden': 'true' });
    this.card = h('div.omap-card', { 'aria-hidden': 'true' });
    this.vacancy = h('div.omap-vacant', { 'aria-hidden': 'true' }, h('span.omap-vacant-plus', {}, '+'), h('span', {}, 'Hire here'));
    this.el = h('div.omap', {}, canvas, h('div.omap-vignette'), this.tags, this.vacancy, this.card);
    // Fade in once: coming back from a terminal re-attaches the map, which would replay the fade.
    this.el.addEventListener('animationend', (e) => e.target === this.el && this.el.classList.add('settled'), { once: false });
    this.card.addEventListener('click', () => this.cardFor && this.hooks.open(this.cardFor));
    this.vacancy.addEventListener('click', () => {
      const desk = this.tapDesk;
      if (!desk || !this.hireable(desk)) return;
      this.tapDesk = '';
      this.paintHighlight();
      this.hooks.hire(desk);
    });

    canvas.addEventListener('pointerdown', (e) => {
      this.touch = e.pointerType !== 'mouse';
      this.down = { x: e.clientX, y: e.clientY, at: performance.now() };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType !== 'mouse') return;
      this.pick(e.clientX, e.clientY);
    });
    // A finger "leaves" as it lifts, which would drop what the tap just lit.
    canvas.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && this.setHover('', ''));
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > (this.touch ? 12 : 6) || performance.now() - d.at > 600) return;
      if (this.touch) return this.tap(e.clientX, e.clientY);
      this.pick(e.clientX, e.clientY);
      this.click();
    });
    canvas.addEventListener('dblclick', (e) => {
      // Double-click the floor to fly a step closer there.
      const p = this.floorPoint(e.clientX, e.clientY);
      if (!p || this.hovered) return;
      const now = this.view();
      this.fly({ ...now, x: p.x, z: p.z, distance: Math.max(MIN_DISTANCE, now.distance * 0.6) }, 650, easeInOut);
    });

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.el);

    this.applyView(homeView(16 / 9));
    this.ready = loadPropManifest()
      .then(() => preloadProps(MAP_PROPS))
      .then(() => {
        const worker = propScene('droid-worker');
        if (worker) setWorkerModel(worker);
        const kit = propScene('droid-team-kit');
        if (kit) setTeamKit(kit);
        this.map.installProps();
        this.propsIn = true;
        for (const s of this.seated.values()) {
          s.model.fillModel();
          this.shadows(s.model.root);
          if (s.laptop) this.shadows(s.laptop.root);
        }
      })
      .catch((err) => console.warn('office map: prop GLBs unavailable, keeping stand-ins', err));
  }

  // ---- What it shows --------------------------------------------------------------------------------

  /** Shows `floor` with `workers` at their desks. */
  sync(workers: Iterable<WorkerInfo>, floor: MapFloor | undefined) {
    const list = [...workers].filter((w) => DESK_BY_ID.has(w.deskId));
    if (floor && floor.id !== this.floor?.id) {
      const first = !this.floor;
      for (const id of [...this.seated.keys()]) this.unseat(id);
      this.floor = floor;
      this.map.setLook(floorPalette(floor.palette));
      this.map.setPlain(floor.plain);
      this.map.setBottom(floor.bottom);
      this.map.setName(floor.name);
      this.moved = false;
      this.returnView = null;
      this.cursor = '';
      this.tapDesk = '';
      this.arrive(first);
    } else if (floor) {
      if (floor.name !== this.floor?.name) this.map.setName(floor.name);
      if (floor.plain !== this.floor?.plain) this.map.setPlain(floor.plain);
      if (floor.bottom !== this.floor?.bottom) this.map.setBottom(floor.bottom);
      this.floor = floor;
    }
    const here = new Set(list.map((w) => w.id));
    for (const id of [...this.seated.keys()]) if (!here.has(id) || this.seated.get(id)!.info.deskId !== list.find((w) => w.id === id)?.deskId) this.unseat(id);
    const taken = new Set(list.map((w) => w.deskId));
    this.map.setBeanbags(beanbagsOut((id) => taken.has(id)));
    for (const w of list) this.seat(w);
    this.syncLines(list);
    if (this.cursor && !this.seated.has(this.cursor)) this.cursor = '';
    if (this.tapDesk && !this.hireable(this.tapDesk)) this.tapDesk = '';
    if (this.hovered && !this.seated.has(this.hovered)) this.hovered = '';
    this.paintHighlight();
  }

  private seat(w: WorkerInfo) {
    let s = this.seated.get(w.id);
    const seat = this.map.seats.get(w.deskId);
    const spot = seatSpot(w.deskId);
    if (!seat || !spot) return;
    if (!s) {
      const model = new Worker(w.name, w.color);
      seat.seatAnchor.add(model.root);
      const laptop = seat.laptopAnchor ? new Laptop(MAP_SCREEN) : null;
      if (laptop) seat.laptopAnchor!.add(laptop.root);
      if (seat.chair) {
        seat.chair.userData.restY ??= seat.chair.rotation.y;
        seat.chair.rotation.y = 0;
      }
      const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: STATUS_COLOR.idle, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false }));
      ring.position.set(spot.x, 0.02, spot.z);
      ring.renderOrder = 2;
      this.map.group.add(ring);
      const tag = h('button.omap-tag', { type: 'button', tabindex: '-1', 'data-worker': w.id }) as HTMLButtonElement;
      tag.addEventListener('pointerdown', (e) => {
        this.touch = e.pointerType !== 'mouse';
      });
      tag.addEventListener('click', () => (this.touch ? this.tapWorker(w.id) : this.hooks.open(w.id)));
      tag.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && this.setHover(w.id, w.deskId));
      tag.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && this.setHover('', ''));
      this.tags.append(tag);
      s = { info: w, model, laptop, seat, spot, tag, tagKey: '', tagSize: { w: 0, h: 0 }, ring, status: '', acked: true };
      this.seated.set(w.id, s);
      if (this.propsIn) {
        this.shadows(model.root);
        if (laptop) this.shadows(laptop.root);
      }
    }
    s.info = w;
    if (s.status !== w.status || s.acked !== w.acked) {
      if (w.status === 'done' && s.status === 'working') s.model.celebrate();
      s.status = w.status;
      s.acked = w.acked;
      s.model.setStatus(w.status, waitingOnSomeone(w));
      s.ring.material.color.set(STATUS_COLOR[w.status] ?? STATUS_COLOR.idle);
    }
    s.model.setAction(w.action);
    s.model.setTeam(w.team);
    hideLabels(s.model.root);
    const asleep = isAsleep(w.status);
    s.laptop?.setPlaceholder(w.guest ? 'Running outside the office' : w.cloud ? `On ${w.cloud.computerName}` : w.lost ? 'Worktree deleted' : asleep ? `${w.name} is asleep` : w.status === 'exited' ? `${w.name} exited` : 'booting…');
    this.paintTag(s);
  }

  private unseat(id: string) {
    const s = this.seated.get(id);
    if (!s) return;
    s.model.root.removeFromParent();
    s.model.dispose();
    if (s.laptop) {
      s.laptop.root.removeFromParent();
      s.laptop.dispose();
    }
    if (s.seat.chair && typeof s.seat.chair.userData.restY === 'number') s.seat.chair.rotation.y = s.seat.chair.userData.restY;
    s.ring.removeFromParent();
    s.ring.material.dispose();
    s.tag.remove();
    this.seated.delete(id);
  }

  private syncLines(list: WorkerInfo[]) {
    const at = (deskId: string) => {
      const s = seatSpot(deskId);
      return s && { x: s.x, y: 0, z: s.z };
    };
    const links: TeamLink[] = [];
    for (const l of teamLinks(list)) {
      const from = at(l.lead.deskId);
      const to = at(l.member.deskId);
      if (from && to) links.push({ from, to, color: l.accent, team: l.team, moving: l.moving });
    }
    for (const { source, twin } of forkLinks(list)) {
      const from = at(source.deskId);
      const to = at(twin.deskId);
      if (from && to) links.push({ from, to, color: twin.color, team: `fork:${source.id}`, moving: twin.status === 'working' });
    }
    this.lines.set(links);
  }

  private paintTag(s: Seated) {
    const w = s.info;
    const words = this.hooks.words(w);
    const key = JSON.stringify([w.name, w.color, w.status, words]);
    if (key === s.tagKey) return;
    s.tagKey = key;
    s.tag.dataset.status = w.status;
    s.tag.classList.toggle('attn', w.status === 'needs_input');
    s.tag.classList.toggle('asleep', isAsleep(w.status));
    s.tag.style.setProperty('--who', w.color);
    s.tag.setAttribute('aria-label', `${w.name}, ${words.status}: ${words.doing}`);
    s.tag.replaceChildren(h('span.omap-tag-dot', { 'aria-hidden': 'true' }), h('span.omap-tag-text', {}, h('span.omap-tag-name', {}, w.name), h('span.omap-tag-doing', {}, w.status === 'needs_input' ? 'Needs you' : words.doing)));
    if (this.cardFor === w.id) this.fillCard(s);
  }

  // ---- Highlight, hover and the card ---------------------------------------------------------------

  private setHover(id: string, deskId: string) {
    if (id === this.hovered && deskId === this.hoverDesk) return;
    this.hovered = id;
    this.hoverDesk = deskId;
    this.el.classList.toggle('pointing', !!id || (!!deskId && this.hireable(deskId)));
    this.paintHighlight();
  }

  /** The worker lit up now: the one under the pointer, else the keys' or roster's. */
  get focusedId(): string {
    return this.hovered || this.cursor;
  }

  /** Highlights `id` from outside the map (a roster chip, the arrow keys), keeping it in view. */
  setCursor(id: string, reveal = true) {
    this.cursor = this.seated.has(id) ? id : '';
    this.cursorCard = !!this.cursor;
    this.paintHighlight();
    if (reveal && this.cursor) this.reveal(this.cursor);
  }

  /** The free desk lit up now: the one under the pointer, else the one a tap picked. */
  private get litDesk(): string {
    return this.hoverDesk || this.tapDesk;
  }

  private paintHighlight() {
    const id = this.focusedId;
    const desk = this.litDesk;
    for (const [wid, s] of this.seated) s.tag.classList.toggle('on', wid === id);
    const s = this.seated.get(id);
    if (s) {
      const color = s.info.status === 'needs_input' ? STATUS_COLOR.needs_input : ACCENT;
      this.halo.material.color.set(color);
      this.haloRing.material.color.set(color);
      this.halo.position.set(s.spot.x, 0.03, s.spot.z);
      this.haloRing.position.set(s.spot.x, 0.035, s.spot.z);
    } else if (desk && this.hireable(desk)) {
      const spot = seatSpot(desk);
      if (spot) {
        this.halo.material.color.set(ACCENT);
        this.haloRing.material.color.set(ACCENT);
        this.halo.position.set(spot.x, 0.03, spot.z);
        this.haloRing.position.set(spot.x, 0.035, spot.z);
      }
    }
    if (s && this.cardFor !== id) {
      this.cardFor = id;
      this.fillCard(s);
    } else if (!s) this.cardFor = '';
    const card = !!s && (!!this.hovered || this.cursorCard);
    const vacant = !s && !!desk && this.hireable(desk);
    this.card.classList.toggle('show', card);
    this.card.classList.toggle('tap', card && this.touch);
    this.vacancy.classList.toggle('show', vacant);
    this.vacancy.classList.toggle('tap', vacant && this.touch);
    this.hooks.focused?.(id);
  }

  private fillCard(s: Seated) {
    const w = s.info;
    const words = this.hooks.words(w);
    this.card.style.setProperty('--who', w.color);
    this.card.dataset.status = w.status;
    this.card.replaceChildren(
      h(
        'div.omap-card-head',
        {},
        h('span.omap-card-dot', { 'aria-hidden': 'true' }),
        h('span.omap-card-titles', {}, h('b', {}, w.name), h('small', {}, [words.kind, words.chip].filter(Boolean).join(' · '))),
        h('span.pill', { class: w.status }, words.status),
      ),
      h('p.omap-card-doing', {}, words.doing),
      this.cardPreview,
      this.touch
        ? h('div.omap-card-foot', {}, h('span', {}, `Tap again to ${w.guest ? 'see what the office knows' : isAsleep(w.status) ? 'wake it' : 'open its terminal'}`))
        : h('div.omap-card-foot', {}, h('span.key', {}, '↵'), h('span', {}, w.guest ? 'See what the office knows' : isAsleep(w.status) ? 'Open to wake it' : 'Open its terminal')),
    );
    this.hooks.preview(this.cardPreview, w.id);
    this.cardAt = performance.now();
  }

  private hireable(deskId: string): boolean {
    const def = DESK_BY_ID.get(deskId);
    if (!def || def.station || !this.hooks.canHire()) return false;
    for (const s of this.seated.values()) if (s.info.deskId === deskId) return false;
    return this.map.seats.get(deskId)?.group.visible ?? false;
  }

  // ---- Pointer -----------------------------------------------------------------------------------

  private ndc(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pick(x: number, y: number) {
    this.ndc(x, y);
    const hits = this.raycaster.intersectObjects(
      this.map.hits.filter((m) => m.visible && m.parent?.visible !== false),
      false,
    );
    const deskId = (hits[0]?.object.userData.deskId as string | undefined) ?? '';
    let id = '';
    for (const [wid, s] of this.seated) if (s.info.deskId === deskId) id = wid;
    this.setHover(id, deskId);
  }

  private floorPoint(x: number, y: number): THREE.Vector3 | null {
    this.ndc(x, y);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p);
  }

  private click() {
    if (this.hovered) this.hooks.open(this.hovered);
    else if (this.hoverDesk && this.hireable(this.hoverDesk)) this.hooks.hire(this.hoverDesk);
  }

  /** A tap on a touch screen: a worker shows its card, a free desk its "Hire here"; tapping either again goes ahead. */
  private tap(x: number, y: number) {
    this.pick(x, y);
    const id = this.hovered;
    const desk = this.hoverDesk;
    this.hovered = '';
    this.hoverDesk = '';
    if (id) return this.tapWorker(id);
    const again = desk && desk === this.tapDesk;
    this.tapDesk = desk && this.hireable(desk) && !again ? desk : '';
    this.cursor = '';
    this.paintHighlight();
    if (again && this.hireable(desk)) this.hooks.hire(desk);
  }

  private tapWorker(id: string) {
    this.tapDesk = '';
    if (this.cursor === id && this.cursorCard) return this.hooks.open(id);
    // Refill the card, so its footer says to tap rather than press Enter.
    this.cardFor = '';
    this.setCursor(id);
  }

  // ---- Keys ------------------------------------------------------------------------------------------

  /** Moves the highlight to the next worker that way on screen; returns who it's on. */
  move(dir: MapDirection): string {
    const all = [...this.seated.values()];
    if (!all.length) return '';
    const from = this.seated.get(this.focusedId);
    let next: Seated | undefined;
    if (from)
      next = nearestInDirection(
        from.spot,
        dir,
        all.map((s) => Object.assign({ s }, { x: s.spot.x, z: s.spot.z })),
        this.view().yaw,
      )?.s;
    else {
      // Nothing lit yet: start from whoever is nearest the middle of the screen.
      const v = this.view();
      next = all.reduce((a, b) => (Math.hypot(a.spot.x - v.x, a.spot.z - v.z) <= Math.hypot(b.spot.x - v.x, b.spot.z - v.z) ? a : b));
    }
    if (next) {
      this.hovered = '';
      this.setCursor(next.info.id);
    }
    return this.focusedId;
  }

  // ---- Camera ------------------------------------------------------------------------------------

  private view(): MapView {
    return viewOf(this.camera.position, this.controls.target);
  }

  private applyView(v: MapView) {
    const p = cameraAt(v);
    this.camera.position.set(p.x, p.y, p.z);
    this.controls.target.set(v.x, 0, v.z);
    this.camera.lookAt(this.controls.target);
  }

  private fly(to: MapView, ms: number, ease: (t: number) => number): Promise<void> {
    this.cancelFlight();
    this.homing = false;
    if (!ms || reduceMotion?.matches || !this.active) {
      this.applyView(to);
      this.controls.update();
      return Promise.resolve();
    }
    return new Promise((done) => {
      this.controls.enabled = false;
      this.flight = { from: this.view(), to, start: performance.now(), ms, ease, done };
    });
  }

  private cancelFlight() {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    this.controls.enabled = true;
    f.done();
  }

  private arrive(first: boolean) {
    const home = homeView(this.aspect());
    if (first) {
      // The first look: swing down and round from high over the street onto the floor.
      this.applyView({ ...home, distance: home.distance * 1.55, yaw: home.yaw - 0.75, pitch: 1.32 });
      void this.fly(home, 2400, easeOut);
    } else void this.fly(home, 900, easeInOut);
    this.homing = true;
  }

  /** Back to the whole floor. */
  home() {
    this.moved = false;
    const flight = this.fly(homeView(this.aspect()), 800, easeInOut);
    this.homing = true;
    return flight;
  }

  zoom(factor: number) {
    const v = this.view();
    const max = homeView(this.aspect()).distance * MAX_ZOOM_OUT;
    this.moved = true;
    return this.fly({ ...v, distance: Math.min(max, Math.max(MIN_DISTANCE, v.distance * factor)) }, 320, easeOut);
  }

  /** Flies in to `id`'s desk, and remembers the view to come back out to. */
  async flyTo(id: string): Promise<void> {
    const s = this.seated.get(id);
    if (!s) return;
    const v = this.view();
    this.returnView = v;
    this.card.classList.remove('show');
    this.el.classList.add('flying');
    await this.fly(focusView(s.spot, v.yaw), 620, easeInOut);
    this.el.classList.remove('flying');
  }

  /** Coming back from `id`'s terminal: start close in at its desk and pull back out. */
  returnFrom(id: string) {
    const s = this.seated.get(id);
    const back = this.returnView ?? homeView(this.aspect());
    this.returnView = null;
    if (s) this.applyView(focusView(s.spot, back.yaw));
    this.cursor = s ? id : '';
    this.cursorCard = false;
    this.hovered = '';
    this.paintHighlight();
    return this.fly(back, 900, easeOut);
  }

  /** Pans just enough to bring `id` into the middle part of the screen. */
  private reveal(id: string) {
    const s = this.seated.get(id);
    if (!s || this.flight) return;
    this.tmp.set(s.spot.x, s.spot.head, s.spot.z).project(this.camera);
    if (Math.abs(this.tmp.x) < 0.7 && Math.abs(this.tmp.y) < 0.62) return;
    const v = this.view();
    void this.fly({ ...v, x: s.spot.x + Math.sin(v.yaw) * 1.5, z: s.spot.z + Math.cos(v.yaw) * 1.5 }, 450, easeInOut);
  }

  /** Keeps the floor framed in the part of the map that `left`, `bottom` and `top` pixels of panels leave clear. */
  setInsets(left: number, bottom: number, top = 0) {
    const next = { left: Math.max(0, Math.round(left)), bottom: Math.max(0, Math.round(bottom)), top: Math.max(0, Math.round(top)) };
    if (next.left === this.inset.left && next.bottom === this.inset.bottom && next.top === this.inset.top) return;
    this.inset = next;
    this.size = { w: 0, h: 0 };
    this.fit();
  }

  /** The clear part's width over its height, which the camera's frustum is sized for. */
  private aspect() {
    const { left, bottom, top } = this.clear();
    return (this.size.w - left) / (this.size.h - bottom - top);
  }

  /** The insets, shrunk if the map is too small to leave a useful clear part. */
  private clear() {
    const fits = this.inset.bottom + this.inset.top < this.size.h * 0.6;
    return { left: this.inset.left < this.size.w * 0.6 ? this.inset.left : 0, bottom: fits ? this.inset.bottom : 0, top: fits ? this.inset.top : 0 };
  }

  private fit() {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const hgt = Math.max(1, Math.round(r.height));
    if (w === this.size.w && hgt === this.size.h) return;
    this.size = { w, h: hgt };
    this.renderer.setSize(w, hgt, false);
    this.composer.setSize(w, hgt);
    this.bloom.resolution.set(w, hgt);
    const { left, bottom, top } = this.clear();
    this.camera.aspect = (w - left) / (hgt - bottom - top);
    // The frustum covers the clear part; the canvas extends past it, under the panels.
    if (left || bottom || top) this.camera.setViewOffset(w - left, hgt - bottom - top, -left, -top, w, hgt);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    const home = homeView(this.aspect());
    this.controls.maxDistance = home.distance * MAX_ZOOM_OUT;
    if (!this.moved && !this.returnView) {
      if (!this.flight) this.applyView(home);
      else if (this.homing) this.flight.to = home;
    }
    if (this.active) this.render(performance.now());
  }

  // ---- The frame loop ------------------------------------------------------------------------------

  /** Draws while the map is on screen; stops drawing (and its laptops refreshing) while it isn't. */
  start() {
    if (this.active) return;
    this.active = true;
    this.last = performance.now();
    this.fit();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.cancelFlight();
  }

  private frame = (now: number) => {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    this.render(now);
  };

  private render(now: number) {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.clock += dt;
    const t = this.clock;
    const f = this.flight;
    if (f) {
      const k = Math.min(1, (now - f.start) / f.ms);
      this.applyView(blendView(f.from, f.to, f.ease(k)));
      if (k >= 1) {
        this.flight = null;
        this.controls.enabled = true;
        f.done();
      }
    } else {
      this.controls.update();
      const c = clampTarget(this.controls.target.x, this.controls.target.z);
      const dx = c.x - this.controls.target.x;
      const dz = c.z - this.controls.target.z;
      if (dx || dz) {
        this.controls.target.x += dx;
        this.controls.target.z += dz;
        this.camera.position.x += dx;
        this.camera.position.z += dz;
      }
    }
    this.map.update(t, dt);
    this.lines.update(dt);
    const cam = this.camera.position;
    for (const s of this.seated.values()) {
      s.model.update(dt, t);
      if (s.laptop) {
        const d = Math.hypot(s.spot.x - cam.x, 1 - cam.y, s.spot.z - cam.z);
        // Close in, a screen refreshes as often as in the office; across the floor, every second or so.
        s.laptop.update(dt, this.hooks.screen(s.info.id), d < 9 ? 0 : d * 0.42);
      }
      const st = s.info.status;
      const m = s.ring.material;
      if (st === 'needs_input') {
        const p = (Math.sin(t * 5) + 1) / 2;
        m.opacity = 0.55 + p * 0.45;
        s.ring.scale.setScalar(1 + p * 0.12);
      } else {
        m.opacity = st === 'working' ? 0.55 + Math.sin(t * 2.2) * 0.15 : isAsleep(st) ? 0.18 : 0.42;
        s.ring.scale.setScalar(1);
      }
    }
    const lit = !!this.focusedId || (!!this.litDesk && this.hireable(this.litDesk));
    const target = lit ? 1 : 0;
    const hm = this.halo.material;
    hm.opacity += (target * 0.55 - hm.opacity) * Math.min(1, dt * 10);
    this.haloRing.material.opacity += (target * 0.95 - this.haloRing.material.opacity) * Math.min(1, dt * 12);
    this.haloRing.rotation.y += dt * 0.6;
    this.haloRing.scale.setScalar(1 + Math.sin(t * 3) * 0.04);
    this.composer.render(dt);
    this.placeTags(now);
    this.adapt(dt);
  }

  /** Puts each tag over its worker's head, and the card by the lit one. */
  private placeTags(now: number) {
    const { w, h: hgt } = this.size;
    // How many pixels a metre of floor at the aim point spans, for the tags' width and detail.
    this.tmp.copy(this.controls.target).project(this.camera);
    const ax = this.tmp.x;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.tmp.copy(this.controls.target).add(right).project(this.camera);
    this.pxPerMeter = (Math.abs(this.tmp.x - ax) * w) / 2;
    this.tags.style.setProperty('--tag-w', `${tagWidth(this.pxPerMeter)}px`);
    this.el.classList.toggle('near', tagsExpanded(this.pxPerMeter));
    this.el.classList.toggle('far', tagsDotsOnly(this.pxPerMeter));
    const lit = this.focusedId;
    // Read every tag's size first and write after, so the frame lays the page out once.
    const boxes: (TagBox & { s: Seated; visible: boolean })[] = [];
    for (const [id, s] of this.seated) {
      const bob = s.info.status === 'needs_input' ? 0.12 : 0;
      this.tmp.set(s.spot.x, s.spot.head + 0.28 + bob, s.spot.z).project(this.camera);
      const visible = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.15 && Math.abs(this.tmp.y) < 1.15;
      if (visible && !s.tag.classList.contains('tucked') && !s.tag.hidden) s.tagSize = { w: s.tag.offsetWidth, h: s.tag.offsetHeight };
      const x = Math.round(((this.tmp.x + 1) / 2) * w);
      const y = Math.round(((1 - this.tmp.y) / 2) * hgt);
      boxes.push({ id, s, visible, x, y, w: s.tagSize.w || 80, h: s.tagSize.h || 24, depth: this.tmp.z, keep: id === lit || s.info.status === 'needs_input' });
    }
    const tucked = tuckedTags(boxes.filter((b) => b.visible));
    for (const b of boxes) {
      const { s, id } = b;
      s.tag.hidden = !b.visible;
      s.tag.classList.toggle('tucked', tucked.has(id));
      s.tag.style.transform = `translate3d(${b.x}px, ${b.y}px, 0)`;
      // Nearer tags draw over farther ones.
      s.tag.style.zIndex = id === lit ? '1000' : String(Math.round((1 - b.depth) * 900));
      if (id === lit) this.placeCard(b.x, b.y);
    }
    if (!lit && this.vacancy.classList.contains('show')) {
      const spot = seatSpot(this.litDesk);
      if (spot) {
        this.tmp.set(spot.x, 1.2, spot.z).project(this.camera);
        this.vacancy.style.transform = `translate3d(${Math.round(((this.tmp.x + 1) / 2) * w)}px, ${Math.round(((1 - this.tmp.y) / 2) * hgt)}px, 0)`;
      }
    }
    // The card's live preview, a few times a second.
    if (this.cardFor && now - this.cardAt > 350) {
      this.cardAt = now;
      this.hooks.preview(this.cardPreview, this.cardFor);
    }
  }

  private placeCard(x: number, y: number) {
    const { w, h: hgt } = this.size;
    const cw = this.card.offsetWidth || 340;
    const ch = this.card.offsetHeight || 260;
    // Above the tag when there's room, else below it; never off either side.
    const above = y - ch - 34 > 8;
    const left = Math.min(w - cw - 12, Math.max(12 + this.clear().left, x - cw / 2));
    const top = above ? y - ch - 34 : Math.min(hgt - ch - 12, y + 30);
    this.card.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    this.card.classList.toggle('below', !above);
  }

  /** A slow machine draws at a lower resolution rather than stuttering. */
  private adapt(dt: number) {
    this.slow = this.slow * 0.97 + (dt > 1 / 40 ? 1 : 0) * 0.03;
    if (this.slow > 0.6 && this.dpr > 1) {
      this.dpr = Math.max(1, this.dpr - 0.25);
      this.renderer.setPixelRatio(this.dpr);
      this.composer.setPixelRatio(this.dpr);
      this.slow = 0;
    }
  }

  private shadows(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (mat instanceof THREE.MeshToonMaterial && !mat.transparent) m.castShadow = true;
    });
  }

  dispose() {
    this.stop();
    this.resize.disconnect();
    for (const id of [...this.seated.keys()]) this.unseat(id);
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.el.remove();
  }
}
