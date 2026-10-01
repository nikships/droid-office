/**
 * Streams the page's live three.js scene to the headset's native GLES renderer.
 *
 * The page keeps running the office as it always does (its scene graph, gameplay, raycasting); in
 * native mode it just stops drawing. `capture()` walks the scene at the gameplay rate and records
 * what changed since the last capture: new or edited geometries, materials, textures and objects,
 * moved objects, visibility, lights, fog and the sky's lamp uniforms. `drain()` turns that state into
 * bounded packets (wire.ts) that the native side applies in order. The diff is state-based, so a
 * drain that is skipped or delayed loses nothing: the next one carries the latest state.
 *
 * Nothing here mutates the scene graph. The only writes are the ones three's renderer would make
 * itself on a render: world matrices, bounding spheres, texture matrices and shadow matrices.
 */

import * as THREE from 'three';
import { FLOOR, SLAB, STREET_Y, WALL_T } from '../../shared/layout';
import {
  affine12,
  type Bin,
  type BlendMode,
  type BlobPart,
  bytesToBase64,
  type CameraItem,
  DEFAULT_BUDGET,
  DEFAULT_CHUNK_CHARS,
  type EnvItem,
  type Filter,
  type GeometryItem,
  type InstanceData,
  type LightDirectional,
  type MapRef,
  type MaterialItem,
  type MaterialType,
  type ObjectItem,
  type ObjectKind,
  type Packet,
  packBinary,
  r6,
  rgb,
  type Side,
  type SkyInfo,
  sameAffine,
  type TextureFormat,
  type TextureItem,
  type TextureSampler,
  type Unsupported,
  viewBytes,
  WIRE_VERSION,
  type Wrap,
} from './wire';

/** Encodes an image source for the wire. Tests inject their own; the default uses the DOM. */
export type ImageEncoder = (source: unknown, width: number, height: number, opaque: boolean) => Promise<{ fmt: TextureFormat; bytes: Uint8Array }>;

export interface NativeSceneOptions {
  /** Base64 characters per blob part. */
  chunkChars?: number;
  /** Least time between two encodes of one texture (a terminal canvas redraws many times a second). */
  textureIntervalMs?: number;
  /** The same for video textures (the TV), which change every video frame. */
  videoIntervalMs?: number;
  /** Texture encodes running at once. */
  maxEncodes?: number;
  /** Send the moon's shadow camera (three draws it when renderer.shadowMap.enabled). */
  shadows?: boolean;
  encodeImage?: ImageEncoder;
  /** Clock, for texture throttling (tests). */
  now?: () => number;
}

export interface NativeSceneStats {
  objects: number;
  geometries: number;
  materials: number;
  textures: number;
  pendingTextures: number;
  encoding: number;
  packets: number;
  bytes: number;
  lastPacketBytes: number;
  largestPacketBytes: number;
  captureMs: number;
  queued: { geometries: number; materials: number; objects: number; instances: number; transforms: number; textures: number; blobParts: number };
}

export interface NativeSceneReport {
  unsupported: Unsupported[];
  errors: string[];
  stats: NativeSceneStats;
}

// ---- three.js constants as wire names --------------------------------------------------------------

const WRAP: Record<number, Wrap> = { [THREE.RepeatWrapping]: 'repeat', [THREE.ClampToEdgeWrapping]: 'clamp', [THREE.MirroredRepeatWrapping]: 'mirror' };
const FILTER: Record<number, Filter> = {
  [THREE.NearestFilter]: 'nearest',
  [THREE.LinearFilter]: 'linear',
  [THREE.NearestMipmapNearestFilter]: 'nearestMipNearest',
  [THREE.NearestMipmapLinearFilter]: 'nearestMipLinear',
  [THREE.LinearMipmapNearestFilter]: 'linearMipNearest',
  [THREE.LinearMipmapLinearFilter]: 'linearMipLinear',
};
const SIDE: Record<number, Side> = { [THREE.FrontSide]: 'front', [THREE.BackSide]: 'back', [THREE.DoubleSide]: 'double' };
/** The shadow pass draws the other side unless material.shadowSide says otherwise (three's PCF path). */
const SHADOW_SIDE: Record<number, Side> = { [THREE.FrontSide]: 'back', [THREE.BackSide]: 'front', [THREE.DoubleSide]: 'double' };
const BLEND: Record<number, BlendMode> = {
  [THREE.NoBlending]: 'none',
  [THREE.NormalBlending]: 'normal',
  [THREE.AdditiveBlending]: 'additive',
  [THREE.SubtractiveBlending]: 'subtractive',
  [THREE.MultiplyBlending]: 'multiply',
  [THREE.CustomBlending]: 'custom',
};
const EQUATION: Record<number, string> = {
  [THREE.AddEquation]: 'add',
  [THREE.SubtractEquation]: 'subtract',
  [THREE.ReverseSubtractEquation]: 'reverseSubtract',
  [THREE.MinEquation]: 'min',
  [THREE.MaxEquation]: 'max',
};
const FACTOR: Record<number, string> = {
  [THREE.ZeroFactor]: 'zero',
  [THREE.OneFactor]: 'one',
  [THREE.SrcColorFactor]: 'srcColor',
  [THREE.OneMinusSrcColorFactor]: 'oneMinusSrcColor',
  [THREE.SrcAlphaFactor]: 'srcAlpha',
  [THREE.OneMinusSrcAlphaFactor]: 'oneMinusSrcAlpha',
  [THREE.DstAlphaFactor]: 'dstAlpha',
  [THREE.OneMinusDstAlphaFactor]: 'oneMinusDstAlpha',
  [THREE.DstColorFactor]: 'dstColor',
  [THREE.OneMinusDstColorFactor]: 'oneMinusDstColor',
  [THREE.SrcAlphaSaturateFactor]: 'srcAlphaSaturate',
  [THREE.ConstantColorFactor]: 'constantColor',
  [THREE.OneMinusConstantColorFactor]: 'oneMinusConstantColor',
  [THREE.ConstantAlphaFactor]: 'constantAlpha',
  [THREE.OneMinusConstantAlphaFactor]: 'oneMinusConstantAlpha',
};
const DEPTH_FUNC: Record<number, string> = {
  [THREE.NeverDepth]: 'never',
  [THREE.AlwaysDepth]: 'always',
  [THREE.LessDepth]: 'less',
  [THREE.LessEqualDepth]: 'lequal',
  [THREE.EqualDepth]: 'equal',
  [THREE.GreaterEqualDepth]: 'gequal',
  [THREE.GreaterDepth]: 'greater',
  [THREE.NotEqualDepth]: 'notequal',
};

/** Material maps the native renderer draws. Any other map set on a material is reported. */
const DRAWN_MAPS = ['map', 'alphaMap', 'emissiveMap', 'gradientMap'] as const;
const OTHER_MAPS = [
  'aoMap',
  'lightMap',
  'bumpMap',
  'normalMap',
  'displacementMap',
  'specularMap',
  'roughnessMap',
  'metalnessMap',
  'envMap',
  'matcap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'transmissionMap',
  'thicknessMap',
  'iridescenceMap',
  'anisotropyMap',
  'specularIntensityMap',
  'specularColorMap',
] as const;
const ATTRS = ['position', 'normal', 'uv', 'color'] as const;
type AttrName = (typeof ATTRS)[number];

/** Scalar inputs to materialItem. Colors, texture matrices and shader uniforms are sampled below. */
const MATERIAL_FIELDS = [
  'version',
  'type',
  'opacity',
  'transparent',
  'alphaTest',
  'side',
  'shadowSide',
  'depthTest',
  'depthWrite',
  'depthFunc',
  'colorWrite',
  'blending',
  'premultipliedAlpha',
  'blendEquation',
  'blendSrc',
  'blendDst',
  'blendEquationAlpha',
  'blendSrcAlpha',
  'blendDstAlpha',
  'vertexColors',
  'fog',
  'onBeforeCompile',
  'visible',
  'polygonOffset',
  'polygonOffsetFactor',
  'polygonOffsetUnits',
  'wireframe',
  'forceSinglePass',
  'toneMapped',
  'emissiveIntensity',
  'size',
  'sizeAttenuation',
  'rotation',
  'metalness',
  'roughness',
  'clearcoat',
  'shininess',
  'flatShading',
  'linewidth',
] as const;

// ---- Scene-level state ----------------------------------------------------------------------------

type Drawable = THREE.Mesh | THREE.Sprite | THREE.Points | THREE.Line;
type Attr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

interface ObjState {
  id: number;
  obj: Drawable;
  kind: ObjectKind;
  order: number;
  groupOrder: number;
  cast: boolean;
  recv: boolean;
  cull: boolean;
  centerX: number;
  centerY: number;
  name: string;
  geo: number;
  mat: number | number[];
  m: Float32Array;
  /** Controller the object is attached to (m is then grip-relative), or -1 for a world object. */
  hand: -1 | 0 | 1;
  visible: boolean;
  sent: boolean;
  sentVisible: boolean;
  /** InstancedMesh: attribute identity, version and count, when last captured. */
  instanceCount: number;
  instanceMatrix: THREE.InstancedBufferAttribute | null;
  instanceMatrixVersion: number;
  instanceColor: THREE.InstancedBufferAttribute | null;
  instanceColorVersion: number;
}

interface GeoState {
  id: number;
  geo: THREE.BufferGeometry;
  /** sharedKey() when last captured: other geometries with this key draw with this one. */
  key: string | null;
  /** Attribute identities, index identity and version, groups and range: a change sends the whole geometry. */
  shape: string;
  /** Each attribute's version, for partial updates. */
  versions: Partial<Record<AttrName, number>>;
  sentVersions: Partial<Record<AttrName, number>> | null;
  sentShape: string | null;
}

