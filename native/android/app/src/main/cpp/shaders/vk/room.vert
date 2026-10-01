#version 450
// Vulkan foveation spike: the world-locked test room, drawn to both eyes in one multiview
// subpass (viewMask 0b11). GL_EXT_multiview gl_ViewIndex picks the eye.
#extension GL_EXT_multiview : require

layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
layout(location = 2) in float inMaterial;

// Must match office::spike::FrameUniforms in vk_spike_gpu.h (std140, 208 bytes).
layout(set = 0, binding = 0, std140) uniform Frame {
    mat4 viewProj[2];
    vec4 viewport; // width, height, overlay alpha, 1 = encode sRGB in the shader
    vec4 marker[2]; // per eye: framebuffer pixel x, y; z > 0.5 draws the cross
    vec4 rings;    // ring centre xyz (world), wall distance
    vec4 light;    // direction xyz, ambient
}
frame;

layout(location = 0) out vec3 worldPosition;
layout(location = 1) out vec3 worldNormal;
layout(location = 2) flat out int material;

void main() {
    worldPosition = inPosition;
    worldNormal = inNormal;
    material = int(inMaterial + 0.5);
    gl_Position = frame.viewProj[gl_ViewIndex] * vec4(inPosition, 1.0);
    // The CPU matrices use GL clip depth (-w..w); Vulkan keeps 0..w. The stored depth then equals
    // GL's window depth (vulkan-port.md 4.3).
    gl_Position.z = (gl_Position.z + gl_Position.w) * 0.5;
}
