// The GLSL behind theme-stage.ts: one fragment source per THEME_SHADERS name, each drawn as a single
// fullscreen triangle. Every source shares HEADER's uniforms (uRes in device pixels, uTime in shader
// seconds, uColors and uColorCount from the theme) and helpers. Overlays paint premultiplied light on transparency over the artwork.

import type { ThemeShader } from '../../shared/companion-themes';

/** A fullscreen triangle from gl_VertexID alone, so the stage binds no buffers. */
export const THEME_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HEADER = `precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColors[4];
uniform int uColorCount;
out vec4 outColor;

// Dave Hoskins' sine-free hashes: identical on every GPU and stable at large coordinates.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);
// Two independent value noises for the price of one lattice walk.
vec2 noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash22(i), hash22(i + vec2(1.0, 0.0)), u.x), mix(hash22(i + vec2(0.0, 1.0)), hash22(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 fbm3x2(vec2 p) {
  vec2 v = noise2(p) * 0.5;
  p = OCTAVE * p;
  v += noise2(p) * 0.25;
  p = OCTAVE * p;
  return (v + noise2(p) * 0.125) / 0.875;
}
float fbm3(vec2 p) {
  float v = noise(p) * 0.5;
  p = OCTAVE * p;
  v += noise(p) * 0.25;
  p = OCTAVE * p;
  return (v + noise(p) * 0.125) / 0.875;
}
// The theme's i-th color (theme-stage.ts repeats the last one to fill all four).
vec3 tone(int i) { return uColors[clamp(i, 0, 3)]; }
// Centered coordinates: y runs -0.5..0.5 over the window's height, x by its aspect.
vec2 centered() { return (gl_FragCoord.xy - 0.5 * uRes) / uRes.y; }
// One device pixel in centered units.
float devicePx() { return 1.0 / uRes.y; }
// Triangular dither of about one 8-bit step, so long gradients never band.
float dither() { return (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.17) - 1.0) / 255.0; }
// At most one star per cell of a grid \`scale\` cells tall, \`chance\` of cells lit; returns its light.
float starLayer(vec2 p, float scale, float chance, float t) {
  vec2 g = p * scale;
  vec2 id = floor(g);
  vec3 h = hash32(id + scale * 7.0);
  if (h.z > chance) return 0.0;
  vec2 f = fract(g) - 0.5 - (h.xy - 0.5) * 0.7;
  float r = scale * devicePx() * mix(0.8, 2.0, h.x * h.x);
  float core = exp(-dot(f, f) / (r * r));
  float twinkle = 0.7 + 0.3 * sin(t * (0.6 + 2.2 * h.y) + h.x * 40.0);
  return core * twinkle * mix(0.25, 1.0, pow(fract(h.x * 7.13 + h.y * 3.7), 3.0));
}
// Like starLayer, tinted by the theme, with a soft halo and, where spikes is 1, diffraction spikes on the brightest.
vec3 starCell(vec2 p, float scale, float chance, float t, float spikes) {
  vec2 g = p * scale;
  vec3 h = hash32(floor(g) + scale * 3.7);
  if (h.z > chance) return vec3(0.0);
  vec2 f = fract(g) - 0.5 - (h.xy - 0.5) * 0.6;
  float px = scale * devicePx();
  float mag = pow(fract(h.x * 7.13 + h.y * 3.7), 2.5);
  float r = px * mix(0.8, 2.1, mag);
  float core = exp(-dot(f, f) / (r * r));
  float halo = exp(-length(f) / (px * 6.0)) * 0.05 * mag;
  float bright = step(0.86, mag) * spikes;
  vec2 a = abs(f);
  float spike = bright * (exp(-a.x / (px * 0.7)) * exp(-a.y / (px * 9.0)) + exp(-a.y / (px * 0.7)) * exp(-a.x / (px * 9.0))) * 0.35;
  float twinkle = 0.62 + 0.38 * sin(t * (0.8 + 2.4 * h.y) + h.x * 40.0);
  vec3 tint = mix(vec3(1.0), tone(int(h.y * 3.0)), 0.25 + 0.6 * fract(h.z * 31.0));
  return tint * (core + halo + spike) * twinkle * mix(0.3, 1.15, mag);
}
// Light over transparency, premultiplied: alpha is the light's strength, the color its hue.
vec4 lightColor(vec3 c) {
  c = max(c + dither(), 0.0);
  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  return vec4(min(c, vec3(a)), a);
}
`;

