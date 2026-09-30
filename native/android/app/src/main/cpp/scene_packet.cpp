#include "scene_packet.h"

#include <array>
#include <cstring>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_FAILURE_USERMSG
#include "stb_image.h"

namespace office::scene {

namespace {
constexpr std::array<int8_t, 256> makeTable() {
    std::array<int8_t, 256> t{};
    for (auto &v : t)
        v = -1;
    const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++)
        t[uint8_t(a[i])] = int8_t(i);
    return t;
}
constexpr auto kTable = makeTable();
} // namespace

void decodeBase64Into(std::string_view s, std::vector<uint8_t> &out) {
    while (!s.empty() && s.back() == '=')
        s.remove_suffix(1);
    if (s.size() % 4 == 1)
        throw PacketError("base64 has a bad length");
    size_t start = out.size();
    out.resize(start + s.size() * 3 / 4);
    uint8_t *o = out.data() + start;
    size_t i = 0;
    for (; i + 4 <= s.size(); i += 4) {
        int a = kTable[uint8_t(s[i])], b = kTable[uint8_t(s[i + 1])], c = kTable[uint8_t(s[i + 2])],
            d = kTable[uint8_t(s[i + 3])];
        if ((a | b | c | d) < 0)
            throw PacketError("base64 has a bad character");
        uint32_t n = uint32_t(a) << 18 | uint32_t(b) << 12 | uint32_t(c) << 6 | uint32_t(d);
        *o++ = uint8_t(n >> 16);
        *o++ = uint8_t(n >> 8);
        *o++ = uint8_t(n);
    }
    size_t rest = s.size() - i;
    if (rest) {
        int a = kTable[uint8_t(s[i])], b = kTable[uint8_t(s[i + 1])],
            c = rest > 2 ? kTable[uint8_t(s[i + 2])] : 0;
        if ((a | b | c) < 0)
            throw PacketError("base64 has a bad character");
        uint32_t n = uint32_t(a) << 18 | uint32_t(b) << 12 | uint32_t(c) << 6;
        *o++ = uint8_t(n >> 16);
        if (rest > 2)
            *o++ = uint8_t(n >> 8);
    }
}

std::vector<uint8_t> decodeBase64(std::string_view s) {
    std::vector<uint8_t> out;
    decodeBase64Into(s, out);
    return out;
}

void BlobStore::add(const json &part) {
    uint64_t id = u32(part, "id");
    uint32_t index = u32(part, "part"), parts = u32(part, "parts");
    size_t bytes = u32(part, "bytes");
    const json &d = field(part, "d");
    if (!d.is_string())
        throw PacketError("blob part data is not a string");
    if (parts == 0 || index >= parts)
        throw PacketError("blob part index out of range");
    if (bytes > limits_.maxArrayBytes)
        throw PacketError("blob larger than the array limit");
    auto &blob = blobs_[id];
    if (index == 0) {
        bytes_ -= blob.data.size();
        blob = Blob{parts, 0, bytes, {}};
        blob.data.reserve(bytes);
    }
    if (blob.parts != parts || blob.next != index || blob.expected != bytes) {
        blobs_.erase(id);
        throw PacketError("blob " + std::to_string(id) + " part " + std::to_string(index) +
                          " out of order");
    }
    size_t before = blob.data.size();
    decodeBase64Into(d.get_ref<const std::string &>(), blob.data);
    bytes_ += blob.data.size() - before;
    blob.next++;
    if (blob.data.size() > blob.expected ||
        (blob.next == blob.parts && blob.data.size() != blob.expected)) {
        bytes_ -= blob.data.size();
        blobs_.erase(id);
        throw PacketError("blob " + std::to_string(id) + " has the wrong size");
    }
    if (bytes_ > limits_.maxBlobBytes)
        throw PacketError("blobs over the memory limit");
}

std::vector<uint8_t> BlobStore::take(const json &bin) {
    if (!bin.is_object())
        throw PacketError("binary field is not an object");
    auto d = bin.find("d");
    if (d != bin.end()) {
        if (!d->is_string())
            throw PacketError("inline binary is not a string");
        const auto &s = d->get_ref<const std::string &>();
        if (s.size() / 4 * 3 > limits_.maxArrayBytes)
            throw PacketError("inline binary over the array limit");
        return decodeBase64(s);
    }
    uint64_t id = u32(bin, "blob");
    auto it = blobs_.find(id);
    if (it == blobs_.end() || it->second.next != it->second.parts)
        throw PacketError("blob " + std::to_string(id) + " is missing or incomplete");
    std::vector<uint8_t> out = std::move(it->second.data);
    bytes_ -= out.size();
    blobs_.erase(it);
    return out;
}

