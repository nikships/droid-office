// The GLSL behind theme-stage.ts: one fragment source per THEME_SHADERS name, each drawn as a single
// fullscreen triangle. Every source shares HEADER's uniforms (uRes in device pixels, uTime in shader
// seconds, uColors and uColorCount from the theme) and helpers. Scenes paint opaque color over the
// window; overlays paint premultiplied light on transparency over the theme's artwork, and a source
// built for an overlay gets `#define OVERLAY 1` (theme-stage.ts fragmentSource).

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
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = OCTAVE * p;
    a *= 0.5;
  }
  return v / 0.9375;
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
vec4 sceneColor(vec3 c) { return vec4(clamp(c + dither(), 0.0, 1.0), 1.0); }
// Light over transparency, premultiplied: alpha is the light's strength, the color its hue.
vec4 lightColor(vec3 c) {
  c = max(c + dither(), 0.0);
  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  return vec4(min(c, vec3(a)), a);
}
`;

const frag = (body: string) => `#version 300 es\n${HEADER}${body}`;

// ---- Scenes ----------------------------------------------------------------------------------------

/** Curtains of northern light over a polar night and a dark ridge: a bright green hem, cyan and violet rays above it. */
const AURORA = frag(`
void main() {
  vec2 p = centered();
  float t = uTime;
  float px = devicePx();
  vec3 night = tone(3);
  vec3 col = mix(night * 2.6 + vec3(0.0, 0.014, 0.02), night * 0.5, smoothstep(-0.4, 0.5, p.y));
  col += vec3(0.8, 0.9, 1.0) * (starLayer(p, 70.0, 0.09, t) + 0.6 * starLayer(p + 3.1, 140.0, 0.07, t)) * smoothstep(-0.3, 0.2, p.y);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = p.x * (1.0 - 0.15 * fi) + fi * 1.37;
    float s = t * (0.03 + 0.012 * fi);
    float hem = 0.0 + 0.1 * fi + 0.12 * sin(x * 1.6 + s * 1.7 + fi * 2.0) + 0.2 * (fbm(vec2(x * 0.7 - s, fi * 3.0)) - 0.5) - 0.12 * p.x * (1.0 - fi);
    float d = p.y - hem;
    float rx = x + d * 0.1;
    float n1 = noise(vec2(rx * 24.0 - s * 5.0, fi * 11.0 + d * 2.5));
    float n2 = noise(vec2(rx * 70.0 + s * 8.0, fi * 5.0));
    float reach = mix(0.03, 0.22, n1 * n1) * (1.0 - 0.2 * fi);
    float body = exp(-max(-d, 0.0) * 80.0) * exp(-max(d, 0.0) / reach) * (1.0 - 0.7 * smoothstep(0.1, 0.5, p.y));
    float ray = mix(0.35, 1.0, n1 * 0.7 + n2 * 0.3);
    float along = smoothstep(0.38, 0.8, fbm(vec2(x * 1.1 + s * 1.4, fi * 7.0 + 2.0)));
    float hemLine = exp(-abs(d + 0.004) * 60.0);
    vec3 c = mix(tone(0), tone(1), smoothstep(0.03, 0.18, d));
    c = mix(c, tone(2), smoothstep(0.12, 0.36, d));
    float haze = exp(-max(-d, 0.0) * 30.0) * exp(-max(d, 0.0) * 5.0) * 0.22;
    glow += c * along * (body * ray + hemLine * 0.3 + haze) * (1.0 - 0.2 * fi);
  }
  float ridge = -0.3 + 0.07 * fbm(vec2(p.x * 2.2 + 4.0, 0.5)) + 0.025 * noise(vec2(p.x * 12.0, 2.0));
  float land = smoothstep(ridge + px, ridge - px, p.y);
  col += glow * (1.0 - land);
  col += tone(0) * 0.05 * exp(-max(p.y - ridge, 0.0) * 9.0) * (1.0 - land);
  col = mix(col, night * 0.35 + tone(0) * 0.012, land);
  col += tone(1) * 0.08 * smoothstep(2.5 * px, 0.0, abs(p.y - ridge));
  col = 1.0 - exp(-col * 1.2);
  outColor = sceneColor(col);
}
`); /** Drifting nebulae over a field of distant stars; as an overlay, only the glowing gas and the brightest stars. */
const NEBULA = frag(`
void main() {
  vec2 p = centered();
  float t = uTime * 0.02;
  vec2 q = p * 1.35 + vec2(t * 0.4, -t * 0.15);
  vec2 w = vec2(fbm(q * 0.9 + vec2(0.0, t)), fbm(q * 0.9 + vec2(5.2, 1.3) - vec2(t * 0.7, 0.0)));
  float f = fbm(q + 2.3 * w);
  float gas = pow(smoothstep(0.4, 1.0, f), 1.8);
  float ridge = 1.0 - abs(2.0 * f - 1.0);
  float filament = pow(ridge, 10.0) * smoothstep(0.2, 0.6, w.x);
  vec3 cloud = mix(tone(0), tone(1), smoothstep(0.35, 0.7, w.y + 0.25 * (f - 0.5)));
  float dust = smoothstep(0.52, 0.78, w.x * 0.6 + f * 0.5);
  vec3 light = (cloud * gas * 2.0 + tone(2) * pow(gas, 2.6) * 1.2 + mix(cloud, vec3(1.0), 0.35) * filament * 0.22) * (1.0 - 0.45 * dust);
  float stars = starLayer(p, 45.0, 0.05, uTime) * 1.3 + starLayer(p + 1.7, 110.0, 0.08, uTime) * 0.7 + starLayer(p - 4.3, 230.0, 0.1, uTime) * 0.4;
#ifdef OVERLAY
  outColor = lightColor(light * 0.8 + vec3(stars) * 0.4);
#else
  vec3 col = tone(3) * 0.8 + light + vec3(0.85, 0.9, 1.0) * stars * (1.0 - gas * 0.6);
  col = 1.0 - exp(-col * 1.3);
  outColor = sceneColor(col);
#endif
}
`);
/** Flowing cloth: a warped fold field lit from one side, deep shadows and bright sheen along the crests. */
const SILK = frag(`
float silk(vec2 p, float t) {
  vec2 q = p * 1.5;
  q += 0.32 * vec2(sin(q.y * 1.4 + t * 1.1), sin(q.x * 1.2 - t * 0.9 + 1.3));
  q += 0.16 * vec2(sin(q.y * 2.6 - t * 1.3 + 2.1), sin(q.x * 2.2 + t * 1.2 + 0.7));
  return sin(dot(q, vec2(5.0, 3.2))) * 0.7 + sin(dot(q, vec2(1.4, -2.6)) + t * 0.5) * 0.3;
}
void main() {
  vec2 p = centered();
  float t = uTime * 0.2;
  float e = 0.0015;
  float h = silk(p, t);
  vec2 grad = vec2(silk(p + vec2(e, 0.0), t) - silk(p - vec2(e, 0.0), t), silk(p + vec2(0.0, e), t) - silk(p - vec2(0.0, e), t)) / (2.0 * e);
  vec3 n = normalize(vec3(-grad * 0.24, 1.0));
  vec3 l = normalize(vec3(-0.5, 0.6, 0.62));
  float diffuse = max(dot(n, l), 0.0);
  float sheen = pow(max(dot(normalize(l + vec3(0.0, 0.0, 1.0)), n), 0.0), 14.0);
  float m = smoothstep(-0.8, 0.8, p.x * 0.8 - p.y * 0.5 + 0.2 * h);
  vec3 hue = mix(tone(0), tone(1), m);
  hue = mix(hue, tone(2), smoothstep(0.25, 1.0, p.y * 0.9 - p.x * 0.5 - h * 0.2));
  float light = pow(diffuse, 1.8);
  vec3 col = tone(3) + hue * (0.08 + 0.85 * light);
  col += mix(hue, vec3(1.0, 0.92, 0.85), 0.4) * sheen * 0.45;
  col *= 0.6 + 0.4 * smoothstep(-1.6, 1.2, p.x - p.y * 0.4 + 0.6);
  col = 1.0 - exp(-col * 1.5);
  outColor = sceneColor(col);
}
`); /** A drafting table at midnight: a drifting ink grid, a protractor turning slowly, a scan of light. */
const GRID = frag(`
float lines(vec2 x, float w) {
  vec2 d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-5);
  return 1.0 - min(min(d.x, d.y) / w, 1.0);
}
void main() {
  vec2 p = centered();
  float t = uTime;
  float px = devicePx();
  vec2 g = p + vec2(t * 0.010, t * 0.004);
  vec3 col = mix(tone(3), tone(2), 0.85 * exp(-2.2 * length(p - vec2(-0.1, 0.55))));
  col *= 0.94 + 0.08 * fbm(p * 6.0 + 3.0);
  float minor = lines(g * 32.0, 1.0);
  float major = lines(g * 8.0, 1.6);
  vec2 cell = floor(g * 8.0);
  float pick = hash12(cell);
  float pulse = step(0.93, pick) * pow(0.5 + 0.5 * sin(t * 0.7 + pick * 50.0), 6.0);
  col = mix(col, tone(0), pulse * 0.07);
  col = mix(col, tone(0), minor * 0.07 + major * 0.2);
  vec2 c = p - vec2(0.42, -0.08);
  float r = length(c);
  float ang = atan(c.y, c.x);
  float ring = smoothstep(1.2 * px, 0.0, abs(r - 0.34)) + 0.6 * smoothstep(1.0 * px, 0.0, abs(r - 0.22));
  float tickA = fract(ang / 6.2831853 * 72.0 - t * 0.02);
  float ticks = step(abs(tickA - 0.5), 0.5 * 72.0 * px / (6.2831853 * 0.34) * 1.5) * step(0.34, r) * step(r, 0.36 + 0.015 * step(fract((ang / 6.2831853) * 8.0 - t * 0.0028), 0.12));
  float arm = ang - (t * 0.05 - 1.2);
  arm = abs(mod(arm + 3.14159265, 6.2831853) - 3.14159265);
  float sweep = smoothstep(1.2 * px, 0.0, r * sin(arm)) * step(r, 0.34) * step(0.0, cos(arm));
  float trail = exp(-arm * 3.0) * step(r, 0.34) * 0.06;
  float dash = step(0.5, fract(ang / 6.2831853 * 120.0)) * smoothstep(1.0 * px, 0.0, abs(r - 0.28));
  col += tone(1) * (ring * 0.35 + ticks * 0.3 + sweep * 0.45 + dash * 0.18) + tone(0) * trail;
  float scan = fract(t * 0.035);
  float band = exp(-pow((p.y - mix(0.65, -0.65, scan)) * 9.0, 2.0));
  col += tone(0) * band * 0.05 * (0.5 + minor + major * 2.0);
  outColor = sceneColor(col);
}
`);