interface MatState {
  id: number;
  mat: THREE.Material;
  item: MaterialItem;
  json: string;
  sentJson: string | null;
  stamp: CaptureStamp;
}

interface TexState {
  id: number;
  tex: THREE.Texture;
  sampler: TextureSampler;
  samplerJson: string;
  /** texture.version and source identity of the pixels last encoded (or being encoded). */
  encodedVersion: number;
  encodedSource: unknown;
  encoding: boolean;
  lastEncodeAt: number;
  retryAt: number;
  /** The last encoded pixels, kept so a stream reset re-sends without re-encoding. */
  pixels: { fmt: TextureFormat; bytes: Uint8Array; w: number; h: number } | null;
  pixelsQueued: boolean;
  sentSamplerJson: string | null;
  sentPixels: boolean;
}

/** A geometry source can share another source's wire id, so cache it separately from GeoState. */
interface GeoSource {
  stamp: CaptureStamp;
  key: string | null;
  capture: number;
  checked: number;
  id: number;
  verifiedWith: GeoSource | null;
  verifiedRevision: number;
  revision: number;
  shape: string;
  versions: Partial<Record<AttrName, number>>;
}

/** Compare a live resource's scalar fields without allocating an array or a signature each frame. */
class CaptureStamp {
  private readonly values: unknown[] = [];
  private cursor = 0;
  private changed = false;
  begin(): void {
    this.cursor = 0;
    this.changed = false;
  }
  add(value: unknown): void {
    if (this.values[this.cursor] !== value) {
      this.values[this.cursor] = value;
      this.changed = true;
    }
    this.cursor++;
  }
  finish(): boolean {
    if (this.values.length !== this.cursor) {
      this.values.length = this.cursor;
      this.changed = true;
    }
    return this.changed;
  }
}

/** Wire items contain only plain objects, arrays and primitives. Compare before serializing. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key in left) if (!sameData(left[key], right[key])) return false;
  for (const key in right) if (!(key in left) && right[key] !== undefined) return false;
  return true;
}

/** A large item waiting for its blob parts to go out first. */
interface Stream {
  parts: BlobPart[];
  next: number;
  /** JSON size of the item itself, without its parts. */
  size: number;
  done: (p: PacketBuilder) => void;
}

class PacketBuilder {
  readonly packet: Packet;
  size: number;
  constructor(
    seq: number,
    readonly budget: number,
  ) {
    this.packet = { v: WIRE_VERSION, seq, commit: false };
    this.size = this.base;
  }
  private readonly base = 64;
  room(): boolean {
    return this.size < this.budget;
  }
  /** True if `n` more characters fit, or nothing has been added yet (an item bigger than a whole packet goes alone). */
  fits(n: number): boolean {
    return this.size + n <= this.budget || this.size <= this.base;
  }
  add<K extends 'textures' | 'geometries' | 'materials' | 'objects' | 'instances' | 'blobs' | 'unsupported'>(key: K, item: NonNullable<Packet[K]>[number], size?: number): void {
    const list = (this.packet[key] ??= [] as never) as unknown[];
    list.push(item);
    this.size += (size ?? JSON.stringify(item).length) + 1;
  }
  empty(): boolean {
    const p = this.packet;
    return !(p.reset || p.blobs || p.textures || p.geometries || p.materials || p.objects || p.instances || p.xf || p.show || p.hide || p.env || p.camera || p.remove || p.unsupported);
  }
}

/** three's built-in shapes, whose vertices follow from their parameters alone. */
const PARAMETRIC = new Set([
  'BoxGeometry',
  'SphereGeometry',
  'CylinderGeometry',
  'ConeGeometry',
  'PlaneGeometry',
  'CircleGeometry',
  'RingGeometry',
  'TorusGeometry',
  'CapsuleGeometry',
  'TorusKnotGeometry',
  'IcosahedronGeometry',
  'OctahedronGeometry',
  'DodecahedronGeometry',
  'TetrahedronGeometry',
]);

/**
 * Two built-in geometries with the same parameters that nothing has edited since (every attribute
 * and the index at version 0, the groups and draw range as built) have the same vertices, so the
 * office's hundreds of identical boxes and cylinders go over the wire once.
 */
function sharedKey(g: THREE.BufferGeometry): string | null {
  const params = (g as THREE.BufferGeometry & { parameters?: Record<string, unknown> }).parameters;
  if (!params || !PARAMETRIC.has(g.type) || g.morphAttributes.position) return null;
  for (const a of Object.values(g.attributes)) if ((a as THREE.BufferAttribute).version !== 0 || (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return null;
  if (g.index && g.index.version !== 0) return null;
  if (g.drawRange.start !== 0 || Number.isFinite(g.drawRange.count)) return null;
  const groups = g.groups.map((gr) => `${gr.start},${gr.count},${gr.materialIndex}`).join(';');
  return `${g.type}|${JSON.stringify(params)}|${Object.keys(g.attributes).sort().join(',')}|${groups}`;
}

/** Parameter names alone are insufficient if an application replaces a built-in shape's buffers. */
function sameGeometry(a: THREE.BufferGeometry, b: THREE.BufferGeometry): boolean {
  for (const name in a.attributes) {
    const left = a.attributes[name] as THREE.BufferAttribute;
    const right = b.attributes[name] as THREE.BufferAttribute | undefined;
    if (!right || left.itemSize !== right.itemSize || left.count !== right.count || left.normalized !== right.normalized || left.array.constructor !== right.array.constructor || left.array.length !== right.array.length) return false;
    for (let i = 0; i < left.array.length; i++) if (left.array[i] !== right.array[i]) return false;
  }
  for (const name in b.attributes) if (!(name in a.attributes)) return false;
  if (!a.index || !b.index) return a.index === b.index;
  if (a.index.count !== b.index.count) return false;
  for (let i = 0; i < a.index.count; i++) if (a.index.getX(i) !== b.index.getX(i)) return false;
  return true;
}

const EMPTY_SPHERE: [number, number, number, number] = [0, 0, 0, -1];

function kindOf(o: THREE.Object3D): ObjectKind | null {
  const a = o as THREE.Object3D & Record<string, unknown>;
  if (a.isInstancedMesh) return 'instanced';
  if (a.isMesh) return 'mesh';
  if (a.isSprite) return 'sprite';
  if (a.isPoints) return 'points';
  if (a.isLineSegments) return 'lines';
  if (a.isLineLoop) return 'lineLoop';
  if (a.isLine) return 'lineStrip';
  return null;
}

function materialType(m: THREE.Material): MaterialType | null {
  const a = m as THREE.Material & Record<string, unknown>;
  if (a.isShaderMaterial || a.isRawShaderMaterial) return 'shader';
  if (a.isMeshToonMaterial) return 'toon';
  if (a.isMeshStandardMaterial) return 'standard';
  if (a.isMeshPhongMaterial) return 'phong';
  if (a.isMeshLambertMaterial) return 'lambert';
  if (a.isMeshBasicMaterial) return 'basic';
  if (a.isPointsMaterial) return 'points';
  if (a.isLineBasicMaterial) return 'line';
  if (a.isSpriteMaterial) return 'sprite';
  return null;
}

/** A subtree drawn on a controller grip: its matrices are sent relative to the grip's world matrix. */
interface Attachment {
  hand: 0 | 1;
  /** The tagged object; its parent is the grip. */
  root: THREE.Object3D;
}

/**
 * The `userData.nativeControllerAttachment` tag's hand: `{ hand: 0 | 1 }` on an object whose parent
 * is that controller's grip group. Anything else is not an attachment.
 */
function attachmentHand(o: THREE.Object3D): 0 | 1 | null | undefined {
  const tag = (o.userData as Record<string, unknown> | undefined)?.nativeControllerAttachment;
  if (tag === undefined || tag === null) return undefined;
  const hand = (tag as { hand?: unknown }).hand;
  return hand === 0 || hand === 1 ? hand : null;
}

/** world/laptop.ts's tag for its terminal screen material; other canvas textures are not tagged. */
function sharpTextTag(m: THREE.Material): boolean {
  return m.userData?.nativeSharpText === true;
}

function sphereOf(s: THREE.Sphere | null): [number, number, number, number] {
  if (!s || s.radius < 0) return EMPTY_SPHERE;
  return [r6(s.center.x), r6(s.center.y), r6(s.center.z), r6(s.radius)];
}

/** An attribute as tightly packed floats (normalized integers denormalized, interleaved unpacked). */
function attrFloats(a: Attr, n: number): Float32Array {
  const count = a.count;
  const plain = a as THREE.BufferAttribute;
  if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && plain.array instanceof Float32Array && !plain.normalized && plain.itemSize === n) {
    return plain.array.length === count * n ? plain.array : plain.array.subarray(0, count * n);
  }
  const out = new Float32Array(count * n);
  const size = a.itemSize;
  for (let i = 0; i < count; i++) {
    const o = i * n;
    out[o] = a.getX(i);
    if (n > 1) out[o + 1] = size > 1 ? a.getY(i) : 0;
    if (n > 2) out[o + 2] = size > 2 ? a.getZ(i) : 0;
    if (n > 3) out[o + 3] = size > 3 ? a.getW(i) : 1;
  }
  return out;
}

function attrWidth(name: AttrName, a: Attr): number {
  if (name === 'uv') return 2;
  if (name === 'color') return a.itemSize === 4 ? 4 : 3;
  return 3;
}

/** Dimensions of a texture source once it can be read, or null while it is still loading. */
function sourceSize(src: unknown): { w: number; h: number } | null {
  if (!src || typeof src !== 'object') return null;
  const s = src as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;
  if (typeof g.HTMLImageElement === 'function' && src instanceof (g.HTMLImageElement as typeof HTMLImageElement)) {
    const img = src as HTMLImageElement;
    return img.complete && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  }
  if (typeof g.HTMLVideoElement === 'function' && src instanceof (g.HTMLVideoElement as typeof HTMLVideoElement)) {
    const v = src as HTMLVideoElement;
    return v.readyState >= 2 && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
  }
  const w = Number(s.width);
  const h = Number(s.height);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Canvas, image, bitmap or video to PNG (JPEG for opaque video) through the DOM. */
export const domImageEncoder: ImageEncoder = async (source, width, height, opaque) => {
  const g = globalThis as Record<string, unknown>;
  const type = opaque ? 'image/jpeg' : 'image/png';
  let blob: Blob | null = null;
  const isCanvas = typeof g.HTMLCanvasElement === 'function' && source instanceof (g.HTMLCanvasElement as typeof HTMLCanvasElement);
  const isOffscreen = typeof g.OffscreenCanvas === 'function' && source instanceof (g.OffscreenCanvas as typeof OffscreenCanvas);
  if (isOffscreen) blob = await (source as OffscreenCanvas).convertToBlob({ type, quality: 0.92 });
  else {
    let canvas: HTMLCanvasElement;
    if (isCanvas) canvas = source as HTMLCanvasElement;
    else {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(source as CanvasImageSource, 0, 0, width, height);
    }
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  }
  if (!blob) throw new Error(`could not encode a ${width}x${height} texture`);
  return { fmt: opaque ? 'jpeg' : 'png', bytes: new Uint8Array(await blob.arrayBuffer()) };
};

/**
 * world/sky.ts adds its lighting to every material through Material.prototype.onBeforeCompile and
 * keeps the uniforms to itself. Running that hook on a stand-in shader hands over the very uniform
 * objects the sky updates each frame, plus the constants it bakes into the GLSL.
 */
interface SkyHook {
  uniforms: Record<string, { value: unknown }>;
  hazeClear: number;
  hazeAbove: number;
  hazeMax: number;
  hook: unknown;
}

function probeSky(): SkyHook | null {
  const hook = THREE.Material.prototype.onBeforeCompile as unknown;
  if (typeof hook !== 'function') return null;
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <fog_pars_vertex>\n#include <fog_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <fog_pars_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n#include <fog_fragment>',
  };
  try {
    (hook as (s: typeof shader, r: unknown) => void).call(THREE.Material.prototype, shader, null);
  } catch {
    return null;
  }
  if (!shader.uniforms.skyOn || !shader.uniforms.skyLamps) return null;
  const reach = /skyStreet - ([\d.]+), 0\.0 \) \/ ([\d.]+)/.exec(shader.fragmentShader);
  const max = /smoothstep\( [\d.]+, ([\d.]+), vFogDepth \)/.exec(shader.fragmentShader);
  return { uniforms: shader.uniforms, hazeClear: reach ? Number(reach[1]) : 6, hazeAbove: reach ? Number(reach[2]) : 17.5, hazeMax: max ? Number(max[1]) : 300, hook };
}