std::vector<float> asFloats(const std::vector<uint8_t> &bytes, size_t count, const char *what) {
    if (bytes.size() != count * 4)
        throw PacketError(std::string(what) + ": expected " + std::to_string(count * 4) +
                          " bytes, got " + std::to_string(bytes.size()));
    std::vector<float> out(count);
    if (count)
        std::memcpy(out.data(), bytes.data(), count * 4);
    for (float &f : out)
        if (!std::isfinite(f))
            f = 0;
    return out;
}

Image decodeImage(const std::string &fmt, const std::vector<uint8_t> &bytes, int w, int h,
                  bool flipY, bool premultiply, const Limits &limits) {
    if (w <= 0 || h <= 0 || w > limits.maxTextureSize || h > limits.maxTextureSize)
        throw PacketError("texture size " + std::to_string(w) + "x" + std::to_string(h) +
                          " out of range");
    Image img;
    img.w = w;
    img.h = h;
    if (fmt == "rgba8") {
        if (bytes.size() != size_t(w) * size_t(h) * 4)
            throw PacketError("rgba8 texture has the wrong size");
        img.rgba = bytes;
    } else if (fmt == "png" || fmt == "jpeg") {
        if (bytes.size() > size_t(INT32_MAX))
            throw PacketError("image too large");
        int iw = 0, ih = 0, comp = 0;
        if (!stbi_info_from_memory(bytes.data(), int(bytes.size()), &iw, &ih, &comp))
            throw PacketError(std::string("image header: ") + stbi_failure_reason());
        if (iw != w || ih != h)
            throw PacketError("image is " + std::to_string(iw) + "x" + std::to_string(ih) +
                              ", packet says " + std::to_string(w) + "x" + std::to_string(h));
        stbi_uc *data = stbi_load_from_memory(bytes.data(), int(bytes.size()), &iw, &ih, &comp, 4);
        if (!data)
            throw PacketError(std::string("image decode: ") + stbi_failure_reason());
        img.rgba.assign(data, data + size_t(iw) * size_t(ih) * 4);
        stbi_image_free(data);
    } else {
        throw PacketError("texture format \"" + fmt + "\" is not supported");
    }
    if (flipY) {
        size_t row = size_t(w) * 4;
        std::vector<uint8_t> tmp(row);
        for (int y = 0; y < h / 2; y++) {
            uint8_t *a = img.rgba.data() + size_t(y) * row;
            uint8_t *b = img.rgba.data() + size_t(h - 1 - y) * row;
            std::memcpy(tmp.data(), a, row);
            std::memcpy(a, b, row);
            std::memcpy(b, tmp.data(), row);
        }
    }
    if (premultiply) {
        for (size_t i = 0; i < img.rgba.size(); i += 4) {
            unsigned a = img.rgba[i + 3];
            for (int c = 0; c < 3; c++)
                img.rgba[i + c] = uint8_t((img.rgba[i + c] * a + 127) / 255);
        }
    }
    return img;
}

std::vector<float> floatList(const json &o, const char *key, size_t max) {
    std::vector<float> out;
    auto it = o.find(key);
    if (it == o.end() || it->is_null())
        return out;
    if (!it->is_array() || it->size() > max)
        throw PacketError(std::string("field \"") + key + "\" is not an array of at most " +
                          std::to_string(max));
    out.reserve(it->size());
    for (const auto &v : *it) {
        if (!v.is_number())
            throw PacketError(std::string("field \"") + key + "\" has a non-number");
        out.push_back(v.get<float>());
    }
    return out;
}

std::vector<uint32_t> idList(const json &o, const char *key, size_t max) {
    std::vector<uint32_t> out;
    auto it = o.find(key);
    if (it == o.end() || it->is_null())
        return out;
    if (!it->is_array() || it->size() > max)
        throw PacketError(std::string("field \"") + key + "\" is not an id list");
    out.reserve(it->size());
    for (const auto &v : *it) {
        if (!v.is_number_unsigned())
            throw PacketError(std::string("field \"") + key + "\" has a bad id");
        out.push_back(v.get<uint32_t>());
    }
    return out;
}

} // namespace office::scene
