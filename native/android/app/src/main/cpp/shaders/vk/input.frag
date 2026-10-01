#version 450
layout(location=0) in vec3 n;
layout(location=1) in vec3 ink;
layout(push_constant) uniform Input { mat4 model; vec4 color; vec4 mode; } inputState;
layout(location=0) out vec4 pixel;
void main() {
 if(inputState.mode.x>2.5) { pixel=vec4(0); return; }
 if(inputState.mode.x>1.5) { pixel=vec4(ink,1); return; }
 float diffuse=max(dot(normalize(n),normalize(vec3(.35,.8,.5))),0);
 pixel=vec4(inputState.color.rgb*(.5+.5*diffuse),1);
}