const frag = (body: string) => `#version 300 es\n${HEADER}${body}`;

/** Drifting gas and stars over the artwork. */
const NEBULA = frag(`
void main() {
  vec2 p = centered();
  float t = uTime * 0.035;
  vec2 q = p * 1.9 + vec2(t * 0.5, -t * 0.2);
  vec2 w = fbm3x2(q * 0.6 + vec2(t * -0.3, t));
  float f = fbm3(q + 1.7 * w);
  float gas = smoothstep(0.3, 0.95, f);
  // Fine wisps only where there is gas to carry them.
  if (gas > 0.003) gas *= 0.45 + 0.9 * fbm3(q * 4.3 + w * 3.0 - t * 0.6);
  float region = smoothstep(0.45, 0.65, w.y + 0.25 * (f - 0.5));
  vec3 cloud = mix(tone(0), tone(1), region);
  float dust = smoothstep(0.5, 0.78, w.x * 0.55 + f * 0.5);
  vec3 light = (cloud * (gas * 0.5 + gas * gas * 1.2) + tone(2) * pow(gas, 4.0) * 1.1) * (1.0 - 0.5 * dust) + cloud * 0.03 * smoothstep(0.2, 0.7, f);
  vec3 stars = starCell(p, 32.0, 0.12, uTime, 1.0) + vec3(starLayer(p + 1.7, 90.0, 0.1, uTime) * 0.7 + starLayer(p - 4.3, 200.0, 0.1, uTime) * 0.4);
  outColor = lightColor(light * 0.6 + stars * 0.35);
}
`);

/** Stars twinkling in three slowly drifting depths, a few bright ones with soft spikes, and now and then a shooting star. */
const STARFIELD = frag(`
void main() {
  vec2 p = centered();
  float t = uTime;
  vec3 c = starCell(p + vec2(t * 0.002, 0.0), 26.0, 0.2, t, 1.0);
  c += starCell(p + vec2(t * 0.0012, 0.0) + 5.3, 60.0, 0.1, t, 0.0) * 0.8;
  c += starCell(p + vec2(t * 0.0006, 0.0) - 2.9, 140.0, 0.06, t, 0.0) * 0.55;
  c *= smoothstep(-0.28, 0.02, p.y);
  float period = 9.0;
  float k = floor(t / period);
  float phase = fract(t / period) / 0.11;
  if (phase < 1.0) {
    vec2 h = hash22(vec2(k, 7.0));
    vec2 start = vec2(mix(-0.4, 0.9, h.x), mix(0.2, 0.48, h.y));
    vec2 dir = normalize(vec2(-1.0, -0.42 - 0.3 * h.y));
    vec2 head = start + dir * phase * 0.55;
    vec2 rel = p - head;
    float along = -dot(rel, dir);
    float across = abs(rel.x * dir.y - rel.y * dir.x);
    float len = 0.16;
    float tail = step(0.0, along) * (1.0 - smoothstep(0.0, len, along)) * smoothstep(-0.004, 0.0, along + 0.002);
    float width = devicePx() * (1.0 + 1.5 * (1.0 - along / len));
    float fade = sin(3.14159265 * phase);
    c += mix(vec3(1.0), tone(2), 0.3) * tail * exp(-across * across / (width * width)) * fade * 1.4;
  }
  outColor = lightColor(c);
}
`);

