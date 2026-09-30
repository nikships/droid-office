#include "input_renderer.h"
#include <GLES2/gl2ext.h>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace office {
namespace {
XrVector3f cross(XrVector3f a, XrVector3f b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
float length(XrVector3f p) { return std::sqrt(p.x * p.x + p.y * p.y + p.z * p.z); }
XrVector3f unit(XrVector3f p) {
    float n = length(p);
    return n > .00001f ? scale(p, 1 / n) : XrVector3f{0, 1, 0};
}
GLuint shader(GLenum type, const std::string &code) {
    GLuint result = glCreateShader(type);
    const char *source = code.c_str();
    glShaderSource(result, 1, &source, nullptr);
    glCompileShader(result);
    GLint good = 0;
    glGetShaderiv(result, GL_COMPILE_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetShaderInfoLog(result, sizeof(log), nullptr, log);
        glDeleteShader(result);
        throw std::runtime_error(std::string("Input shader: ") + log);
    }
    return result;
}
GLuint link(const std::string &vertex, const std::string &fragment) {
    GLuint v = shader(GL_VERTEX_SHADER, vertex), f = shader(GL_FRAGMENT_SHADER, fragment),
           program = glCreateProgram();
    glAttachShader(program, v);
    glAttachShader(program, f);
    glLinkProgram(program);
    glDeleteShader(v);
    glDeleteShader(f);
    GLint good = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetProgramInfoLog(program, sizeof(log), nullptr, log);
        glDeleteProgram(program);
        throw std::runtime_error(std::string("Input program: ") + log);
    }
    return program;
}
} // namespace
InputRenderer::~InputRenderer() {
    if (program)
        glDeleteProgram(program);
    if (fadeProgram)
        glDeleteProgram(fadeProgram);
    if (vao)
        glDeleteVertexArrays(1, &vao);
    if (vbo)
        glDeleteBuffers(1, &vbo);
}
void InputRenderer::initialize(bool multiview, bool srgbFramebuffer, AAssetManager *assets) {
    stereo = multiview;
    controllers.initialize(multiview, srgbFramebuffer, assets);
    std::string prefix = "#version 300 es\n";
    if (stereo)
        prefix += "#extension GL_OVR_multiview2 : require\nlayout(num_views=2) in;\n";
    std::string view = stereo ? "int(gl_ViewID_OVR)" : "0";
    program = link(
        prefix +
            "precision highp float;\nlayout(location=0) in vec3 position;layout(location=1) in "
            "vec3 color;uniform mat4 pv[2];out vec3 tint;void main(){tint=color;gl_Position=pv[" +
            view + "]*vec4(position,1);}",
        "#version 300 es\nprecision mediump float;in vec3 tint;out vec4 pixel;void "
        "main(){pixel=vec4(tint,1);}");
    fadeProgram = link(prefix + "void main(){vec2 "
                                "p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_"
                                "Position=vec4(p*2.0-1.0,0,1);}",
                       "#version 300 es\nprecision mediump float;uniform float fade;out vec4 "
                       "pixel;void main(){pixel=vec4(0,0,0,fade);}");
    matrixUniform = glGetUniformLocation(program, "pv");
    fadeUniform = glGetUniformLocation(fadeProgram, "fade");
    glGenVertexArrays(1, &vao);
    glGenBuffers(1, &vbo);
    glBindVertexArray(vao);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex), nullptr);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                          reinterpret_cast<void *>(3 * sizeof(float)));
    glBindVertexArray(0);
    vertices.reserve(12000);
}
void InputRenderer::triangle(XrVector3f a, XrVector3f b, XrVector3f c, XrVector3f color) {
    for (auto p : {a, b, c})
        vertices.push_back({p.x, p.y, p.z, color.x, color.y, color.z});
}
void InputRenderer::sphere(XrVector3f p, float radius, XrVector3f color) {
    const XrVector3f ring[]{{radius, 0, 0}, {0, 0, radius}, {-radius, 0, 0}, {0, 0, -radius}};
    for (int i = 0; i < 4; i++) {
        auto a = add(p, ring[i]), b = add(p, ring[(i + 1) % 4]);
        triangle(add(p, {0, radius, 0}), b, a, color);
        triangle(add(p, {0, -radius, 0}), a, b, scale(color, .8f));
    }
}
void InputRenderer::bone(XrVector3f a, XrVector3f b, float radius, XrVector3f color) {
    auto direction = unit(subtract(b, a));
    auto u = unit(
        cross(direction, std::abs(direction.y) > .9f ? XrVector3f{1, 0, 0} : XrVector3f{0, 1, 0}));
    auto v = cross(direction, u);
    for (int i = 0; i < 6; i++) {
        float angle = i * 6.2831853f / 6, next = (i + 1) * 6.2831853f / 6;
        auto r = add(scale(u, std::cos(angle) * radius), scale(v, std::sin(angle) * radius));
        auto s = add(scale(u, std::cos(next) * radius), scale(v, std::sin(next) * radius));
        auto tint = scale(color, .75f + .25f * std::abs(std::sin(angle)));
        triangle(add(a, r), add(b, r), add(a, s), tint);
        triangle(add(a, s), add(b, r), add(b, s), tint);
    }
}
void InputRenderer::update(const InputFrame &frame, const ControlState &state, XrPosef panel,
                           bool panelVisible) {
    vertices.clear();
    controllers.update(frame);
    auto fromWorld = inverseRigid(state.rig);
    for (int h = 0; h < 2; h++) {
        const auto &hand = frame.hands[h];
        if (!hand.active || state.hands[h].holding)
            continue;
        auto start = hand.aim.position;
        auto end = add(start, rotate(hand.aim.orientation, {0, 0, -1.5f}));
        float x = 0, y = 0, distance = 0;
        bool hit = panelVisible && panelHit(hand.aim, panel, 1.8f, 1.2f, x, y, distance);
        if (hit)
            end = add(start, rotate(hand.aim.orientation, {0, 0, -distance}));
        else if (state.hands[h].valid)
            end = transformPoint(fromWorld, state.hands[h].point);
        XrVector3f rayColor = hit                   ? XrVector3f{.65f, .85f, 1}
                              : state.hands[h].near ? XrVector3f{.22f, 1, .35f}
                                                    : XrVector3f{.3f, .8f, 1};
        bone(start, end, .0015f, rayColor);
        if (hit || state.hands[h].valid)
            sphere(end, .007f, rayColor);
    }
    if (!state.arc.empty()) {
        XrVector3f color =
            state.teleportValid ? XrVector3f{.22f, 1, .35f} : XrVector3f{1, .2f, .2f};
        for (size_t i = 1; i < state.arc.size(); i++)
            bone(transformPoint(fromWorld, state.arc[i - 1]),
                 transformPoint(fromWorld, state.arc[i]), .004f, color);
        auto marker = transformPoint(fromWorld, state.marker);
        for (int i = 0; i < 24; i++) {
            float a = i * 6.2831853f / 24, b = (i + 1) * 6.2831853f / 24;
            bone(add(marker, {std::cos(a) * .18f, .012f, std::sin(a) * .18f}),
                 add(marker, {std::cos(b) * .18f, .012f, std::sin(b) * .18f}), .008f, color);
        }
    }
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(),
                 GL_STREAM_DRAW);
}
void InputRenderer::render(const Matrix &left, const Matrix &right, float fade) {
    controllers.render(left, right);
    glBindVertexArray(vao);
    glDisable(GL_CULL_FACE);
    glEnable(GL_DEPTH_TEST);
    glDepthMask(GL_FALSE);
    glDisable(GL_BLEND);
    glUseProgram(program);
    std::array<Matrix, 2> matrices{left, right};
    glUniformMatrix4fv(matrixUniform, stereo ? 2 : 1, GL_FALSE, matrices[0].data());
    if (!vertices.empty())
        glDrawArrays(GL_TRIANGLES, 0, vertices.size());
    if (fade > .001f) {
        glDisable(GL_DEPTH_TEST);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glUseProgram(fadeProgram);
        glUniform1f(fadeUniform, std::clamp(fade, 0.f, 1.f));
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    glBindVertexArray(0);
    glDepthMask(GL_TRUE);
    glDisable(GL_BLEND);
}
} // namespace office
