// GL-free decoding for the native scene stream (src/client/native/wire.ts): base64, blob parts,
// images, and checked JSON field access. Every failure throws PacketError with a readable message.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace office::scene {

using json = nlohmann::json;

struct PacketError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

/** Standard base64 (padding optional). Throws on any character outside the alphabet. */
std::vector<uint8_t> decodeBase64(std::string_view s);
/** Appends decoded bytes to `out`. */
void decodeBase64Into(std::string_view s, std::vector<uint8_t> &out);

struct Limits {
    size_t maxBlobBytes = 256u << 20;  // all blobs being assembled at once
    size_t maxArrayBytes = 128u << 20; // one decoded binary array
    int maxTextureSize = 8192;
    uint32_t maxVertices = 8u << 20; // one geometry
    uint32_t maxInstances = 1u << 20;
    uint32_t maxObjects = 60000; // object table slots (uint16 in vertices)
    uint32_t maxMaterials = 60000;
};

/**
 * Blob parts (wire.BlobPart) collected until complete. Parts of one blob arrive in order; a
 * complete blob is taken exactly once by the item that references it.
 */
class BlobStore {
  public:
    explicit BlobStore(const Limits &limits) : limits_(limits) {}
    void add(const json &part);
    /** The decoded bytes of a Bin ({d} or {blob}). Throws if a blob is missing or incomplete. */
    std::vector<uint8_t> take(const json &bin);
    void clear() {
        blobs_.clear();
        bytes_ = 0;
    }
    size_t bytes() const { return bytes_; }
    size_t pending() const { return blobs_.size(); }

  private:
    struct Blob {
        uint32_t parts = 0, next = 0;
        size_t expected = 0;
        std::vector<uint8_t> data;
    };
    const Limits &limits_;
    std::map<uint64_t, Blob> blobs_;
    size_t bytes_ = 0;
};

/** Float32 array from bytes, checking the length is `count` floats. */
std::vector<float> asFloats(const std::vector<uint8_t> &bytes, size_t count, const char *what);

struct Image {
    int w = 0, h = 0;
    std::vector<uint8_t> rgba;
};

/**
 * Decodes 'png', 'jpeg' or 'rgba8' into RGBA8 rows bottom-up when flipY (as UNPACK_FLIP_Y_WEBGL),
 * premultiplied when asked. Checks the size against `w` x `h` from the packet.
 */
Image decodeImage(const std::string &fmt, const std::vector<uint8_t> &bytes, int w, int h,
                  bool flipY, bool premultiply, const Limits &limits);

// ---- Checked JSON access ----------------------------------------------------------------------

inline const json &field(const json &o, const char *key) {
    auto it = o.find(key);
    if (it == o.end())
        throw PacketError(std::string("missing field \"") + key + "\"");
    return *it;
}

inline double num(const json &o, const char *key, double fallback) {
    auto it = o.find(key);
    if (it == o.end() || it->is_null())
        return fallback;
    if (!it->is_number())
        throw PacketError(std::string("field \"") + key + "\" is not a number");
    return it->get<double>();
}

inline double num(const json &o, const char *key) {
    const json &v = field(o, key);
    if (!v.is_number())
        throw PacketError(std::string("field \"") + key + "\" is not a number");
    return v.get<double>();
}

inline uint32_t u32(const json &o, const char *key) {
    double v = num(o, key);
    if (v < 0 || v > 4294967295.0 || v != double(uint64_t(v)))
        throw PacketError(std::string("field \"") + key + "\" is not an unsigned integer");
    return uint32_t(v);
}

inline bool flag(const json &o, const char *key, bool fallback) {
    auto it = o.find(key);
    if (it == o.end() || it->is_null())
        return fallback;
    if (!it->is_boolean())
        throw PacketError(std::string("field \"") + key + "\" is not a boolean");
    return it->get<bool>();
}

inline std::string str(const json &o, const char *key, const char *fallback) {
    auto it = o.find(key);
    if (it == o.end() || it->is_null())
        return fallback;
    if (!it->is_string())
        throw PacketError(std::string("field \"") + key + "\" is not a string");
    return it->get<std::string>();
}

/** A fixed-length number array; `fallback` when absent. */
template <size_t N>
std::array<float, N> vecN(const json &o, const char *key, std::array<float, N> fallback) {
    auto it = o.find(key);
    if (it == o.end() || it->is_null())
        return fallback;
    if (!it->is_array() || it->size() != N)
        throw PacketError(std::string("field \"") + key + "\" is not an array of " +
                          std::to_string(N));
    std::array<float, N> out{};
    for (size_t i = 0; i < N; i++) {
        if (!(*it)[i].is_number())
            throw PacketError(std::string("field \"") + key + "\" has a non-number");
        out[i] = (*it)[i].get<float>();
    }
    return out;
}

/** A number array of any length up to `max`. */
std::vector<float> floatList(const json &o, const char *key, size_t max);
/** A list of unsigned integer ids. */
std::vector<uint32_t> idList(const json &o, const char *key, size_t max);

} // namespace office::scene