/** Fireflies wandering low through the garden, blinking slowly, near ones larger and softer. */
const FIREFLIES = frag(`
vec3 swarm(vec2 p, float scale, float t, float soft) {
  vec2 g = p * scale;
  vec2 id = floor(g);
  vec2 side = step(0.5, fract(g)) * 2.0 - 1.0;
  float px = scale * devicePx();
  vec3 c = vec3(0.0);
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 cell = id + vec2(float(x), float(y)) * side;
      vec3 h = hash32(cell + scale * 1.7);
      if (h.z > 0.55) continue;
      vec2 wander = 0.3 * vec2(sin(t * (0.21 + 0.2 * h.x) + h.y * 30.0) + 0.4 * sin(t * 0.53 + h.x * 9.0), cos(t * (0.17 + 0.2 * h.y) + h.x * 21.0) + 0.4 * cos(t * 0.47 + h.y * 7.0));
      vec2 pos = cell + 0.5 + (h.xy - 0.5) * 0.12 + wander;
      vec2 d = g - pos;
      float r2 = dot(d, d);
      float blink = pow(0.5 + 0.5 * sin(t * (0.5 + 0.6 * h.y) + h.x * 50.0), 3.0);
      float core = exp(-r2 / (px * px * mix(4.0, 9.0, h.y) * soft * soft));
      float halo = exp(-r2 * 26.0 / (soft * soft)) * 0.22 * smoothstep(0.25, 0.09, r2);
      vec3 tint = tone(int(fract(h.x * 13.0) * 3.0));
      c += tint * (core * 1.3 + halo) * blink;
    }
  }
  return c;
}
void main() {
  vec2 p = centered();
  float t = uTime;
  float low = smoothstep(0.42, -0.05, p.y);
  vec3 c = swarm(p + vec2(0.0, t * 0.004), 4.0, t, 2.2) * 0.75;
  c += swarm(p + vec2(3.1, 1.7 + t * 0.003), 9.0, t * 0.9, 1.0) * 0.8;
  outColor = lightColor(c * (0.15 + 0.85 * low));
}
`);