function vec3Of(v: unknown): [number, number, number] {
  const c = v as { r?: number; g?: number; b?: number; x?: number; y?: number; z?: number };
  if (typeof c?.r === 'number') return [r6(c.r), r6(c.g ?? 0), r6(c.b ?? 0)];
  if (typeof c?.x === 'number') return [r6(c.x), r6(c.y ?? 0), r6(c.z ?? 0)];
  return [0, 0, 0];
}

function floatsOf(v: unknown, count: number): number[] {
  const a = v as ArrayLike<number> | undefined;
  const out: number[] = [];
  if (!a) return out;
  for (let i = 0; i < Math.min(count, a.length); i++) out.push(r6(a[i]));
  return out;
}

/** The uniform values of a ShaderMaterial the native renderer knows, as plain numbers. */
function uniformValues(u: Record<string, THREE.IUniform>): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  for (const [k, { value }] of Object.entries(u)) {
    if (typeof value === 'number') out[k] = r6(value);
    else if (typeof value === 'boolean') out[k] = value ? 1 : 0;
    else if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (v.isColor || v.isVector3) out[k] = vec3Of(value);
      else if (v.isVector2) out[k] = [r6(v.x as number), r6(v.y as number)];
      else if (v.isVector4) out[k] = [r6(v.x as number), r6(v.y as number), r6(v.z as number), r6(v.w as number)];
    }
  }
  return out;
}

/**
 * ShaderMaterials in the office, by the uniforms they declare and a line of their GLSL. The
 * native renderer carries the same programs under these names (scene_shaders.cpp).
 */
function shaderProgram(m: THREE.ShaderMaterial): string | null {
  const keys = Object.keys(m.uniforms).sort().join(',');
  if (keys === 'glow,glowK,horizon,moonDir,moonGlow,opacity,top' && m.fragmentShader.includes('moonGlow')) return 'skyDome';
  if (keys === 'color,opacity' && m.vertexShader.includes('vAlong')) return 'beam';
  return null;
}

// ---- NativeScene ----------------------------------------------------------------------------------

export class NativeScene {
  private readonly chunkChars: number;
  /** Blob part size for the current drain: never more than half its budget. */
  private partChars: number;
  private readonly textureIntervalMs: number;
  private readonly videoIntervalMs: number;
  private readonly maxEncodes: number;
  private readonly shadows: boolean;
  private readonly encode: ImageEncoder;
  private readonly now: () => number;

  private readonly ids = new WeakMap<object, number>();
  private nextId = { object: 1, geometry: 1, material: 1, texture: 1, blob: 1, attr: 1 };

  private readonly objects = new Map<number, ObjState>();
  private readonly geometries = new Map<number, GeoState>();
  private readonly geometrySources = new WeakMap<THREE.BufferGeometry, GeoSource>();
  private captureNumber = 0;
  private readonly materials = new Map<number, MatState>();
  private readonly textures = new Map<number, TexState>();
  private textureOrder: TexState[] = [];
  private textureOrderDirty = false;
  private textureCursor = 0;
  /** sharedKey to the geometry that stands for every geometry with that key. */
  private readonly shared = new Map<string, number>();

  private readonly dirtyGeo = new Set<number>();
  private readonly dirtyMat = new Set<number>();
  private readonly dirtyObj = new Set<number>();
  private readonly dirtyInst = new Set<number>();
  private readonly dirtyXf = new Set<number>();
  private readonly dirtyVis = new Set<number>();
  private readonly dirtyTex = new Set<number>();
  private readonly removeQueue = { objects: new Set<number>(), geometries: new Set<number>(), materials: new Set<number>(), textures: new Set<number>() };

  private chainStream: Stream | null = null;
  private textureStream: Stream | null = null;

  private env: EnvItem | null = null;
  private envJson = '';
  private sentEnvJson: string | null = null;
  private cameraItem: CameraItem | null = null;
  private cameraJson = '';
  private sentCameraJson: string | null = null;

  private resetPending = true;
  /** The last packet did not commit, so the next one must, even if it carries nothing else. */
  private uncommitted = false;
  private seq = 0;
  private encoding = 0;
  private disposed = false;
  private sky: SkyHook | null | undefined;

  private readonly unsupported = new Map<string, Unsupported>();
  private readonly unsentUnsupported: Unsupported[] = [];
  private readonly errors: string[] = [];
  private stats = { packets: 0, bytes: 0, lastPacketBytes: 0, largestPacketBytes: 0, captureMs: 0 };

  private readonly scratchV = new THREE.Vector3();
  private readonly scratchW = new THREE.Vector3();
  private readonly scratchM = new THREE.Matrix4();
  private readonly scratchRelative = new THREE.Matrix4();
  /** Attachment records reused across captures (one per tagged subtree in a capture). */
  private readonly attachments: Attachment[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    options: NativeSceneOptions = {},
  ) {
    this.chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
    this.partChars = this.chunkChars;
    this.textureIntervalMs = options.textureIntervalMs ?? 150;
    this.videoIntervalMs = options.videoIntervalMs ?? 1000;
    this.maxEncodes = options.maxEncodes ?? 3;
    this.shadows = options.shadows ?? true;
    this.encode = options.encodeImage ?? domImageEncoder;
    this.now = options.now ?? (() => performance.now());
  }

  private idOf(o: object, kind: keyof NativeScene['nextId']): number {
    let id = this.ids.get(o);
    if (id === undefined) {
      id = this.nextId[kind]++;
      this.ids.set(o, id);
    }
    return id;
  }

  private note(kind: string, id: number, reason: string, name?: string): void {
    const key = `${kind}:${id}:${reason}`;
    if (this.unsupported.has(key)) return;
    const u: Unsupported = { kind, id, reason };
    if (name) u.name = name.slice(0, 60);
    this.unsupported.set(key, u);
    this.unsentUnsupported.push(u);
  }

