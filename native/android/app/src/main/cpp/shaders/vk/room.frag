#version 450
// Procedural patterns whose detail shows the shading density: 2 cm checkers, 1 cm stripes and
// 1.5 cm rings blur or block where the fragment density map lowers the resolution.

layout(location = 0) in vec3 worldPosition;
layout(location = 1) in vec3 worldNormal;
layout(location = 2) flat in int material;

layout(set = 0, binding = 0, std140) uniform Frame {
    mat4 viewProj[2];
    vec4 viewport;
    vec4 marker[2];
    vec4 rings;
    vec4 light;
}
frame;

layout(location = 0) out vec4 outColor;

// Antialiased square wave in [0, 1]; fwidth grows with the fragment size, so coarse fragments
// blur the pattern instead of shimmering.
float wave(float v, float period) {
    float w = max(fwidth(v) / period, 1e-4);
    float x = v / period;
    float a = clamp((abs(fract(x) - 0.5) - 0.25) / w + 0.5, 0.0, 1.0);
    return a;
}
float checker(vec2 p, float size) {
    float a = wave(p.x, size * 2.0), b = wave(p.y, size * 2.0);
    return a * b + (1.0 - a) * (1.0 - b);
}
float ring(vec2 p, float radius, float width) {
    float d = abs(length(p) - radius);
    float w = max(fwidth(d), 1e-4);
    return 1.0 - clamp((d - width * 0.5) / w + 0.5, 0.0, 1.0);
}

void main() {
    vec3 n = normalize(worldNormal);
    vec3 p = worldPosition;
    vec3 color;
    if (material == 0) {
        // Floor: 0.5 m tiles, the light ones carrying a 2 cm checker.
        float tile = checker(p.xz, 0.5);
        float fine = checker(p.xz, 0.02);
        color = mix(vec3(0.05), mix(vec3(0.35), vec3(0.8), fine), tile);
    } else if (material == 1) {
        // Walls: 1 m panels cycling 2 cm checker, 1 cm horizontal and 1 cm vertical stripes.
        float u = abs(n.z) > 0.5 ? p.x : p.z;
        int panel = int(mod(floor(u + 100.0), 3.0));
        float v = panel == 0 ? checker(vec2(u, p.y), 0.02)
                  : panel == 1 ? wave(p.y, 0.02)
                               : wave(u, 0.02);
        color = mix(vec3(0.08, 0.1, 0.16), vec3(0.85, 0.85, 0.8), v);
        // Front wall: rings at 10, 20 and 30 degrees from the start position's view axis.
        if (n.z > 0.5) {
            vec2 q = p.xy - frame.rings.xy;
            float d = frame.rings.w;
            color = mix(color, vec3(1.0, 0.1, 0.1), ring(q, d * tan(radians(10.0)), 0.015));
            color = mix(color, vec3(0.1, 1.0, 0.2), ring(q, d * tan(radians(20.0)), 0.015));
            color = mix(color, vec3(0.2, 0.4, 1.0), ring(q, d * tan(radians(30.0)), 0.015));
        }
    } else if (material == 2) {
        color = mix(vec3(0.12), vec3(0.3), checker(p.xz, 0.25));
    } else {
        // Cubes at 1, 2 and 4 m: tinted 1 cm checkers.
        vec3 tint = material == 3 ? vec3(0.9, 0.35, 0.2)
                    : material == 4 ? vec3(0.25, 0.75, 0.35)
                                    : vec3(0.3, 0.45, 0.95);
        float axis = abs(n.x) > 0.5 ? 0.0 : 1.0;
        vec2 face = abs(n.y) > 0.5 ? p.xz : (axis > 0.5 ? p.xy : p.zy);
        color = tint * mix(0.45, 1.0, checker(face, 0.01));
    }
    float lit = frame.light.w + (1.0 - frame.light.w) * max(dot(n, normalize(frame.light.xyz)), 0.0);
    color *= lit;
    if (frame.viewport.w > 0.5)
        color = mix(color * 12.92, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, color));
    outColor = vec4(color, 1.0);
}
