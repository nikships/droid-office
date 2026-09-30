#include "hand_renderer.h"
#include <android/log.h>
#include <cstddef>
#include <stdexcept>
#include <string>

namespace office {
namespace {
struct Vertex {
    XrVector3f position, normal;
    XrVector4sFB joints;
    XrVector4f weights;
};
GLuint compileHand(GLenum type, const std::string &source) {
    GLuint s = glCreateShader(type);
    const char *p = source.c_str();
    glShaderSource(s, 1, &p, nullptr);
    glCompileShader(s);
    GLint good = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetShaderInfoLog(s, sizeof(log), nullptr, log);
        glDeleteShader(s);
        throw std::runtime_error(std::string("Hand shader: ") + log);
    }
    return s;
}
} // namespace
HandRenderer::~HandRenderer() {
    for (auto &h : hands) {
        if (h.vao)
            glDeleteVertexArrays(1, &h.vao);
        if (h.vbo)
            glDeleteBuffers(1, &h.vbo);
        if (h.ebo)
            glDeleteBuffers(1, &h.ebo);
    }
    if (program)
        glDeleteProgram(program);
}
void HandRenderer::initialize(bool multiview, bool srgbFramebuffer,
                              const std::array<HandMesh, 2> &meshes) {
    stereo = multiview;
    if (meshes[0].positions.empty() && meshes[1].positions.empty())
        return;
    std::string prefix = "#version 300 es\n";
    if (stereo)
        prefix += "#extension GL_OVR_multiview2 : require\nlayout(num_views=2) in;\n";
    auto v = compileHand(
        GL_VERTEX_SHADER,
        prefix +
            "precision highp float;precision highp int;layout(location=0) in vec3 position;"
            "layout(location=1) in vec3 normal;layout(location=2) in ivec4 joints;"
            "layout(location=3) in vec4 weights;uniform mat4 pv[2];uniform mat4 bones[26];"
            "out vec3 n;void main(){mat4 skin=bones[joints.x]*weights.x+bones[joints.y]*weights.y+"
            "bones[joints.z]*weights.z+bones[joints.w]*weights.w;n=mat3(skin)*normal;"
            "gl_Position=pv[" +
            (stereo ? std::string("int(gl_ViewID_OVR)") : std::string("0")) +
            "]*skin*vec4(position,1);}");
    std::string output =
        srgbFramebuffer
            ? "linear"
            : "mix(linear*12.92,1.055*pow(linear,vec3(1.0/2.4))-.055,step(vec3(.0031308),linear))";
    auto f = compileHand(GL_FRAGMENT_SHADER,
                         "#version 300 es\nprecision highp float;in vec3 n;"
                         "uniform vec3 color;out vec4 pixel;void main(){vec3 normal=normalize(n);"
                         "float light=.55+.35*max(dot(normal,normalize(vec3(-.4,.8,.5))),0.0);"
                         "vec3 linear=color*light;pixel=vec4(" +
                             output + ",1);}");
    program = glCreateProgram();
    glAttachShader(program, v);
    glAttachShader(program, f);
    glLinkProgram(program);
    glDeleteShader(v);
    glDeleteShader(f);
    GLint good = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &good);
    if (!good)
        throw std::runtime_error("Hand mesh program did not link");
    pvLocation = glGetUniformLocation(program, "pv");
    bonesLocation = glGetUniformLocation(program, "bones");
    colorLocation = glGetUniformLocation(program, "color");
    for (int side = 0; side < 2; side++) {
        auto &h = hands[side];
        h.mesh = meshes[side];
        if (h.mesh.positions.empty())
            continue;
        std::vector<Vertex> vertices;
        vertices.reserve(h.mesh.positions.size());
        for (size_t i = 0; i < h.mesh.positions.size(); i++)
            vertices.push_back(
                {h.mesh.positions[i], h.mesh.normals[i], h.mesh.joints[i], h.mesh.weights[i]});
        h.count = h.mesh.indices.size();
        glGenVertexArrays(1, &h.vao);
        glBindVertexArray(h.vao);
        glGenBuffers(1, &h.vbo);
        glBindBuffer(GL_ARRAY_BUFFER, h.vbo);
        glBufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(),
                     GL_STATIC_DRAW);
        glGenBuffers(1, &h.ebo);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, h.ebo);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, h.mesh.indices.size() * sizeof(int16_t),
                     h.mesh.indices.data(), GL_STATIC_DRAW);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void *>(offsetof(Vertex, position)));
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void *>(offsetof(Vertex, normal)));
        glEnableVertexAttribArray(2);
        glVertexAttribIPointer(2, 4, GL_SHORT, sizeof(Vertex),
                               reinterpret_cast<void *>(offsetof(Vertex, joints)));
        glEnableVertexAttribArray(3);
        glVertexAttribPointer(3, 4, GL_FLOAT, GL_FALSE, sizeof(Vertex),
                              reinterpret_cast<void *>(offsetof(Vertex, weights)));
        __android_log_print(ANDROID_LOG_INFO, "OfficeXR",
                            "HAND_MESH_GPU %d vertices=%zu triangles=%d", side, vertices.size(),
                            h.count / 3);
    }
    glBindVertexArray(0);
}
void HandRenderer::update(const InputFrame &frame) {
    for (int i = 0; i < 2; i++) {
        auto &h = hands[i];
        const auto &input = frame.hands[i];
        h.visible = h.vao && input.active && input.hand && input.jointsValid &&
                    handSkinMatrices(h.mesh, input.joints, h.bones);
    }
}
void HandRenderer::render(const Matrix &left, const Matrix &right) {
    if (!program)
        return;
    glUseProgram(program);
    std::array<Matrix, 2> pv{left, right};
    glUniformMatrix4fv(pvLocation, stereo ? 2 : 1, GL_FALSE, pv[0].data());
    glDisable(GL_CULL_FACE);
    glEnable(GL_DEPTH_TEST);
    glDepthMask(GL_TRUE);
    glDisable(GL_BLEND);
    for (int i = 0; i < 2; i++) {
        const auto &h = hands[i];
        if (!h.visible)
            continue;
        glUniformMatrix4fv(bonesLocation, h.bones.size(), GL_FALSE, h.bones[0].data());
        glUniform3f(colorLocation, i ? .55f : .25f, i ? .37f : .48f, i ? .20f : .65f);
        glBindVertexArray(h.vao);
        glDrawElements(GL_TRIANGLES, h.count, GL_UNSIGNED_SHORT, nullptr);
    }
    glBindVertexArray(0);
}
} // namespace office