  private error(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 50) this.errors.shift();
  }

  /** Starts the stream over: the next drain sends a full snapshot with `reset: true`. */
  reset(): void {
    this.resetPending = true;
    this.uncommitted = false;
    this.chainStream = null;
    this.textureStream = null;
    for (const s of this.objects.values()) {
      s.sent = false;
      this.dirtyObj.add(s.id);
    }
    for (const s of this.geometries.values()) {
      s.sentShape = null;
      s.sentVersions = null;
      this.dirtyGeo.add(s.id);
    }
    for (const s of this.materials.values()) {
      s.sentJson = null;
      this.dirtyMat.add(s.id);
    }
    for (const s of this.textures.values()) {
      s.sentPixels = false;
      s.sentSamplerJson = null;
      s.pixelsQueued = !!s.pixels;
      if (s.pixels) this.dirtyTex.add(s.id);
    }
    this.dirtyInst.clear();
    this.dirtyXf.clear();
    this.dirtyVis.clear();
    for (const q of Object.values(this.removeQueue)) q.clear();
    this.sentEnvJson = null;
    this.sentCameraJson = null;
    this.unsentUnsupported.length = 0;
    this.unsentUnsupported.push(...this.unsupported.values());
  }

  dispose(): void {
    this.disposed = true;
    this.objects.clear();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.textureOrder = [];
    this.shared.clear();
    this.chainStream = null;
    this.textureStream = null;
  }

  /** Records the scene's current state. Call at the gameplay rate (20-30 Hz), after the frame's updates. */
  capture(): void {
    if (this.disposed) return;
    const t0 = this.now();
    this.captureNumber++;
    if (this.sky === undefined) this.sky = probeSky();
    const scene = this.scene;
    scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();

    const seenObj = new Set<number>();
    const seenGeo = new Set<number>();
    const seenMat = new Set<number>();
    const seenTex = new Set<number>();
    const lights: THREE.Light[] = [];
    const layers = this.camera.layers;
    let attached = 0;

    const visit = (o: THREE.Object3D, parentVisible: boolean, inherited: Attachment | null) => {
      const visible = parentVisible && o.visible;
      const a = o as THREE.Object3D & Record<string, unknown>;
      const hand = attachmentHand(o);
      let attachment = inherited;
      if (hand !== undefined) {
        // An invalid tag is ignored: the subtree keeps the placement it would have without it.
        const grip = o.parent;
        if (hand !== null && grip && !(grip as THREE.Scene).isScene) {
          const record = (this.attachments[attached++] ??= { hand, root: o });
          record.hand = hand;
          record.root = o;
          attachment = record;
        } else this.note('object', this.idOf(o, 'object'), 'nativeControllerAttachment needs { hand: 0 | 1 } on a child of a controller grip', o.name);
      }
      if (a.isLight) {
        if (visible && o.layers.test(layers)) lights.push(o as THREE.Light);
      } else if (a.isSkinnedMesh || a.isBatchedMesh || a.isLOD) {
        this.note('object', this.idOf(o, 'object'), a.isSkinnedMesh ? 'SkinnedMesh is not drawn natively' : a.isBatchedMesh ? 'BatchedMesh is not drawn natively' : 'LOD levels are not switched natively', o.name);
      } else {
        const kind = kindOf(o);
        if (kind) this.captureObject(o as Drawable, kind, visible && o.layers.test(layers), attachment, seenObj, seenGeo, seenMat, seenTex);
      }
      for (const c of o.children) visit(c, visible, attachment);
    };
    visit(scene, true, null);

    this.sweep(seenObj, seenGeo, seenMat, seenTex);
    this.captureEnv(lights);
    this.captureCamera();
    this.pumpTextures();
    this.stats.captureMs = this.now() - t0;
  }

  private captureObject(o: Drawable, kind: ObjectKind, visible: boolean, attachment: Attachment | null, seenObj: Set<number>, seenGeo: Set<number>, seenMat: Set<number>, seenTex: Set<number>): void {
    const id = this.idOf(o, 'object');
    const hand = attachment ? attachment.hand : -1;
    // The page's matrixWorld stays authoritative for collision and picking; only the wire copy is
    // relative. Local matrices from the tag down are exact, so grip motion never changes them.
    const matrix = attachment ? this.gripRelative(o, attachment.root) : o.matrixWorld.elements;
    seenObj.add(id);
    const geometry = o.geometry as THREE.BufferGeometry;
    if (!geometry?.attributes?.position) {
      this.note('object', id, 'no position attribute', o.name);
      return;
    }
    const geo = this.captureGeometry(geometry, seenGeo);
    let s = this.objects.get(id);
    let mat: number | number[];
    if (Array.isArray(o.material)) {
      const previous = Array.isArray(s?.mat) ? s.mat : null;
      let matIds: number[] | null = null;
      for (let i = 0; i < o.material.length; i++) {
        const m = o.material[i];
        const matId = m ? this.captureMaterial(m, kind, seenMat, seenTex) : 0;
        if (!previous || previous[i] !== matId) matIds ??= previous ? previous.slice(0, i) : [];
        if (matIds) matIds.push(matId);
      }
      mat = matIds ?? (previous?.length === o.material.length ? previous : previous?.slice(0, o.material.length)) ?? [];
    } else mat = o.material ? this.captureMaterial(o.material, kind, seenMat, seenTex) : 0;
    if (o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) this.note('object', id, 'onBeforeRender hook is not run natively', o.name);
    if (Object.keys(geometry.morphAttributes).length) this.note('geometry', geo, 'morph targets are drawn at their base shape', o.name);
    const center = kind === 'sprite' ? (o as THREE.Sprite).center : null;
    const centerX = center?.x ?? 0;
    const centerY = center?.y ?? 0;
    const groupOrder = groupOrderOf(o);
    if (!s) {
      s = {
        id,
        obj: o,
        kind,
        geo,
        mat,
        m: new Float32Array(12),
        hand,
        visible,
        sent: false,
        sentVisible: visible,
        order: o.renderOrder,
        groupOrder,
        cast: o.castShadow,
        recv: o.receiveShadow,
        cull: o.frustumCulled,
        centerX,
        centerY,
        name: o.name,
        instanceCount: -1,
        instanceMatrix: null,
        instanceMatrixVersion: -1,
        instanceColor: null,
        instanceColorVersion: -1,
      };
      affine12(matrix, s.m);
      this.objects.set(id, s);
      this.dirtyObj.add(id);
      this.removeQueue.objects.delete(id);
    } else {
      if (
        s.kind !== kind ||
        s.geo !== geo ||
        s.mat !== mat ||
        s.order !== o.renderOrder ||
        s.groupOrder !== groupOrder ||
        s.cast !== o.castShadow ||
        s.recv !== o.receiveShadow ||
        s.cull !== o.frustumCulled ||
        s.centerX !== centerX ||
        s.centerY !== centerY ||
        s.name !== o.name ||
        s.hand !== hand
      ) {
        // A new hand changes what `m` means, so the whole object goes out with its new matrix.
        if (s.hand !== hand) affine12(matrix, s.m);
        s.hand = hand;
        s.kind = kind;
        s.geo = geo;
        s.mat = mat;
        s.order = o.renderOrder;
        s.groupOrder = groupOrder;
        s.cast = o.castShadow;
        s.recv = o.receiveShadow;
        s.cull = o.frustumCulled;
        s.centerX = centerX;
        s.centerY = centerY;
        s.name = o.name;
        this.dirtyObj.add(id);
      }
      if (!sameAffine(matrix, s.m)) {
        affine12(matrix, s.m);
        if (s.sent) this.dirtyXf.add(id);
      }
      if (s.visible !== visible) {
        s.visible = visible;
        if (s.sent) this.dirtyVis.add(id);
      }
    }
    if (kind === 'instanced') {
      const im = o as THREE.InstancedMesh;
      if (
        im.count !== s.instanceCount ||
        im.instanceMatrix !== s.instanceMatrix ||
        im.instanceMatrix.version !== s.instanceMatrixVersion ||
        im.instanceColor !== s.instanceColor ||
        (im.instanceColor?.version ?? -1) !== s.instanceColorVersion
      ) {
        s.instanceCount = im.count;
        s.instanceMatrix = im.instanceMatrix;
        s.instanceMatrixVersion = im.instanceMatrix.version;
        s.instanceColor = im.instanceColor;
        s.instanceColorVersion = im.instanceColor?.version ?? -1;
        if (s.sent && !this.dirtyObj.has(id)) this.dirtyInst.add(id);
      }
    }
  }

  /** root.matrix * ... * o.matrix: `o` relative to the grip that parents `root`. */
  private gripRelative(o: THREE.Object3D, root: THREE.Object3D): THREE.Matrix4['elements'] {
    const m = this.scratchRelative.copy(o.matrix);
    for (let p = o; p !== root && p.parent; ) {
      p = p.parent;
      m.premultiply(p.matrix);
    }
    return m.elements;
  }

  private geometrySource(g: THREE.BufferGeometry): GeoSource {
    let source = this.geometrySources.get(g);
    if (!source) {
      source = { stamp: new CaptureStamp(), key: null, capture: -1, checked: -1, id: 0, verifiedWith: null, verifiedRevision: -1, revision: 0, shape: '', versions: {} };
      this.geometrySources.set(g, source);
    }
    if (source.checked === this.captureNumber) return source;
    source.checked = this.captureNumber;
    const stamp = source.stamp;
    stamp.begin();
    stamp.add(g.type);
    const params = (g as THREE.BufferGeometry & { parameters?: Record<string, unknown> }).parameters;
    stamp.add(params);
    if (params)
      for (const key in params) {
        stamp.add(key);
        stamp.add(params[key]);
      }
    stamp.add(g.morphAttributes.position);
    for (const name in g.attributes) {
      const attr = g.attributes[name] as Attr;
      const interleaved = attr as THREE.InterleavedBufferAttribute;
      stamp.add(name);
      stamp.add(attr);
      stamp.add(attr.count);
      stamp.add(attr.itemSize);
      stamp.add(attr.normalized);
      stamp.add(attr.array);
      if (interleaved.isInterleavedBufferAttribute) {
        stamp.add(interleaved.data);
        stamp.add(interleaved.data.version);
        stamp.add(interleaved.data.stride);
        stamp.add(interleaved.offset);
      } else stamp.add((attr as THREE.BufferAttribute).version);
    }
    stamp.add(g.index);
    stamp.add(g.index?.array);
    stamp.add(g.index?.version);
    stamp.add(g.index?.count);
    for (const group of g.groups) {
      stamp.add(group.start);
      stamp.add(group.count);
      stamp.add(group.materialIndex);
    }
    stamp.add(g.drawRange.start);
    stamp.add(g.drawRange.count);
    if (stamp.finish()) {
      source.key = sharedKey(g);
      source.verifiedWith = null;
      source.revision++;
      const versions: Partial<Record<AttrName, number>> = {};
      let shape = '';
      for (const name of ATTRS) {
        const a = g.attributes[name] as Attr | undefined;
        if (!a) continue;
        const interleaved = a as THREE.InterleavedBufferAttribute;
        versions[name] = interleaved.isInterleavedBufferAttribute ? interleaved.data.version : (a as THREE.BufferAttribute).version;
        shape += `${name}${this.idOf(a, 'attr')}:${this.idOf(a.array, 'attr')}:${a.count}:${a.itemSize}:${a.normalized ? 1 : 0}`;
        if (interleaved.isInterleavedBufferAttribute) shape += `:${this.idOf(interleaved.data, 'attr')}:${interleaved.data.stride}:${interleaved.offset}`;
        shape += ';';
      }
      const index = g.index;
      shape += `i${index ? `${this.idOf(index, 'attr')}:${this.idOf(index.array, 'attr')}:${index.version}:${index.count}` : '-'}|`;
      for (const gr of g.groups) shape += `${gr.start},${gr.count},${gr.materialIndex ?? 0};`;
      source.shape = `${shape}|${g.drawRange.start},${g.drawRange.count}`;
      source.versions = versions;
    }
    return source;
  }

  private captureGeometry(g: THREE.BufferGeometry, seen: Set<number>): number {
    let source = this.geometrySources.get(g);
    if (source?.capture === this.captureNumber) {
      seen.add(source.id);
      return source.id;
    }
    source = this.geometrySource(g);
    let key = source.key;
    if (key) {
      const shared = this.shared.get(key);
      const canonical = shared !== undefined ? this.geometries.get(shared) : undefined;
      if (canonical?.key === key) {
        const canonicalSource = canonical.geo === g ? source : this.geometrySource(canonical.geo);
        if (canonicalSource.key === key && (canonical.geo === g || (source.verifiedWith === canonicalSource && source.verifiedRevision === canonicalSource.revision) || sameGeometry(g, canonical.geo))) {
          source.verifiedWith = canonicalSource;
          source.verifiedRevision = canonicalSource.revision;
          source.capture = this.captureNumber;
          source.id = shared!;
          seen.add(shared!);
          return shared!;
        }
        // Same parameter names but different buffers: retain this source's independent geometry.
        if (canonicalSource.key === key) source.key = key = null;
      }
    }
    const id = this.idOf(g, 'geometry');
    source.capture = this.captureNumber;
    source.id = id;
    if (seen.has(id)) return id;
    seen.add(id);
    const { versions, shape } = source;

    let s = this.geometries.get(id);
    if (key) this.shared.set(key, id);
    if (s) s.key = key;
    if (!s) {
      s = { id, geo: g, key, shape, versions, sentVersions: null, sentShape: null };
      this.geometries.set(id, s);
      this.dirtyGeo.add(id);
      this.removeQueue.geometries.delete(id);
      for (const name of Object.keys(g.attributes)) if (!(ATTRS as readonly string[]).includes(name)) this.note('geometry', id, `attribute "${name}" is not sent`);
    } else if (s.shape !== shape || ATTRS.some((n) => s!.versions[n] !== versions[n])) {
      s.shape = shape;
      s.versions = versions;
      this.dirtyGeo.add(id);
    }
    return id;
  }

  private captureMaterial(m: THREE.Material, kind: ObjectKind, seen: Set<number>, seenTex: Set<number>): number {
    const id = this.idOf(m, 'material');
    // Shared by many objects: one look per capture is enough.
    if (seen.has(id)) return id;
    seen.add(id);
    let s = this.materials.get(id);
    const stamp = s?.stamp ?? new CaptureStamp();
    if (!this.materialChanged(m, stamp, seenTex) && s) return id;
    const item = this.materialItem(m, id, kind, seenTex);
    if (!s) {
      const json = JSON.stringify(item);
      s = { id, mat: m, item, json, sentJson: null, stamp };
      this.materials.set(id, s);
      this.dirtyMat.add(id);
      this.removeQueue.materials.delete(id);
    } else if (!sameData(s.item, item)) {
      const json = JSON.stringify(item);
      if (s.json !== json) {
        s.item = item;
        s.json = json;
        this.dirtyMat.add(id);
      }
    }
    return id;
  }

  private materialChanged(m: THREE.Material, stamp: CaptureStamp, seenTex: Set<number>): boolean {
    const rec = m as unknown as Record<string, unknown>;
    stamp.begin();
    const type = materialType(m);
    stamp.add(type);
    for (const field of MATERIAL_FIELDS) stamp.add(rec[field]);
    stamp.add(sharpTextTag(m));
    for (const field of ['color', 'emissive', 'specular']) {
      const color = rec[field];
      const isColor = color instanceof THREE.Color;
      stamp.add(isColor);
      if (isColor) {
        stamp.add(color.r);
        stamp.add(color.g);
        stamp.add(color.b);
      }
    }
    for (const key of DRAWN_MAPS) {
      const texture = rec[key] as THREE.Texture | null | undefined;
      const valid = texture?.isTexture === true;
      stamp.add(valid ? texture : null);
      if (!valid) continue;
      this.captureTexture(texture, seenTex);
      if (texture.matrixAutoUpdate) texture.updateMatrix();
      stamp.add(texture.channel);
      for (const value of texture.matrix.elements) stamp.add(value);
    }
    for (const key of OTHER_MAPS) stamp.add((rec[key] as THREE.Texture | null | undefined)?.isTexture === true);
    if (type === 'shader') {
      const shader = m as THREE.ShaderMaterial;
      stamp.add(shader.vertexShader);
      stamp.add(shader.fragmentShader);
      for (const key in shader.uniforms) {
        const value = shader.uniforms[key].value;
        stamp.add(key);
        stamp.add(typeof value);
        if (typeof value === 'number' || typeof value === 'boolean') stamp.add(value);
        else if (value && typeof value === 'object') {
          if (value.isColor) {
            stamp.add('color');
            stamp.add(value.r);
            stamp.add(value.g);
            stamp.add(value.b);
          } else if (value.isVector2 || value.isVector3 || value.isVector4) {
            stamp.add(value.isVector2 ? 2 : value.isVector3 ? 3 : 4);
            stamp.add(value.x);
            stamp.add(value.y);
            if (!value.isVector2) stamp.add(value.z);
            if (value.isVector4) stamp.add(value.w);
          }
        }
      }
    }
    return stamp.finish();
  }

  private mapRef(tex: THREE.Texture, seenTex: Set<number>): MapRef {
    const id = this.captureTexture(tex, seenTex);
    if (tex.matrixAutoUpdate) tex.updateMatrix();
    const ref: MapRef = { t: id, m: Array.from(tex.matrix.elements, r6) };
    if (tex.channel) ref.ch = tex.channel;
    return ref;
  }

  private materialItem(m: THREE.Material, id: number, kind: ObjectKind, seenTex: Set<number>): MaterialItem {
    let type = materialType(m);
    const rec = m as unknown as Record<string, unknown>;
    if (!type) {
      this.note('material', id, `${m.type} is drawn as MeshBasicMaterial`, m.name);
      type = 'basic';
    }
    const color = rec.color instanceof THREE.Color ? rgb(rec.color) : ([1, 1, 1] as [number, number, number]);
    const lit = type === 'toon' || type === 'lambert' || type === 'phong' || type === 'standard';
    const blendMode = BLEND[m.blending] ?? 'normal';
    const item: MaterialItem = {
      id,
      rev: m.version,
      type,
      color,
      opacity: r6(m.opacity),
      transparent: m.transparent,
      alphaTest: r6(m.alphaTest),
      side: SIDE[m.side] ?? 'front',
      shadowSide: m.shadowSide !== null && m.shadowSide !== undefined ? (SIDE[m.shadowSide] ?? 'back') : (SHADOW_SIDE[m.side] ?? 'back'),
      depthTest: m.depthTest,
      depthWrite: m.depthWrite,
      depthFunc: DEPTH_FUNC[m.depthFunc] ?? 'lequal',
      colorWrite: m.colorWrite,
      blend: [
        blendMode,
        m.premultipliedAlpha,
        EQUATION[m.blendEquation] ?? 'add',
        FACTOR[m.blendSrc] ?? 'srcAlpha',
        FACTOR[m.blendDst] ?? 'oneMinusSrcAlpha',
        EQUATION[m.blendEquationAlpha ?? m.blendEquation] ?? 'add',
        FACTOR[m.blendSrcAlpha ?? m.blendSrc] ?? 'srcAlpha',
        FACTOR[m.blendDstAlpha ?? m.blendDst] ?? 'oneMinusSrcAlpha',
      ],
      vertexColors: m.vertexColors,
      fog: rec.fog === true,
      lit,
      sky: !!this.sky && type !== 'shader' && m.onBeforeCompile === this.sky.hook,
      visible: m.visible,
      polygonOffset: m.polygonOffset ? [r6(m.polygonOffsetFactor), r6(m.polygonOffsetUnits)] : null,
      wireframe: rec.wireframe === true,
      forceSinglePass: m.forceSinglePass,
      toneMapped: m.toneMapped,
    };
    if (lit && rec.emissive instanceof THREE.Color) item.emissive = rgb(rec.emissive, (rec.emissiveIntensity as number) ?? 1);
    for (const k of DRAWN_MAPS) {
      const t = rec[k] as THREE.Texture | null | undefined;
      if (t?.isTexture) item[k] = this.mapRef(t, seenTex);
    }
    for (const k of OTHER_MAPS) if ((rec[k] as THREE.Texture | null | undefined)?.isTexture) this.note('material', id, `${k} is not drawn natively`, m.name);
    if (type === 'points') {
      item.size = r6((rec.size as number) ?? 1);
      item.sizeAttenuation = rec.sizeAttenuation !== false;
    }
    if (type === 'sprite') {
      item.rotation = r6((rec.rotation as number) ?? 0);
      item.sizeAttenuation = rec.sizeAttenuation !== false;
    }
    if (type === 'standard') {
      item.metalness = r6(rec.metalness as number);
      item.roughness = r6(rec.roughness as number);
      if ((rec.clearcoat as number) > 0) this.note('material', id, 'clearcoat is approximated by roughness only', m.name);
    }
    if (type === 'phong') {
      item.specular = rgb(rec.specular as THREE.Color);
      item.shininess = r6(rec.shininess as number);
    }
    if (rec.flatShading) item.flatShading = true;
    if (kind === 'lines' || kind === 'lineStrip' || kind === 'lineLoop') {
      if (((rec.linewidth as number) ?? 1) !== 1) this.note('material', id, 'linewidth other than 1 is drawn at 1 (as WebGL does)', m.name);
    }
    if (type === 'shader') {
      const sm = m as THREE.ShaderMaterial;
      const program = shaderProgram(sm);
      if (!program) this.note('material', id, 'unknown ShaderMaterial is not drawn natively', m.name);
      item.shader = { program: program ?? 'unknown', uniforms: uniformValues(sm.uniforms) };
    }
    if (sharpTextTag(m) && type === 'basic' && item.map && !item.transparent && item.visible && !item.wireframe && kind === 'mesh') item.sharpText = true;
    return item;
  }

  private captureTexture(t: THREE.Texture, seen: Set<number>): number {
    const id = this.idOf(t, 'texture');
    if (seen.has(id)) return id;
    seen.add(id);
    let s = this.textures.get(id);
    const sampler: TextureSampler = {
      wrapS: WRAP[t.wrapS] ?? 'clamp',
      wrapT: WRAP[t.wrapT] ?? 'clamp',
      mag: FILTER[t.magFilter] ?? 'linear',
      min: FILTER[t.minFilter] ?? 'linear',
      mips: t.generateMipmaps && t.minFilter !== THREE.NearestFilter && t.minFilter !== THREE.LinearFilter,
      aniso: t.anisotropy,
      srgb: t.colorSpace === THREE.SRGBColorSpace,
      flipY: t.flipY,
      premultiply: t.premultiplyAlpha,
    };
    if (!s) {
      const samplerJson = JSON.stringify(sampler);
      s = { id, tex: t, sampler, samplerJson, encodedVersion: -1, encodedSource: null, encoding: false, lastEncodeAt: -Infinity, retryAt: -Infinity, pixels: null, pixelsQueued: false, sentSamplerJson: null, sentPixels: false };
      this.textures.set(id, s);
      this.textureOrderDirty = true;
      this.removeQueue.textures.delete(id);
      const a = t as THREE.Texture & Record<string, unknown>;
      if (a.isCubeTexture || a.isCompressedTexture || a.isDepthTexture || a.isData3DTexture || a.isDataArrayTexture) this.note('texture', id, `${t.constructor.name} is not drawn natively`, t.name);
    } else if (!sameData(s.sampler, sampler)) {
      s.sampler = sampler;
      s.samplerJson = JSON.stringify(sampler);
      if (s.sentPixels) this.dirtyTex.add(id);
    }
    return id;
  }

  /** Starts encodes for textures whose pixels changed, within the per-texture and global limits. */
  private pumpTextures(): void {
    const now = this.now();
    if (this.textureOrderDirty) {
      this.textureOrder = Array.from(this.textures.values());
      this.textureOrderDirty = false;
      this.textureCursor %= Math.max(1, this.textureOrder.length);
    }
    // First pixels take priority over redraws. An early, busy terminal cannot starve a board label.
    for (const s of this.textureOrder) {
      if (this.encoding >= this.maxEncodes) return;
      if (!s.pixels) this.startTexture(s, now);
    }
    // Once loaded, rotate through changed sources instead of always restarting at the first map.
    const count = this.textureOrder.length;
    for (let i = 0; i < count; i++) {
      if (this.encoding >= this.maxEncodes) return;
      const index = (this.textureCursor + i) % count;
      const s = this.textureOrder[index];
      if (s.pixels && this.startTexture(s, now)) {
        this.textureCursor = (index + 1) % count;
        // The remaining scan begins after the texture just started, even for synchronous RGBA8.
        i = -1;
      }
    }
  }

  private startTexture(s: TexState, now: number): boolean {
    const t = s.tex;
    const src = t.source?.data ?? t.image;
    if (s.encoding || now < s.retryAt || (t.version === s.encodedVersion && src === s.encodedSource)) return false;
    const a = t as THREE.Texture & Record<string, unknown>;
    if (s.pixels && now - s.lastEncodeAt < (a.isVideoTexture ? this.videoIntervalMs : this.textureIntervalMs)) return false;
    const size = sourceSize(src);
    if (!size || a.isCubeTexture || a.isCompressedTexture || a.isDepthTexture || a.isData3DTexture || a.isDataArrayTexture) return false;
    const version = t.version;
    s.lastEncodeAt = now;
    if (a.isDataTexture) {
      const data = (src as { data?: ArrayBufferView }).data;
      if (t.format !== THREE.RGBAFormat || t.type !== THREE.UnsignedByteType || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
        this.note('texture', s.id, 'DataTexture other than RGBA8 is not drawn natively', t.name);
        s.encodedVersion = version;
        s.encodedSource = src;
        return false;
      }
      s.encodedVersion = version;
      s.encodedSource = src;
      this.acceptPixels(s, { fmt: 'rgba8', bytes: new Uint8Array(viewBytes(data)), w: size.w, h: size.h });
      return true;
    }
    s.encoding = true;
    this.encoding++;
    // Starting an encoder may itself throw; handle it like a rejected asynchronous encode.
    let encoding: ReturnType<ImageEncoder>;
    try {
      encoding = this.encode(src, size.w, size.h, !!a.isVideoTexture);
    } catch (err) {
      encoding = Promise.reject(err);
    }
    encoding
      .then((out) => {
        if (this.textures.get(s.id) !== s || this.disposed) return;
        s.encodedVersion = version;
        s.encodedSource = src;
        s.retryAt = -Infinity;
        this.acceptPixels(s, { ...out, w: size.w, h: size.h });
      })
      .catch((err: unknown) => {
        s.retryAt = this.now() + Math.max(100, this.textureIntervalMs);
        this.error(`texture ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        s.encoding = false;
        this.encoding--;
      });
    return true;
  }

  private acceptPixels(s: TexState, pixels: NonNullable<TexState['pixels']>): void {
    s.pixels = pixels;
    s.pixelsQueued = true;
    this.dirtyTex.add(s.id);
  }

  /** Forgets whatever the scene no longer holds, queueing removals for what the renderer has. */
  private sweep(seenObj: Set<number>, seenGeo: Set<number>, seenMat: Set<number>, seenTex: Set<number>): void {
    for (const [id, s] of this.objects) {
      if (seenObj.has(id)) continue;
      this.objects.delete(id);
      this.dirtyObj.delete(id);
      this.dirtyXf.delete(id);
      this.dirtyVis.delete(id);
      this.dirtyInst.delete(id);
      if (s.sent) this.removeQueue.objects.add(id);
    }
    for (const [id, s] of this.geometries) {
      if (seenGeo.has(id)) continue;
      if (s.key && this.shared.get(s.key) === id) this.shared.delete(s.key);
      this.geometries.delete(id);
      this.dirtyGeo.delete(id);
      if (s.sentShape !== null) this.removeQueue.geometries.add(id);
    }
    for (const [id, s] of this.materials) {
      if (seenMat.has(id)) continue;
      this.materials.delete(id);
      this.dirtyMat.delete(id);
      if (s.sentJson !== null) this.removeQueue.materials.add(id);
    }
    for (const [id, s] of this.textures) {
      if (seenTex.has(id)) continue;
      this.textures.delete(id);
      this.textureOrderDirty = true;
      this.dirtyTex.delete(id);
      if (s.sentPixels || s.sentSamplerJson !== null) this.removeQueue.textures.add(id);
    }
  }

  private captureEnv(lights: THREE.Light[]): void {
    const scene = this.scene;
    const bg = scene.background;
    let background: [number, number, number] | null = null;
    if (bg instanceof THREE.Color) background = rgb(bg);
    else if (bg) this.note('scene', 0, 'a texture background is not drawn natively');
    let fog: EnvItem['fog'] = null;
    if (scene.fog instanceof THREE.Fog) fog = { color: rgb(scene.fog.color), near: r6(scene.fog.near), far: r6(scene.fog.far) };
    else if (scene.fog instanceof THREE.FogExp2) fog = { color: rgb(scene.fog.color), density: r6(scene.fog.density) };
    const env: EnvItem = { background, fog, ambient: [0, 0, 0], hemi: [], dir: [], point: [], sky: null };
    for (const l of lights) {
      const a = l as THREE.Light & Record<string, unknown>;
      const k = l.intensity;
      if (a.isAmbientLight) {
        env.ambient[0] += l.color.r * k;
        env.ambient[1] += l.color.g * k;
        env.ambient[2] += l.color.b * k;
      } else if (a.isHemisphereLight) {
        const h = l as THREE.HemisphereLight;
        const up = this.scratchV.setFromMatrixPosition(h.matrixWorld).normalize();
        env.hemi.push({ sky: rgb(h.color, k), ground: rgb(h.groundColor, k), dir: [r6(up.x), r6(up.y), r6(up.z)] });
      } else if (a.isDirectionalLight) {
        const d = l as THREE.DirectionalLight;
        const from = this.scratchV.setFromMatrixPosition(d.matrixWorld);
        const to = this.scratchW.setFromMatrixPosition(d.target.matrixWorld);
        const dir = from.sub(to).normalize();
        const item: LightDirectional = { color: rgb(d.color, k), dir: [r6(dir.x), r6(dir.y), r6(dir.z)] };
        if (this.shadows && d.castShadow) {
          const sh = d.shadow;
          sh.camera.updateProjectionMatrix();
          sh.updateMatrices(d);
          const vp = this.scratchM.multiplyMatrices(sh.camera.projectionMatrix, sh.camera.matrixWorldInverse);
          item.shadow = {
            viewProj: Array.from(vp.elements, (x) => Math.fround(x)),
            matrix: Array.from(sh.matrix.elements, (x) => Math.fround(x)),
            mapSize: [sh.mapSize.x, sh.mapSize.y],
            bias: r6(sh.bias),
            normalBias: r6(sh.normalBias),
            radius: r6(sh.radius),
            intensity: r6(sh.intensity),
          };
        }
        env.dir.push(item);
      } else if (a.isPointLight) {
        const p = l as THREE.PointLight;
        const pos = this.scratchV.setFromMatrixPosition(p.matrixWorld);
        env.point.push({ pos: [r6(pos.x), r6(pos.y), r6(pos.z)], color: rgb(p.color, k), distance: r6(p.distance), decay: r6(p.decay) });
        if (p.castShadow) this.note('light', this.idOf(p, 'object'), 'point light shadows are not drawn natively', p.name);
      } else {
        this.note('light', this.idOf(l, 'object'), `${l.type} is not lit natively`, l.name);
      }
    }
    env.ambient = [r6(env.ambient[0]), r6(env.ambient[1]), r6(env.ambient[2])];
    env.sky = this.skyInfo();
    const json = JSON.stringify(env);
    if (json !== this.envJson) {
      this.env = env;
      this.envJson = json;
    }
  }

  private skyInfo(): SkyInfo | null {
    const sky = this.sky;
    if (!sky) return null;
    const u = sky.uniforms;
    const num = (k: string) => r6(Number(u[k]?.value ?? 0));
    const lampCount = Math.max(0, Math.min(24, num('skyLampCount')));
    const screenCount = Math.max(0, Math.min(16, num('skyScreenCount')));
    const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T };
    return {
      on: num('skyOn'),
      inside: num('skyInside'),
      office: vec3Of(u.skyOffice?.value),
      garage: vec3Of(u.skyGarage?.value),
      lampCount,
      lamps: floatsOf(u.skyLamps?.value, lampCount * 4),
      lampColors: floatsOf(u.skyLampColors?.value, lampCount * 3),
      lampMin: vec3Of(u.skyLampMin?.value),
      lampMax: vec3Of(u.skyLampMax?.value),
      screenCount,
      screens: floatsOf(u.skyScreens?.value, screenCount * 4),
      screenDirs: floatsOf(u.skyScreenDirs?.value, screenCount * 3),
      screenColors: floatsOf(u.skyScreenColors?.value, screenCount * 3),
      screenMin: vec3Of(u.skyScreenMin?.value),
      screenMax: vec3Of(u.skyScreenMax?.value),
      wet: num('skyWet'),
      snow: num('skySnow'),
      drop: num('skyDrop'),
      street: u.skyStreet ? num('skyStreet') : STREET_Y,
      hazeClear: sky.hazeClear,
      hazeAbove: sky.hazeAbove,
      hazeMax: sky.hazeMax,
      officeMin: [r6(FLOOR.minX - 0.02), -0.06, r6(FLOOR.minZ - 0.02)],
      officeMax: [r6(FLOOR.maxX + 0.02), 40, r6(FLOOR.maxZ + 0.02)],
      garageBox: [r6(B.minX + 0.05), r6(B.minZ + 0.05), r6(B.maxX), r6(B.maxZ), r6(STREET_Y - 0.5), r6(-SLAB + 0.02)],
    };
  }

  private captureCamera(): void {
    const c = this.camera as THREE.PerspectiveCamera;
    const m = new Float32Array(12);
    affine12(c.matrixWorld.elements, m);
    const item: CameraItem = { m: Array.from(m, r6), near: r6(c.near ?? 0.1), far: r6(c.far ?? 1000), fov: r6(c.fov ?? 50) };
    const json = JSON.stringify(item);
    if (json !== this.cameraJson) {
      this.cameraItem = item;
      this.cameraJson = json;
    }
  }

  // ---- Building items (at drain time) ---------------------------------------------------------------

  private bin(bytes: Uint8Array, parts: BlobPart[]): Bin {
    const out = packBinary(bytes, () => this.nextId.blob++, this.partChars);
    parts.push(...out.parts);
    return out.bin;
  }

  private geometryItem(s: GeoState, parts: BlobPart[]): GeometryItem {
    const g = s.geo;
    const pos = g.attributes.position as Attr;
    const partial = s.sentShape === s.shape && s.sentVersions !== null;
    const item: GeometryItem = {
      id: s.id,
      rev: (s.versions.position ?? 0) + (s.versions.normal ?? 0) + (s.versions.uv ?? 0) + (s.versions.color ?? 0),
      count: pos.count,
      attrs: {},
      groups: g.groups.map((gr) => [gr.start, Number.isFinite(gr.count) ? gr.count : -1, gr.materialIndex ?? 0]),
      range: [g.drawRange.start, Number.isFinite(g.drawRange.count) ? g.drawRange.count : -1],
      sphere: sphereOf(g.boundingSphere ?? (g.computeBoundingSphere(), g.boundingSphere)),
    };
    if (partial) item.partial = true;
    for (const name of ATTRS) {
      const a = g.attributes[name] as Attr | undefined;
      if (!a) continue;
      if (partial && s.sentVersions![name] === s.versions[name]) continue;
      const n = attrWidth(name, a);
      item.attrs[name] = { n, data: this.bin(viewBytes(attrFloats(a, n)), parts) };
    }
    if (!partial) {
      const index = g.index;
      if (index) {
        const src = index.array;
        const wide = src instanceof Uint32Array || pos.count > 65535;
        const arr = wide ? (src instanceof Uint32Array ? src : Uint32Array.from(src)) : src instanceof Uint16Array ? src : Uint16Array.from(src);
        item.index = { t: wide ? 'u32' : 'u16', data: this.bin(viewBytes(arr.subarray(0, index.count)), parts), count: index.count };
      } else item.index = null;
    }
    s.sentShape = s.shape;
    s.sentVersions = { ...s.versions };
    return item;
  }

  private instanceData(o: THREE.InstancedMesh, parts: BlobPart[]): InstanceData {
    const count = o.count;
    const src = o.instanceMatrix.array;
    const m = new Float32Array(count * 12);
    for (let i = 0; i < count; i++) affine12(src.subarray(i * 16, i * 16 + 16), m, i * 12);
    const inst: InstanceData = { count, m: this.bin(viewBytes(m), parts), sphere: EMPTY_SPHERE };
    if (o.instanceColor) {
      const c = o.instanceColor.array as Float32Array;
      inst.c = this.bin(viewBytes(c.subarray(0, count * 3)), parts);
    }
    if (o.frustumCulled) {
      o.computeBoundingSphere();
      inst.sphere = sphereOf(o.boundingSphere);
    }
    return inst;
  }

  private objectItem(s: ObjState, parts: BlobPart[]): ObjectItem {
    const o = s.obj;
    const item: ObjectItem = {
      id: s.id,
      kind: s.kind,
      geo: s.geo,
      mat: s.mat,
      order: [0, o.renderOrder],
      cast: o.castShadow,
      recv: o.receiveShadow,
      cull: o.frustumCulled,
      visible: s.visible,
      m: Array.from(s.m),
    };
    if (s.hand !== -1) item.hand = s.hand;
    item.order[0] = groupOrderOf(o);
    if (s.kind === 'sprite') {
      const c = (o as THREE.Sprite).center;
      item.center = [r6(c.x), r6(c.y)];
    }
    if (s.kind === 'instanced') item.inst = this.instanceData(o as THREE.InstancedMesh, parts);
    if (o.name) item.name = o.name.slice(0, 40);
    s.sent = true;
    s.sentVisible = s.visible;
    return item;
  }

  private textureItem(s: TexState, parts: BlobPart[]): TextureItem {
    const t = s.tex;
    const item: TextureItem = { id: s.id, rev: t.version, w: s.pixels?.w ?? 0, h: s.pixels?.h ?? 0, ...s.sampler };
    if (s.pixelsQueued && s.pixels) {
      item.fmt = s.pixels.fmt;
      item.data = this.bin(s.pixels.bytes, parts);
      s.pixelsQueued = false;
      s.sentPixels = true;
    }
    s.sentSamplerJson = s.samplerJson;
    return item;
  }

  // ---- Draining ---------------------------------------------------------------------------------------

  /**
   * Emits blob parts of `stream` while they fit, then the item itself if it fits; true once all of it
   * is out. A packet with nothing in it yet always takes the next piece, so every piece goes out.
   */
  private pumpStream(p: PacketBuilder, stream: Stream): boolean {
    while (stream.next < stream.parts.length) {
      const part = stream.parts[stream.next];
      const size = part.d.length + 64;
      if (!p.fits(size)) return false;
      stream.next++;
      p.add('blobs', part, size);
    }
    if (!p.fits(stream.size)) return false;
    stream.done(p);
    return true;
  }

  /**
   * Emits the dependent chain (geometries, materials, objects, instances) in order. Returns true when
   * all of it is out, so the packet may commit.
   */
  private drainChain(p: PacketBuilder): boolean {
    if (this.chainStream) {
      if (!this.pumpStream(p, this.chainStream)) return false;
      this.chainStream = null;
    }
    const steps: [Set<number>, (id: number, parts: BlobPart[]) => Emit | null][] = [
      [
        this.dirtyGeo,
        (id, parts) => {
          const s = this.geometries.get(id);
          if (!s) return null;
          const item = this.geometryItem(s, parts);
          return sized(item, (pb, n) => pb.add('geometries', item, n));
        },
      ],
      [
        this.dirtyMat,
        (id) => {
          const s = this.materials.get(id);
          if (!s) return null;
          s.sentJson = s.json;
          const { item, json } = s;
          return { size: json.length + 1, emit: (pb) => pb.add('materials', item, json.length) };
        },
      ],
      [
        this.dirtyObj,
        (id, parts) => {
          const s = this.objects.get(id);
          if (!s) return null;
          this.dirtyXf.delete(id);
          this.dirtyVis.delete(id);
          this.dirtyInst.delete(id);
          const item = this.objectItem(s, parts);
          return sized(item, (pb, n) => pb.add('objects', item, n));
        },
      ],
      [
        this.dirtyInst,
        (id, parts) => {
          const s = this.objects.get(id);
          if (!s?.sent || s.kind !== 'instanced') return null;
          const item = { id, inst: this.instanceData(s.obj as THREE.InstancedMesh, parts) };
          return sized(item, (pb, n) => pb.add('instances', item, n));
        },
      ],
    ];
    for (const [queue, build] of steps) {
      for (const id of queue) {
        if (!p.room()) return false;
        queue.delete(id);
        const parts: BlobPart[] = [];
        const built = build(id, parts);
        if (!built) continue;
        const stream: Stream = { parts, next: 0, size: built.size, done: built.emit };
        if (!this.pumpStream(p, stream)) {
          this.chainStream = stream;
          return false;
        }
      }
      if (queue.size) return false;
    }
    return true;
  }

  /** Transforms, visibility, lights, camera and removals: small, and only once the chain is out. */
  private drainTail(p: PacketBuilder): boolean {
    if (this.dirtyXf.size) {
      const room = Math.max(1, Math.floor((p.budget - p.size) / 72));
      const ids: number[] = [];
      for (const id of this.dirtyXf) {
        if (ids.length >= room) break;
        const s = this.objects.get(id);
        this.dirtyXf.delete(id);
        if (s?.sent) ids.push(id);
      }
      if (ids.length) {
        const m = new Float32Array(ids.length * 12);
        ids.forEach((id, i) => m.set(this.objects.get(id)!.m, i * 12));
        const d = bytesToBase64(viewBytes(m));
        p.packet.xf = { ids, m: { d } };
        p.size += d.length + ids.length * 7 + 32;
      }
      if (this.dirtyXf.size) return false;
    }
    if (this.dirtyVis.size) {
      for (const id of this.dirtyVis) {
        const s = this.objects.get(id);
        if (!s?.sent || s.visible === s.sentVisible) continue;
        s.sentVisible = s.visible;
        if (s.visible) (p.packet.show ??= []).push(id);
        else (p.packet.hide ??= []).push(id);
        p.size += 8;
      }
      this.dirtyVis.clear();
    }
    if (this.env && this.envJson !== this.sentEnvJson) {
      p.packet.env = this.env;
      this.sentEnvJson = this.envJson;
      p.size += this.envJson.length;
    }
    if (this.cameraItem && this.cameraJson !== this.sentCameraJson) {
      p.packet.camera = this.cameraItem;
      this.sentCameraJson = this.cameraJson;
      p.size += this.cameraJson.length;
    }
    const r = this.removeQueue;
    if (r.objects.size || r.geometries.size || r.materials.size || r.textures.size) {
      const remove: NonNullable<Packet['remove']> = {};
      if (r.objects.size) remove.objects = [...r.objects];
      if (r.geometries.size) remove.geometries = [...r.geometries];
      if (r.materials.size) remove.materials = [...r.materials];
      if (r.textures.size) remove.textures = [...r.textures];
      p.packet.remove = remove;
      p.size += JSON.stringify(remove).length;
      for (const q of Object.values(r)) q.clear();
    }
    return true;
  }

  private drainTextures(p: PacketBuilder): void {
    if (this.textureStream) {
      if (!this.pumpStream(p, this.textureStream)) return;
      this.textureStream = null;
    }
    for (const id of this.dirtyTex) {
      if (!p.room()) return;
      this.dirtyTex.delete(id);
      const s = this.textures.get(id);
      if (!s) continue;
      if (!s.pixelsQueued && s.samplerJson === s.sentSamplerJson) continue;
      if (!s.pixelsQueued && !s.sentPixels) continue;
      const parts: BlobPart[] = [];
      const item = this.textureItem(s, parts);
      const { size, emit } = sized(item, (pb, n) => pb.add('textures', item, n));
      const stream: Stream = { parts, next: 0, size, done: emit };
      if (!this.pumpStream(p, stream)) {
        this.textureStream = stream;
        return;
      }
    }
  }

  /**
   * The next packet, at most about `budget` JSON characters (one item that can't be split may add up
   * to wire.PACKET_SLACK), or null when there is nothing to send.
   */
  drain(budget = DEFAULT_BUDGET): Packet | null {
    if (this.disposed) return null;
    const p = new PacketBuilder(this.seq + 1, Math.max(4096, budget));
    this.partChars = Math.max(1024, Math.min(this.chunkChars, Math.floor(p.budget / 2)));
    if (this.resetPending) {
      p.packet.reset = true;
      this.resetPending = false;
    }
    while (this.unsentUnsupported.length && p.size < p.budget / 8) p.add('unsupported', this.unsentUnsupported.shift()!);
    // Textures get a quarter of the room first, so a long load still shows labels as it goes.
    const full = p.budget;
    (p as { budget: number }).budget = Math.max(4096, Math.floor(full / 4));
    this.drainTextures(p);
    (p as { budget: number }).budget = full;
    const chained = this.drainChain(p);
    p.packet.commit = chained && this.drainTail(p);
    this.drainTextures(p);
    if (p.empty() && !(p.packet.commit && this.uncommitted)) return null;
    this.uncommitted = !p.packet.commit;
    this.seq++;
    const size = JSON.stringify(p.packet).length;
    this.stats.packets++;
    this.stats.bytes += size;
    this.stats.lastPacketBytes = size;
    this.stats.largestPacketBytes = Math.max(this.stats.largestPacketBytes, size);
    return p.packet;
  }

  report(): NativeSceneReport {
    let pending = 0;
    for (const s of this.textures.values()) if (!s.pixels && !s.encoding) pending++;
    return {
      unsupported: [...this.unsupported.values()],
      errors: [...this.errors],
      stats: {
        objects: this.objects.size,
        geometries: this.geometries.size,
        materials: this.materials.size,
        textures: this.textures.size,
        pendingTextures: pending,
        encoding: this.encoding,
        ...this.stats,
        queued: {
          geometries: this.dirtyGeo.size,
          materials: this.dirtyMat.size,
          objects: this.dirtyObj.size,
          instances: this.dirtyInst.size,
          transforms: this.dirtyXf.size,
          textures: this.dirtyTex.size,
          blobParts: (this.chainStream ? this.chainStream.parts.length - this.chainStream.next : 0) + (this.textureStream ? this.textureStream.parts.length - this.textureStream.next : 0),
        },
      },
    };
  }
}

interface Emit {
  size: number;
  emit: (p: PacketBuilder) => void;
}

/** An item with its JSON size measured once. */
function sized<T>(item: T, add: (p: PacketBuilder, size: number) => void): Emit {
  const size = JSON.stringify(item).length + 1;
  return { size, emit: (p) => add(p, size) };
}

/** The renderOrder of the nearest Group ancestor (three sorts by it before renderOrder). */
function groupOrderOf(o: THREE.Object3D): number {
  for (let p = o.parent; p; p = p.parent) if ((p as THREE.Group).isGroup) return p.renderOrder;
  return 0;
}
