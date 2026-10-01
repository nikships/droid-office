#version 450
layout(push_constant) uniform Input { mat4 model; vec4 color; vec4 mode; } inputState;
layout(location=0) out vec4 pixel;
void main() { pixel=vec4(0,0,0,inputState.mode.x); }