/** A neon horizon: a slatted sun over a ridge, a perspective grid racing toward it. */
const SYNTHWAVE = frag(`
void main() {
  vec2 p = centered();
  float t = uTime;
  float px = devicePx();
  float hz = -0.1;
  float sunMask = 0.0;
  vec3 sunColor = vec3(0.0);
  vec3 col;
  if (p.y > hz) {
    float k = p.y - hz;
    col = mix(mix(tone(0), tone(3), 0.45) * 0.9, tone(3), smoothstep(0.0, 0.55, k));
    col += vec3(0.9, 0.85, 1.0) * starLayer(p, 110.0, 0.3, t) * smoothstep(0.1, 0.4, k) * 0.7;
    vec2 s = p - vec2(0.0, hz + 0.2);
    float d = length(s);
    float rad = 0.23;
    vec3 sun = mix(tone(0), mix(tone(2), vec3(1.0, 0.93, 0.55), 0.35), smoothstep(-rad * 0.9, rad * 0.7, s.y));
    float y = (s.y + rad) / (2.0 * rad);
    float gap = mix(0.42, 0.0, smoothstep(0.0, 0.55, y));
    float slat = step(gap, fract(y * 14.0 + t * 0.12));
    float disc = smoothstep(rad + 1.5 * px, rad - 1.5 * px, d) * slat;
    col += tone(0) * 0.35 * exp(-max(d - rad, 0.0) * 6.0);
    sunMask = disc;
    sunColor = sun;
    float ridge = hz + 0.035 + 0.07 * fbm(vec2(p.x * 2.6 + 11.0, 1.0)) * smoothstep(0.0, 0.6, abs(p.x));
    float hill = smoothstep(ridge + px, ridge - px, p.y);
    vec3 rock = tone(3) * 0.7 + tone(1) * 0.08 * smoothstep(ridge - 0.05, ridge, p.y);
    col = mix(col, rock, hill);
    sunMask *= 1.0 - hill;
    col += tone(1) * 0.35 * smoothstep(2.0 * px, 0.0, abs(p.y - ridge));
  } else {
    float depth = 0.32 / max(hz - p.y, 1e-4);
    vec2 g = vec2(p.x * depth, depth + t * 0.9);
    vec2 w = fwidth(g);
    vec2 d = abs(fract(g - 0.5) - 0.5) / max(w, 1e-5);
    float line = 1.0 - min(min(d.x, d.y) / 1.4, 1.0);
    float fade = exp(-depth * 0.09);
    col = tone(3) * 0.8 + mix(tone(0), tone(3), 0.5) * 0.25 * exp(-depth * 0.4);
    vec3 ink = mix(tone(1), tone(0), smoothstep(1.0, 6.0, depth));
    col += ink * line * fade;
  }
  col += tone(0) * 0.45 * exp(-abs(p.y - hz) * 60.0);
  col = 1.0 - exp(-col * 1.3);
  col = mix(col, sunColor, sunMask);
  outColor = sceneColor(col);
}
`);

// ---- Overlays --------------------------------------------------------------------------------------

const CLEAR = frag(`
void main() { outColor = vec4(0.0); }
`);

export const THEME_FRAGMENT_SHADERS: Record<ThemeShader, string> = {
  aurora: AURORA,
  nebula: NEBULA,
  silk: SILK,
  grid: GRID,
  synthwave: SYNTHWAVE,
  starfield: CLEAR,
  fireflies: CLEAR,
  embers: CLEAR,
  caustics: CLEAR,
  petals: CLEAR,
  rain: CLEAR,
};
