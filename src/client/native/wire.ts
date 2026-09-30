/**
 * The native scene stream's wire format (version 1) and its pure encoders.
 *
 * The page keeps its three.js scene; `NativeScene` (scene.ts) diffs it and sends these packets to the
 * headset's GLES renderer (native/android/app/src/main/cpp/scene_*.{h,cpp}). Everything here is plain
 * data: JSON-safe objects, ASCII strings only, binary arrays as little-endian base64. Nothing touches
 * the DOM or WebGL, so tests load it in Node.
 */

export const WIRE_VERSION = 1;

/** Largest base64 payload inside one blob part. Every packet stays under `budget + PACKET_SLACK`. */
export const DEFAULT_CHUNK_CHARS = 192 * 1024;
/** Default packet budget (JSON characters) for one drain. */
export const DEFAULT_BUDGET = 256 * 1024;
/** Binary arrays up to this many base64 characters travel inline; larger ones as blob parts. */
export const INLINE_CHARS = 4 * 1024;
/**
 * What one packet may carry over its budget: one item that could not be split. Binary data always
 * splits, so that is only an item's JSON fields (a material, or an object with a long material list).
 */
export const PACKET_SLACK = 16 * 1024;

/** A binary array: inline base64 (`d`), or the id of a blob sent earlier in parts (`blob`). */
export type Bin = { d: string } | { blob: number };

/** One slice of a large binary array. Parts of one blob are sent in order, back to back. */
export interface BlobPart {
  id: number;
  part: number;
  parts: number;
  /** Total bytes once decoded, for preallocation and validation. */
  bytes: number;
  d: string;
}

export type TextureFormat = 'png' | 'jpeg' | 'webp' | 'rgba8';
/** GL filter names, as three's constants map to them. */
export type Filter = 'nearest' | 'linear' | 'nearestMipNearest' | 'linearMipNearest' | 'nearestMipLinear' | 'linearMipLinear';
export type Wrap = 'repeat' | 'clamp' | 'mirror';

export interface TextureSampler {
  wrapS: Wrap;
  wrapT: Wrap;
  mag: Filter;
  min: Filter;
  mips: boolean;
  aniso: number;
  /** Decode as sRGB (texture.colorSpace === SRGBColorSpace): the renderer uploads GL_SRGB8_ALPHA8. */
  srgb: boolean;
  flipY: boolean;
  premultiply: boolean;
}

export interface TextureItem extends TextureSampler {
  id: number;
  rev: number;
  w: number;
  h: number;
  /** Absent in a sampler-only update: the pixels already sent stay. */
  fmt?: TextureFormat;
  data?: Bin;
}

export interface AttributeItem {
  /** Components per vertex (position/normal 3, uv 2, color 3 or 4). */
  n: number;
  /** Float32 values, count * n of them. */
  data: Bin;
}

export type AttributeName = 'position' | 'normal' | 'uv' | 'color';

export interface GeometryItem {
  id: number;
  rev: number;
  /** Vertex count. */
  count: number;
  /** The attributes this item carries. With `partial`, missing attributes keep their previous data. */
  attrs: Partial<Record<AttributeName, AttributeItem>>;
  partial?: true;
  index?: { t: 'u16' | 'u32'; data: Bin; count: number } | null;
  /** [start, count, materialIndex] in index (or vertex) units, as geometry.groups. */
  groups: [number, number, number][];
  /** geometry.drawRange: [start, count]; count -1 is "to the end". */
  range: [number, number];
  /** Bounding sphere in geometry space: [x, y, z, radius]. */
  sphere: [number, number, number, number];
}

export type MaterialType = 'basic' | 'toon' | 'lambert' | 'phong' | 'standard' | 'points' | 'line' | 'sprite' | 'shader';
export type Side = 'front' | 'back' | 'double';
export type BlendMode = 'none' | 'normal' | 'additive' | 'subtractive' | 'multiply' | 'custom';

/** A map slot: texture id and its uv transform (texture.matrix, 3x3 column-major). */
export interface MapRef {
  t: number;
  m: number[];
  /** Which uv set (texture.channel). Only 0 exists natively. */
  ch?: number;
}