/** Sparks rising through a turbulent updraft at three depths, leaning with their drift and flickering as they cool, thickest near the floor. */
const EMBERS = frag(`
vec3 sparks(vec2 p, float scale, float rise, float t, float soft, float chance) {
  vec2 g = p * scale + vec2(0.0, -t * rise);
  vec2 id = floor(g);
  float px = scale * devicePx();
  vec3 c = vec3(0.0);
  for (int y = -1; y <= 0; y++) {
    vec2 cell = id + vec2(0.0, float(y));
    vec3 h = hash32(cell + scale * 5.1);
    if (h.z > chance) continue;
    float rate = 0.9 + h.y;
    float phase = t * rate + h.x * 20.0 + cell.y * 0.7;
    vec2 pos = cell + vec2(0.5 + (h.x - 0.5) * 0.45 + 0.28 * sin(phase), 0.5 + (h.y - 0.5) * 0.8);
    vec2 dir = normalize(vec2(0.28 * rate * cos(phase), rise));
    vec2 d = g - pos;
    vec2 local = vec2(dot(d, vec2(dir.y, -dir.x)), dot(d, dir));
    float w = px * mix(1.0, 1.9, h.y) * soft;
    float len = w * mix(1.3, 3.2, h.x);
    float core = exp(-(local.x * local.x) / (w * w) - (local.y * local.y) / (len * len));
    float glow = exp(-dot(d, d) / (w * w * 40.0)) * 0.16;
    float flicker = 0.6 + 0.4 * sin(t * (6.0 + 8.0 * h.x) + h.y * 60.0) * sin(t * 2.3 + h.x * 11.0);
    float heat = 0.3 + 0.7 * fract(h.z * 17.0 + h.x);
    vec3 tint = mix(tone(0), tone(1), heat * fract(h.y * 23.0));
    if (fract(h.x * 91.0) > 0.94) tint = tone(2);
    c += tint * (core * mix(1.2, 2.4, heat) + glow) * flicker;
  }
  return c;
}
void main() {
  vec2 p = centered();
  float t = uTime;
  vec2 drift = vec2(noise(p * 2.2 + vec2(0.0, -t * 0.25)) - 0.5, 0.0) * 0.14;
  vec2 q = p + drift;
  vec3 c = sparks(q, 5.0, 0.5, t, 2.6, 0.2) * 0.9;
  c += sparks(q + vec2(1.3, 0.0), 11.0, 0.8, t, 1.2, 0.26);
  c += sparks(q - vec2(2.1, 0.0), 22.0, 1.2, t, 1.0, 0.24) * 0.65;
  float floorHeat = smoothstep(0.6, -0.55, p.y);
  c *= 0.15 + 0.85 * floorHeat * floorHeat;
  c += tone(0) * 0.06 * exp(-(p.y + 0.5) * 5.0);
  outColor = lightColor(c);
}
`);
/** Sunlight through a moving surface: a caustic net brightest near the top, slanting shafts and drifting motes. */
const CAUSTICS = frag(`
float caustic(vec2 uv, float t) {
  vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
void main() {
  vec2 p = centered();
  float t = uTime * 0.35;
  vec2 uv = p * vec2(1.0, 1.35) * 0.9 + vec2(0.0, t * 0.02);
  float net = caustic(uv, t);
  float depth = smoothstep(-0.55, 0.5, p.y);
  float mixT = smoothstep(0.3, 0.7, noise(p * 1.3 + t * 0.05));
  vec3 hue = mix(tone(0), tone(1), mixT);
  vec3 c = mix(hue, tone(2), clamp(net * 0.6, 0.0, 1.0)) * net * (0.15 + 0.85 * depth) * 1.2;
  float sx = p.x + p.y * 0.35;
  float shafts = noise(vec2(sx * 7.0 + t * 0.2, t * 0.15)) * noise(vec2(sx * 3.0 - t * 0.1, 4.0));
  c += mix(tone(2), tone(0), 0.4) * pow(shafts, 1.5) * smoothstep(-0.4, 0.5, p.y) * 0.22;
  vec2 g = (p + vec2(t * 0.01, t * 0.025)) * 34.0;
  vec3 h = hash32(floor(g));
  vec2 f = fract(g) - 0.5 - (h.xy - 0.5) * 0.6;
  float mr = 34.0 * devicePx() * mix(1.0, 2.2, h.x);
  float mote = step(h.z, 0.12) * exp(-dot(f, f) / (mr * mr)) * (0.5 + 0.5 * sin(uTime * (0.6 + h.y) + h.x * 30.0));
  c += mix(tone(2), tone(1), h.y) * mote * 0.5;
  outColor = lightColor(c);
}
`);

