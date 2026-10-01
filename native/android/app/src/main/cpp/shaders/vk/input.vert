#version 450
#extension GL_EXT_multiview : require
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in float unusedMaterial;
layout(set = 0, binding = 0, std140) uniform Frame {
    mat4 viewProj[2];
    vec4 viewport;
    vec4 marker[2];
    vec4 rings;
    vec4 light;
}
frame;
layout(push_constant) uniform Input { mat4 model; vec4 color; vec4 mode; } inputState;
layout(location=0) out vec3 n;
layout(location=1) out vec3 ink;
void main() {
 gl_Position=frame.viewProj[gl_ViewIndex]*inputState.model*vec4(position,1);
 gl_Position.z=(gl_Position.z+gl_Position.w)*.5;
 n=mat3(inputState.model)*normal;
 ink=normal;
}