export interface MaterialItem {
  id: number;
  rev: number;
  type: MaterialType;
  /** Linear RGB. */
  color: [number, number, number];
  opacity: number;
  /** Linear RGB, already multiplied by emissiveIntensity. */
  emissive?: [number, number, number];
  transparent: boolean;
  alphaTest: number;
  side: Side;
  /** Shadow pass side (material.shadowSide ?? three's default for `side`). */
  shadowSide: Side;
  depthTest: boolean;
  depthWrite: boolean;
  depthFunc: string;
  colorWrite: boolean;
  /** [mode, premultipliedAlpha, eq, src, dst, eqAlpha, srcAlpha, dstAlpha] (GL enum names). */
  blend: [BlendMode, boolean, string, string, string, string, string, string];
  vertexColors: boolean;
  fog: boolean;
  /** A lit type (toon, lambert, phong, standard): lights, shadows and the sky's lamp light apply. */
  lit: boolean;
  /**
   * world/sky.ts's shader patch applies (the material keeps the default Material.onBeforeCompile):
   * its haze replaces plain fog, and on lit materials its wet ground, snow and lamp light apply.
   */
  sky: boolean;
  visible: boolean;
  polygonOffset: [number, number] | null;
  wireframe: boolean;
  forceSinglePass: boolean;
  toneMapped: boolean;
  map?: MapRef;
  alphaMap?: MapRef;
  emissiveMap?: MapRef;
  gradientMap?: MapRef;
  /** Points: size in pixels (or world units with attenuation). */
  size?: number;
  sizeAttenuation?: boolean;
  /** Sprite rotation in radians. */
  rotation?: number;
  metalness?: number;
  roughness?: number;
  /** Phong. */
  specular?: [number, number, number];
  shininess?: number;
  flatShading?: boolean;
  /** A ShaderMaterial the renderer knows by name (see shaders.ts), and its uniforms. */
  shader?: { program: string; uniforms: Record<string, number | number[]> };
  /**
   * Terminal text the headset also draws in its high-resolution screen layer (world/laptop.ts
   * tags its screen with `userData.nativeSharpText`). Only sent on opaque basic materials with a
   * map; the world draw is unchanged and remains the fallback.
   */
  sharpText?: true;
}

export type ObjectKind = 'mesh' | 'instanced' | 'sprite' | 'points' | 'lines' | 'lineStrip' | 'lineLoop';

export interface InstanceData {
  count: number;
  /** Per instance, a 3x4 affine matrix (12 floats, column-major columns 0-3 minus the last row). */
  m: Bin;
  /** Per instance linear RGB, when instanceColor is set. */
  c?: Bin;
  /** Bounding sphere of every instance, in object space. */
  sphere: [number, number, number, number];
}

export interface ObjectItem {
  id: number;
  kind: ObjectKind;
  geo: number;
  /** One material, or one per geometry group. */
  mat: number | number[];
  /** [groupOrder, renderOrder]. */
  order: [number, number];
  cast: boolean;
  recv: boolean;
  /** frustumCulled. */
  cull: boolean;
  visible: boolean;
  /** World matrix, 12 floats (3x4 affine, column-major). */
  m: number[];
  /** Sprite center. */
  center?: [number, number];
  inst?: InstanceData;
  /** three.js object name, for diagnostics only. */
  name?: string;
}

export interface TransformBatch {
  ids: number[];
  /** 12 floats per id. */
  m: Bin;
}

export interface InstanceUpdate {
  id: number;
  inst: InstanceData;
}

export interface LightDirectional {
  /** Linear color * intensity. */
  color: [number, number, number];
  /** World-space direction toward the light (three's directionalLight.direction, but in world space). */
  dir: [number, number, number];
  shadow?: ShadowInfo;
}

export interface ShadowInfo {
  /** Light view-projection (world to clip), column-major. */
  viewProj: number[];
  /** World to shadow texture coordinates ([0,1] range), three's shadow.matrix, column-major. */
  matrix: number[];
  mapSize: [number, number];
  bias: number;
  normalBias: number;
  radius: number;
  intensity: number;
}

export interface LightPoint {
  pos: [number, number, number];
  color: [number, number, number];
  distance: number;
  decay: number;
}

export interface LightHemi {
  sky: [number, number, number];
  ground: [number, number, number];
  /** World-space up direction of the light. */
  dir: [number, number, number];
}

/** world/sky.ts's shader uniforms and constants, for the same extra lighting natively. */
export interface SkyInfo {
  on: number;
  inside: number;
  office: [number, number, number];
  garage: [number, number, number];
  lampCount: number;
  lamps: number[];
  lampColors: number[];
  lampMin: [number, number, number];
  lampMax: [number, number, number];
  screenCount: number;
  screens: number[];
  screenDirs: number[];
  screenColors: number[];
  screenMin: [number, number, number];
  screenMax: [number, number, number];
  wet: number;
  snow: number;
  drop: number;
  street: number;
  /** Haze constants (sky.ts HAZE_CLEAR, HAZE_ABOVE, HAZE_MAX). */
  hazeClear: number;
  hazeAbove: number;
  hazeMax: number;
  /** skyInOffice box: min and max corners. */
  officeMin: [number, number, number];
  officeMax: [number, number, number];
  /** skyInGarage: [minX + 0.05, minZ + 0.05, maxX, maxZ, streetY - 0.5, -SLAB + 0.02]. */
  garageBox: [number, number, number, number, number, number];
}

export interface EnvItem {
  /** Linear RGB, or null for none. */
  background: [number, number, number] | null;
  fog: { color: [number, number, number]; near: number; far: number } | { color: [number, number, number]; density: number } | null;
  ambient: [number, number, number];
  hemi: LightHemi[];
  dir: LightDirectional[];
  point: LightPoint[];
  sky: SkyInfo | null;
}

