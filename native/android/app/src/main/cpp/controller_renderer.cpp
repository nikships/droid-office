#include "controller_renderer.h"
#include <GLES2/gl2ext.h>
#include <android/log.h>
#include <cstring>
#include <stb_image.h>
#include <stdexcept>

namespace office {
namespace {
constexpr const char *directory = "controllers/samsung-galaxyxr/";
std::vector<uint8_t> asset(AAssetManager *manager, const std::string &name, size_t maximum) {
    AAsset *file =
        AAssetManager_open(manager, (std::string(directory) + name).c_str(), AASSET_MODE_BUFFER);
    if (!file)
        throw std::runtime_error("Missing Samsung controller asset: " + name);
    const auto size = AAsset_getLength64(file);
    if (size <= 0 || static_cast<uint64_t>(size) > maximum) {
        AAsset_close(file);
        throw std::runtime_error("Samsung controller asset exceeds bounds");
    }
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    size_t offset = 0;
    while (offset < bytes.size()) {
        const int read = AAsset_read(file, bytes.data() + offset, bytes.size() - offset);
        if (read <= 0) {
            AAsset_close(file);
            throw std::runtime_error("Unable to read Samsung controller asset");
        }
        offset += read;
    }
    AAsset_close(file);
    return bytes;
}
GLuint shader(GLenum type, const std::string &source) {
    GLuint id = glCreateShader(type);
    const char *text = source.c_str();
    glShaderSource(id, 1, &text, nullptr);
    glCompileShader(id);
    GLint good = 0;
    glGetShaderiv(id, GL_COMPILE_STATUS, &good);
    if (!good) {
        char message[2048]{};
        glGetShaderInfoLog(id, sizeof(message), nullptr, message);
        glDeleteShader(id);
        throw std::runtime_error(std::string("Samsung controller shader: ") + message);
    }
    return id;
}
} // namespace
ControllerRenderer::~ControllerRenderer() {
    for (auto &model : models) {
        glDeleteVertexArrays(model.arrays.size(), model.arrays.data());
        glDeleteBuffers(1, &model.vertices);
        glDeleteBuffers(1, &model.indices);
    }
    for (const auto &entry : textures)
        glDeleteTextures(1, &entry.second);
    if (program)
        glDeleteProgram(program);
}
void ControllerRenderer::initialize(bool multiview, bool srgbFramebuffer, AAssetManager *manager) {
    if (!manager)
        throw std::runtime_error("Samsung controller asset manager unavailable");
    stereo = multiview;
    std::string prefix = "#version 300 es\n";
    if (stereo)
        prefix += "#extension GL_OVR_multiview2 : require\nlayout(num_views=2) in;\n";
    const std::string view = stereo ? "int(gl_ViewID_OVR)" : "0";
    const GLuint vertex = shader(GL_VERTEX_SHADER, prefix + R"(
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv;
uniform mat4 pv[2]; uniform mat4 model;
out vec3 world; out vec3 n; out vec2 texcoord;
void main(){ vec4 p=model*vec4(position,1); world=p.xyz;
n=normalize(transpose(inverse(mat3(model)))*normal); texcoord=uv;
gl_Position=pv[)" + view + "]*p;}");
    const GLuint fragment = shader(GL_FRAGMENT_SHADER, std::string(R"(#version 300 es
precision highp float;
in vec3 world; in vec3 n; in vec2 texcoord;
uniform sampler2D baseMap, normalMap, mrMap, emissiveMap;
uniform vec4 color; uniform vec3 emissiveFactor, head;
uniform float metal, rough; uniform ivec4 maps; uniform float solid;
out vec4 pixel;
vec3 encode(vec3 v){return mix(v*12.92,1.055*pow(max(v,vec3(0)),vec3(1.0/2.4))-.055,step(vec3(.0031308),v));}
void main(){
vec4 c=color; if(maps.x>0)c*=texture(baseMap,texcoord);
if(c.a<.01)discard;
vec3 N=normalize(n); if(!gl_FrontFacing)N=-N;
if(maps.y>0){
vec3 q1=dFdx(world),q2=dFdy(world);vec2 t1=dFdx(texcoord),t2=dFdy(texcoord);
vec3 T=q1*t2.y-q2*t1.y,B=-q1*t2.x+q2*t1.x;
float inv=inversesqrt(max(max(dot(T,T),dot(B,B)),1e-12));
N=normalize(mat3(T*inv,B*inv,N)*(texture(normalMap,texcoord).xyz*2.0-1.0));}
float m=metal,r=rough;if(maps.z>0){vec4 mr=texture(mrMap,texcoord);m*=mr.b;r*=mr.g;}
vec3 L=normalize(vec3(.35,.8,.5)),V=normalize(head-world),H=normalize(L+V);
float diffuse=max(dot(N,L),0.0),spec=pow(max(dot(N,H),0.0),mix(100.0,4.0,clamp(r,0.0,1.0)));
vec3 rgb=c.rgb*(.5+.5*diffuse)*(1.0-.35*m)+mix(vec3(.04),c.rgb,m)*spec*.45;
vec3 emission=emissiveFactor;if(maps.w>0)emission*=texture(emissiveMap,texcoord).rgb;
rgb+=emission;
)") + (srgbFramebuffer ? "pixel=vec4(rgb,max(c.a,solid));}"
                       : "pixel=vec4(encode(rgb),max(c.a,solid));}"));
    // `solid`: opaque parts are opaque in the world layer's alpha too. Over the workspace panel's
    // hole (panel_cutout.h) the compositor shows the panel wherever alpha is below 1.
    program = glCreateProgram();
    glAttachShader(program, vertex);
    glAttachShader(program, fragment);
    glLinkProgram(program);
    glDeleteShader(vertex);
    glDeleteShader(fragment);
    GLint good = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &good);
    if (!good)
        throw std::runtime_error("Samsung controller program failed to link");
    viewLocation = glGetUniformLocation(program, "pv");
    modelLocation = glGetUniformLocation(program, "model");
    headLocation = glGetUniformLocation(program, "head");
    colorLocation = glGetUniformLocation(program, "color");
    emissiveLocation = glGetUniformLocation(program, "emissiveFactor");
    metalLocation = glGetUniformLocation(program, "metal");
    roughLocation = glGetUniformLocation(program, "rough");
    mapsLocation = glGetUniformLocation(program, "maps");
    solidLocation = glGetUniformLocation(program, "solid");
    glUseProgram(program);
    const char *samplers[]{"baseMap", "normalMap", "mrMap", "emissiveMap"};
    for (int i = 0; i < 4; i++)
        glUniform1i(glGetUniformLocation(program, samplers[i]), i);
    for (int h = 0; h < 2; h++) {
        auto &model = models[h];
        const std::string name = h ? "right" : "left";
        const auto meta = asset(manager, name + ".json", 256 * 1024);
        const auto geometry = asset(manager, name + ".bin", 2 * 1024 * 1024);
        model.data = parseControllerModel(
            std::string_view(reinterpret_cast<const char *>(meta.data()), meta.size()),
            geometry.data(), geometry.size());
        glGenBuffers(1, &model.vertices);
        glGenBuffers(1, &model.indices);
        glBindBuffer(GL_ARRAY_BUFFER, model.vertices);
        glBufferData(GL_ARRAY_BUFFER, model.data.vertices.size() * sizeof(float),
                     model.data.vertices.data(), GL_STATIC_DRAW);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, model.indices);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, model.data.indices.size() * sizeof(uint16_t),
                     model.data.indices.data(), GL_STATIC_DRAW);
        for (const auto &draw : model.data.draws) {
            GLuint vao;
            glGenVertexArrays(1, &vao);
            model.arrays.push_back(vao);
            glBindVertexArray(vao);
            glBindBuffer(GL_ARRAY_BUFFER, model.vertices);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, model.indices);
            const size_t offset = draw.firstVertex * 8 * sizeof(float);
            for (int a = 0; a < 3; a++) {
                glEnableVertexAttribArray(a);
                glVertexAttribPointer(a, a == 2 ? 2 : 3, GL_FLOAT, GL_FALSE, 8 * sizeof(float),
                                      reinterpret_cast<void *>(offset + (a == 0   ? 0
                                                                         : a == 1 ? 3
                                                                                  : 6) *
                                                                            sizeof(float)));
            }
        }
        for (size_t i = 0; i < model.data.images.size(); i++) {
            bool srgb = false;
            for (const auto &material : model.data.materials)
                srgb = srgb || material.base == static_cast<int>(i) ||
                       material.emissive == static_cast<int>(i);
            const auto &file = model.data.images[i];
            const auto key = file + (srgb ? ":srgb" : ":linear");
            auto found = textures.find(key);
            if (found == textures.end()) {
                const auto bytes = asset(manager, file, 16 * 1024 * 1024);
                int width, height, channels;
                if (!stbi_info_from_memory(bytes.data(), bytes.size(), &width, &height,
                                           &channels) ||
                    width <= 0 || height <= 0 || width > 2048 || height > 2048)
                    throw std::runtime_error("Samsung controller image dimensions invalid");
                uint8_t *pixels = stbi_load_from_memory(bytes.data(), bytes.size(), &width, &height,
                                                        &channels, 4);
                if (!pixels)
                    throw std::runtime_error("Samsung controller image decode failed");
                GLuint texture;
                glGenTextures(1, &texture);
                glBindTexture(GL_TEXTURE_2D, texture);
                glTexImage2D(GL_TEXTURE_2D, 0, srgb ? GL_SRGB8_ALPHA8 : GL_RGBA8, width, height, 0,
                             GL_RGBA, GL_UNSIGNED_BYTE, pixels);
                stbi_image_free(pixels);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                glGenerateMipmap(GL_TEXTURE_2D);
                found = textures.emplace(key, texture).first;
            }
            model.textures.push_back(found->second);
        }
        __android_log_print(ANDROID_LOG_INFO, "OfficeXR",
                            "SAMSUNG_CONTROLLER hand=%d vertices=%zu triangles=%zu draws=%zu", h,
                            model.data.vertices.size() / 8, model.data.indices.size() / 3,
                            model.data.draws.size());
    }
    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    glUseProgram(0);
}
void ControllerRenderer::update(const InputFrame &frame) {
    head = frame.head.position;
    hidden = 0;
    for (int h = 0; h < 2; h++) {
        auto &model = models[h];
        const auto &hand = frame.hands[h];
        model.active = hand.active && hand.gripTracked;
        if (!model.active)
            continue;
        model.grip = transform(hand.grip);
        controllerTransforms(model.data,
                             {hand.trigger, hand.squeeze, hand.stick.x, -hand.stick.y,
                              hand.stickClick, hand.primary, hand.secondary, hand.menu},
                             model.nodes.data(), model.nodes.size());
    }
}
void ControllerRenderer::render(const Matrix &left, const Matrix &right) {
    glUseProgram(program);
    const std::array<Matrix, 2> views{left, right};
    glUniformMatrix4fv(viewLocation, stereo ? 2 : 1, GL_FALSE, views[0].data());
    glUniform3f(headLocation, head.x, head.y, head.z);
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_LEQUAL);
    for (int h = 0; h < 2; h++) {
        const auto &model = models[size_t(h)];
        if (!model.active || (hidden & (1u << h)))
            continue;
        for (int transparent = 0; transparent < 2; transparent++) {
            glDepthMask(transparent ? GL_FALSE : GL_TRUE);
            glUniform1f(solidLocation, transparent ? 0.f : 1.f);
            if (transparent) {
                glEnable(GL_BLEND);
                // Alpha as coverage: premultiplied over the panel's hole, still 1 over the world.
                glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE,
                                    GL_ONE_MINUS_SRC_ALPHA);
            } else
                glDisable(GL_BLEND);
            for (size_t i = 0; i < model.data.draws.size(); i++) {
                const auto &draw = model.data.draws[i];
                const auto &material = model.data.materials[draw.material];
                if (material.transparent != static_cast<bool>(transparent))
                    continue;
                if (material.doubleSided)
                    glDisable(GL_CULL_FACE);
                else {
                    glEnable(GL_CULL_FACE);
                    glCullFace(GL_BACK);
                    glFrontFace(GL_CCW);
                }
                const auto matrix = multiply(model.grip, model.nodes[draw.node]);
                glUniformMatrix4fv(modelLocation, 1, GL_FALSE, matrix.data());
                glUniform4fv(colorLocation, 1, material.color.data());
                glUniform3f(emissiveLocation, material.emissiveFactor.x, material.emissiveFactor.y,
                            material.emissiveFactor.z);
                glUniform1f(metalLocation, material.metallic);
                glUniform1f(roughLocation, material.roughness);
                const int maps[]{material.base, material.normal, material.metallicRoughness,
                                 material.emissive};
                glUniform4i(mapsLocation, maps[0] >= 0, maps[1] >= 0, maps[2] >= 0, maps[3] >= 0);
                for (int t = 0; t < 4; t++) {
                    glActiveTexture(GL_TEXTURE0 + t);
                    glBindTexture(GL_TEXTURE_2D, maps[t] < 0 ? 0 : model.textures[maps[t]]);
                }
                glBindVertexArray(model.arrays[i]);
                glDrawElements(GL_TRIANGLES, draw.indexCount, GL_UNSIGNED_SHORT,
                               reinterpret_cast<void *>(draw.firstIndex * sizeof(uint16_t)));
            }
        }
    }
    glBindVertexArray(0);
    glUseProgram(0);
    glActiveTexture(GL_TEXTURE0);
    glDepthMask(GL_TRUE);
    glDisable(GL_BLEND);
    glDisable(GL_CULL_FACE);
}
} // namespace office
