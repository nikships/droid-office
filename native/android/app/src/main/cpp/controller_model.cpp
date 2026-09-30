#include "controller_model.h"
#include "json.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace office {
namespace {
using Json = nlohmann::json;
float number(const Json &value, float limit = 100) {
    const float f = value.get<float>();
    if (!std::isfinite(f) || std::abs(f) > limit)
        throw std::runtime_error("Invalid controller number");
    return f;
}
XrVector3f vector(const Json &value) {
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error("Invalid controller vector");
    return {number(value[0]), number(value[1]), number(value[2])};
}
ControllerPose pose(const Json &j) {
    ControllerPose p;
    p.position = vector(j.at("position"));
    p.scale = vector(j.at("scale"));
    const auto &q = j.at("rotation");
    if (!q.is_array() || q.size() != 4)
        throw std::runtime_error("Invalid controller rotation");
    p.rotation = {number(q[0], 1.01f), number(q[1], 1.01f), number(q[2], 1.01f),
                  number(q[3], 1.01f)};
    float n = std::sqrt(p.rotation.x * p.rotation.x + p.rotation.y * p.rotation.y +
                        p.rotation.z * p.rotation.z + p.rotation.w * p.rotation.w);
    if (n < .9f || n > 1.1f || p.scale.x <= 0 || p.scale.y <= 0 || p.scale.z <= 0)
        throw std::runtime_error("Invalid controller transform");
    p.rotation = {p.rotation.x / n, p.rotation.y / n, p.rotation.z / n, p.rotation.w / n};
    return p;
}
uint32_t u32(const uint8_t *p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
float response(ControllerChannel channel, const ControllerButtons &b) {
    switch (channel) {
    case ControllerChannel::Trigger:
        return std::clamp(b.trigger, 0.f, 1.f);
    case ControllerChannel::Squeeze:
        return std::clamp(b.squeeze, 0.f, 1.f);
    case ControllerChannel::StickClick:
        return b.stickClick ? 1.f : 0.f;
    case ControllerChannel::Primary:
        return b.primary ? 1.f : 0.f;
    case ControllerChannel::Secondary:
        return b.secondary ? 1.f : 0.f;
    case ControllerChannel::Menu:
        return b.menu ? 1.f : 0.f;
    case ControllerChannel::X:
        return .5f + b.x * .5f;
    case ControllerChannel::Y:
        return .5f + b.y * .5f;
    }
    return 0;
}
} // namespace

ControllerModel parseControllerModel(std::string_view metadata, const uint8_t *data, size_t size) {
    if (metadata.size() > 256 * 1024 || size < 16 || size > 2 * 1024 * 1024 || !data ||
        std::memcmp(data, "DXRC", 4) || u32(data + 4) != 1)
        throw std::runtime_error("Invalid controller asset header");
    const uint32_t vertexCount = u32(data + 8), indexCount = u32(data + 12);
    if (!vertexCount || vertexCount > 16384 || !indexCount || indexCount > 96000 ||
        size != 16 + size_t(vertexCount) * 32 + size_t(indexCount) * 2)
        throw std::runtime_error("Invalid controller geometry bounds");
    ControllerModel m;
    m.vertices.resize(size_t(vertexCount) * 8);
    std::memcpy(m.vertices.data(), data + 16, m.vertices.size() * sizeof(float));
    for (float f : m.vertices)
        if (!std::isfinite(f) || std::abs(f) > 100)
            throw std::runtime_error("Invalid controller geometry value");
    m.indices.resize(indexCount);
    const uint8_t *indices = data + 16 + size_t(vertexCount) * 32;
    for (uint32_t i = 0; i < indexCount; i++)
        m.indices[i] = uint16_t(indices[i * 2]) | uint16_t(indices[i * 2 + 1]) << 8;
    auto j = Json::parse(metadata, [](int depth, Json::parse_event_t, const Json &) {
        if (depth > 16)
            throw std::runtime_error("Controller metadata too deeply nested");
        return true;
    });
    if (j.at("version") != 1 || j.at("nodes").size() > 128 || j.at("nodes").empty() ||
        j.at("draws").size() > 32 || j.at("materials").size() > 8 || j.at("images").size() > 8 ||
        j.at("responses").size() > 16)
        throw std::runtime_error("Invalid controller metadata bounds");
    for (const auto &n : j.at("nodes")) {
        int parent = n.at("parent");
        if (parent < -1 || parent >= int(m.nodes.size()))
            throw std::runtime_error("Controller hierarchy is not ordered");
        m.nodes.push_back({pose(n), parent});
    }
    for (const auto &i : j.at("images")) {
        std::string file = i.at("file");
        if (file.size() > 80 || file.find('/') != std::string::npos ||
            file.find("..") != std::string::npos)
            throw std::runtime_error("Invalid controller image path");
        m.images.push_back(std::move(file));
    }
    for (const auto &v : j.at("materials")) {
        ControllerMaterial material;
        material.base = v.at("base");
        material.normal = v.at("normal");
        material.metallicRoughness = v.at("metallicRoughness");
        material.emissive = v.at("emissive");
        for (int id :
             {material.base, material.normal, material.metallicRoughness, material.emissive})
            if (id < -1 || id >= int(m.images.size()))
                throw std::runtime_error("Invalid controller material texture");
        const auto &color = v.at("color");
        if (!color.is_array() || color.size() != 4)
            throw std::runtime_error("Invalid controller material color");
        for (int c = 0; c < 4; c++)
            material.color[c] = number(color[c], 1.01f);
        material.emissiveFactor = vector(v.at("emissiveFactor"));
        material.metallic = std::clamp(number(v.at("metallic"), 1.01f), 0.f, 1.f);
        material.roughness = std::clamp(number(v.at("roughness"), 1.01f), 0.f, 1.f);
        material.transparent = v.at("transparent");
        material.doubleSided = v.at("doubleSided");
        m.materials.push_back(material);
    }
    for (const auto &d : j.at("draws")) {
        ControllerDraw draw{d.at("node"),        d.at("material"),   d.at("firstVertex"),
                            d.at("vertexCount"), d.at("firstIndex"), d.at("indexCount")};
        if (draw.node >= m.nodes.size() || draw.material >= m.materials.size() ||
            !draw.vertexCount || !draw.indexCount || draw.firstVertex > vertexCount ||
            draw.vertexCount > vertexCount - draw.firstVertex || draw.firstIndex > indexCount ||
            draw.indexCount > indexCount - draw.firstIndex || draw.indexCount % 3)
            throw std::runtime_error("Invalid controller draw bounds");
        for (uint32_t i = draw.firstIndex; i < draw.firstIndex + draw.indexCount; i++)
            if (m.indices[i] >= draw.vertexCount)
                throw std::runtime_error("Controller index exceeds draw vertices");
        m.draws.push_back(draw);
    }
    const std::array<std::string, 8> names{"trigger",   "squeeze", "stickClick", "primary",
                                           "secondary", "menu",    "stickX",     "stickY"};
    for (const auto &r : j.at("responses")) {
        std::string channel = r.at("channel");
        auto found = std::find(names.begin(), names.end(), channel);
        uint32_t node = r.at("node");
        if (found == names.end() || node >= m.nodes.size())
            throw std::runtime_error("Invalid controller response");
        m.responses.push_back(
            {node, ControllerChannel(found - names.begin()), pose(r.at("min")), pose(r.at("max"))});
    }
    return m;
}

ControllerPose interpolateControllerPose(const ControllerPose &a, const ControllerPose &b,
                                         float amount) {
    amount = std::clamp(amount, 0.f, 1.f);
    auto lerp = [amount](XrVector3f x, XrVector3f y) {
        return add(scale(x, 1 - amount), scale(y, amount));
    };
    auto q = b.rotation;
    float dot = a.rotation.x * q.x + a.rotation.y * q.y + a.rotation.z * q.z + a.rotation.w * q.w;
    if (dot < 0) {
        q = {-q.x, -q.y, -q.z, -q.w};
        dot = -dot;
    }
    float first = 1 - amount, second = amount;
    if (dot < .9995f) {
        float angle = std::acos(std::clamp(dot, -1.f, 1.f)), sine = std::sin(angle);
        first = std::sin((1 - amount) * angle) / sine;
        second = std::sin(amount * angle) / sine;
    }
    XrQuaternionf rotation{a.rotation.x * first + q.x * second, a.rotation.y * first + q.y * second,
                           a.rotation.z * first + q.z * second,
                           a.rotation.w * first + q.w * second};
    float length = std::sqrt(rotation.x * rotation.x + rotation.y * rotation.y +
                             rotation.z * rotation.z + rotation.w * rotation.w);
    rotation = {rotation.x / length, rotation.y / length, rotation.z / length, rotation.w / length};
    return {lerp(a.position, b.position), lerp(a.scale, b.scale), rotation};
}

void controllerTransforms(const ControllerModel &model, ControllerButtons buttons, Matrix *out,
                          size_t capacity) {
    if (!out || capacity < model.nodes.size() || model.nodes.size() > 128)
        throw std::runtime_error("Insufficient controller transform storage");
    const float radius = std::hypot(buttons.x, buttons.y);
    if (radius > 1) {
        buttons.x /= radius;
        buttons.y /= radius;
    }
    for (size_t i = 0; i < model.nodes.size(); i++) {
        ControllerPose p = model.nodes[i].pose;
        for (const auto &r : model.responses)
            if (r.node == i)
                p = interpolateControllerPose(r.min, r.max, response(r.channel, buttons));
        Matrix local = transform({p.rotation, p.position});
        for (int axis = 0; axis < 3; axis++) {
            float s = axis == 0 ? p.scale.x : axis == 1 ? p.scale.y : p.scale.z;
            for (int row = 0; row < 3; row++)
                local[axis * 4 + row] *= s;
        }
        out[i] = model.nodes[i].parent < 0 ? local : multiply(out[model.nodes[i].parent], local);
    }
}
} // namespace office