export interface CameraItem {
  /** World matrix, 12 floats. */
  m: number[];
  near: number;
  far: number;
  fov: number;
}

export interface Unsupported {
  kind: string;
  id: number;
  name?: string;
  reason: string;
}

export interface Removals {
  objects?: number[];
  geometries?: number[];
  materials?: number[];
  textures?: number[];
}

/**
 * One packet. The renderer applies it in field order: blobs, textures, geometries, materials,
 * objects, instances, xf, show/hide, env, camera, remove. `commit` is true when every change captured
 * so far is in this or an earlier packet, which is when the renderer publishes the new state.
 */
export interface Packet {
  v: 1;
  seq: number;
  reset?: true;
  commit: boolean;
  blobs?: BlobPart[];
  textures?: TextureItem[];
  geometries?: GeometryItem[];
  materials?: MaterialItem[];
  objects?: ObjectItem[];
  instances?: InstanceUpdate[];
  xf?: TransformBatch;
  show?: number[];
  hide?: number[];
  env?: EnvItem;
  camera?: CameraItem;
  remove?: Removals;
  unsupported?: Unsupported[];
}

// ---- Encoders -----------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of `bytes`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') {
    const parts: string[] = [];
    const STEP = 0x6000; // a multiple of 3, so every chunk but the last encodes without padding
    for (let i = 0; i < bytes.length; i += STEP) {
      const sub = bytes.subarray(i, Math.min(bytes.length, i + STEP));
      parts.push(g.btoa(String.fromCharCode.apply(null, sub as unknown as number[])));
    }
    return parts.join('');
  }
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    const third = i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${third}=`;
  }
  return out;
}

/** Decodes standard base64 (tests and diagnostics). */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** The bytes of a typed array view (little-endian on every platform the office runs on). */
export function viewBytes(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/** Rounds to 6 significant-ish decimals so JSON stays short; matrices travel as binary instead. */
export function r6(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e6) / 1e6;
}

export function rgb(c: { r: number; g: number; b: number }, scale = 1): [number, number, number] {
  return [r6(c.r * scale), r6(c.g * scale), r6(c.b * scale)];
}

/** The 12 affine floats of a column-major 4x4 (drops the last row, which is 0 0 0 1 for affine). */
export function affine12(e: ArrayLike<number>, out: Float32Array, offset = 0): void {
  out[offset] = e[0];
  out[offset + 1] = e[1];
  out[offset + 2] = e[2];
  out[offset + 3] = e[4];
  out[offset + 4] = e[5];
  out[offset + 5] = e[6];
  out[offset + 6] = e[8];
  out[offset + 7] = e[9];
  out[offset + 8] = e[10];
  out[offset + 9] = e[12];
  out[offset + 10] = e[13];
  out[offset + 11] = e[14];
}

/** True if the 16-float matrix `e` equals the 12 cached floats (bit-exact after float32 rounding). */
export function sameAffine(e: ArrayLike<number>, cached: Float32Array, offset = 0): boolean {
  return (
    cached[offset] === Math.fround(e[0]) &&
    cached[offset + 1] === Math.fround(e[1]) &&
    cached[offset + 2] === Math.fround(e[2]) &&
    cached[offset + 3] === Math.fround(e[4]) &&
    cached[offset + 4] === Math.fround(e[5]) &&
    cached[offset + 5] === Math.fround(e[6]) &&
    cached[offset + 6] === Math.fround(e[8]) &&
    cached[offset + 7] === Math.fround(e[9]) &&
    cached[offset + 8] === Math.fround(e[10]) &&
    cached[offset + 9] === Math.fround(e[12]) &&
    cached[offset + 10] === Math.fround(e[13]) &&
    cached[offset + 11] === Math.fround(e[14])
  );
}

/**
 * Splits a binary payload for the wire: inline base64 when small, otherwise blob parts that the
 * caller sends ahead of the item that references `{ blob: id }`.
 */
export function packBinary(bytes: Uint8Array, blobId: () => number, chunkChars = DEFAULT_CHUNK_CHARS, inlineChars = INLINE_CHARS): { bin: Bin; parts: BlobPart[] } {
  const b64 = bytesToBase64(bytes);
  if (b64.length <= inlineChars) return { bin: { d: b64 }, parts: [] };
  // Parts split on 4-character boundaries so each decodes on its own.
  const step = Math.max(4, chunkChars - (chunkChars % 4));
  const id = blobId();
  const count = Math.ceil(b64.length / step);
  const parts: BlobPart[] = [];
  for (let i = 0; i < count; i++) parts.push({ id, part: i, parts: count, bytes: bytes.byteLength, d: b64.slice(i * step, (i + 1) * step) });
  return { bin: { blob: id }, parts };
}

/** The JSON size of a value, as the bridge will serialize it. */
export function jsonSize(v: unknown): number {
  return JSON.stringify(v).length;
}
