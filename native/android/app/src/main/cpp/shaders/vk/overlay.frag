#version 450
// Density overlay: colours each fragment by its area in framebuffer pixels. gl_FragSizeEXT
// (GL_EXT_fragment_invocation_density, SPIR-V FragSizeEXT from VK_EXT_fragment_density_map) is
// the size the fragment density map actually gave this fragment.
#extension GL_EXT_multiview : require
#extension GL_EXT_fragment_invocation_density : require

layout(set = 0, binding = 0, std140) uniform Frame {
    mat4 viewProj[2];
    vec4 viewport;
    vec4 marker[2];
    vec4 rings;
    vec4 light;
}
frame;

layout(location = 0) out vec4 outColor;

void main() {
    ivec2 size = gl_FragSizeEXT;
    int area = size.x * size.y;
    vec3 color = area <= 1   ? vec3(0.0, 0.85, 0.1)
                 : area <= 2 ? vec3(0.95, 0.85, 0.0)
                 : area <= 4 ? vec3(1.0, 0.45, 0.0)
                 : area <= 8 ? vec3(0.9, 0.05, 0.05)
                             : vec3(0.85, 0.0, 0.85);
    float alpha = frame.viewport.z;
    // White cross where the applied offset puts the density map's centre (framebuffer pixels,
    // top-left origin, as gl_FragCoord).
    vec4 m = frame.marker[gl_ViewIndex];
    if (m.z > 0.5) {
        vec2 d = abs(gl_FragCoord.xy - m.xy);
        if ((d.x < 4.0 && d.y < 64.0) || (d.y < 4.0 && d.x < 64.0)) {
            color = vec3(1.0);
            alpha = 1.0;
        }
    }
    if (frame.viewport.w > 0.5)
        color = pow(color, vec3(1.0 / 2.2));
    outColor = vec4(color, alpha);
}