/** Cherry petals tumbling down a soft wind at three depths; the nearest are larger and out of focus. */
const PETALS = frag(`
vec4 petal(vec2 p, float scale, float t, float soft, float alpha, float chance) {
  vec2 g = p * scale + vec2(-t * 0.35, t * 0.55);
  g.x += 0.35 * sin(g.y * 0.6 + t * 0.4);
  vec2 id = floor(g);
  vec3 h = hash32(id + scale * 2.3);
  if (h.z > chance) return vec4(0.0);
  vec2 f = fract(g) - 0.5 - (h.xy - 0.5) * 0.3;
  float a = t * mix(-0.9, 0.9, h.x) + h.y * 6.2831853;
  float ca = cos(a);
  float sa = sin(a);
  vec2 q = mat2(ca, sa, -sa, ca) * f;
  float flip = cos(t * (0.8 + 1.2 * h.y) + h.x * 20.0);
  q.x /= max(abs(flip), 0.15);
  float size = mix(0.12, 0.17, fract(h.z * 11.0));
  vec2 s = q / size;
  float y = clamp(s.y, -1.0, 1.0);
  float width = 0.62 * sqrt(max(1.0 - y * y, 0.0)) * (0.45 + 0.55 * (y + 1.0) * 0.5) + 0.04;
  float d = max(abs(s.x) - width, abs(s.y) - 1.0);
  d = max(d, 0.2 - length(vec2(s.x * 1.2, s.y - 1.08)));
  // fwidth would jump at cell seams; one device pixel in petal units, widened where the petal turns edge-on.
  float fw = scale * devicePx() / size * soft * 0.5 * (1.0 + 1.0 / max(abs(flip), 0.15));
  float shape = 1.0 - smoothstep(-fw, fw, d);
  vec3 col = mix(tone(0), tone(1), smoothstep(-0.9, 0.8, s.y));
  col = mix(col, tone(2), 0.45 * smoothstep(-0.2, -1.0, s.y));
  col *= flip < 0.0 ? 0.88 : 1.0;
  col += vec3(0.06) * smoothstep(0.25, 0.0, abs(s.x)) * smoothstep(-0.6, 0.6, s.y);
  float al = shape * alpha;
  return vec4(col * al, al);
}
vec4 over(vec4 front, vec4 back) { return front + back * (1.0 - front.a); }
void main() {
  vec2 p = centered();
  float t = uTime;
  vec4 c = petal(p + vec2(4.7, 0.0), 20.0, t * 0.7, 1.0, 0.6, 0.16);
  c = over(petal(p + vec2(1.9, 0.6), 10.0, t * 0.85, 1.0, 0.85, 0.12), c);
  c = over(petal(p, 4.6, t, 6.0, 0.8, 0.08), c);
  outColor = vec4(min(c.rgb + dither() * c.a, vec3(c.a)), c.a);
}
`);
/** Rain slanting past the lens at three depths, tinted by the neon, and beads that land on the glass and fade. */
const RAIN = frag(`
float streaks(vec2 p, float cols, float fall, float t, float len, float chance) {
  vec2 g = vec2((p.x + p.y * 0.12) * cols, p.y * cols * 0.12 + t * fall);
  vec2 id = floor(g);
  vec3 h = hash32(id + cols);
  if (h.z > chance) return 0.0;
  vec2 f = fract(g);
  float x = (f.x - 0.5 - (h.x - 0.5) * 0.7) / cols;
  float w = devicePx() * mix(0.7, 1.4, h.y);
  float y = f.y - h.y * (1.0 - len);
  float body = smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(0.0, len, y));
  return exp(-x * x / (w * w)) * body * body * mix(0.4, 1.0, h.x);
}
void main() {
  vec2 p = centered();
  float t = uTime;
  float r = streaks(p, 90.0, 2.6, t, 0.55, 0.22) * 0.55;
  r += streaks(p + 1.3, 55.0, 2.0, t, 0.5, 0.18) * 0.8;
  r += streaks(p + 2.9, 28.0, 1.5, t, 0.45, 0.14);
  vec3 neon = mix(tone(0), tone(1), smoothstep(-0.2, 0.6, p.x + 0.2 * p.y));
  vec3 c = mix(neon, tone(2), 0.3) * r * 1.6;
  vec2 g = p * 16.0;
  vec2 id = floor(g);
  vec3 h = hash32(id + 41.0);
  if (h.z < 0.22) {
    vec2 f = fract(g) - 0.5 - (h.xy - 0.5) * 0.5;
    float life = fract(t * 0.12 + h.x * 7.0);
    float show = smoothstep(0.0, 0.03, life) * (1.0 - smoothstep(0.35, 1.0, life));
    float rad = mix(0.07, 0.16, h.y);
    float d = length(f * vec2(1.0, 0.92));
    float px = 16.0 * devicePx();
    float disc = 1.0 - smoothstep(rad - px, rad + px, d);
    float rim = disc * smoothstep(rad * 0.55, rad, d) * 0.6;
    float glint = exp(-dot(f - vec2(-0.3, 0.35) * rad, f - vec2(-0.3, 0.35) * rad) / (rad * rad * 0.04));
    c += (neon * (disc * 0.05 + rim * 0.35) + mix(neon, vec3(1.0), 0.6) * glint * disc * 0.6) * show;
  }
  outColor = lightColor(c);
}
`);

export const THEME_FRAGMENT_SHADERS: Record<ThemeShader, string> = {
  nebula: NEBULA,
  starfield: STARFIELD,
  fireflies: FIREFLIES,
  embers: EMBERS,
  caustics: CAUSTICS,
  petals: PETALS,
  rain: RAIN,
};
