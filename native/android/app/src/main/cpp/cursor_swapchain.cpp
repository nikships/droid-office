#include "cursor_swapchain.h"
#include "xr_util.h"
#include <EGL/egl.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <jni.h>
#include <openxr/openxr_platform.h>
#include <stdexcept>
#include <vector>

namespace office {
namespace {
void check(XrResult result, const char *operation) {
    if (XR_FAILED(result))
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}
} // namespace
CursorSwapchain::~CursorSwapchain() {
    if (swapchain)
        xrDestroySwapchain(swapchain);
}
void CursorSwapchain::initialize(XrSession session, GLenum format) {
    auto info = structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
    info.createFlags = XR_SWAPCHAIN_CREATE_STATIC_IMAGE_BIT;
    info.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_TRANSFER_DST_BIT;
    info.format = format;
    info.sampleCount = 1;
    info.width = SIZE;
    info.height = SIZE;
    info.faceCount = 1;
    info.arraySize = 1;
    info.mipCount = 1;
    check(xrCreateSwapchain(session, &info, &swapchain), "create pointer swapchain");
    uint32_t count = 0;
    check(xrEnumerateSwapchainImages(swapchain, 0, &count, nullptr), "pointer images");
    std::vector<XrSwapchainImageOpenGLESKHR> images(
        count, structure<XrSwapchainImageOpenGLESKHR>(XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR));
    check(xrEnumerateSwapchainImages(swapchain, count, &count,
                                     reinterpret_cast<XrSwapchainImageBaseHeader *>(images.data())),
          "pointer images");
    uint32_t index = 0;
    auto acquire = structure<XrSwapchainImageAcquireInfo>(XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO);
    check(xrAcquireSwapchainImage(swapchain, &acquire, &index), "acquire pointer");
    auto wait = structure<XrSwapchainImageWaitInfo>(XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO);
    wait.timeout = XR_INFINITE_DURATION;
    check(xrWaitSwapchainImage(swapchain, &wait), "wait pointer");
    std::array<unsigned char, SIZE * SIZE * 4> pixels{};
    for (int y = 0; y < SIZE; y++)
        for (int x = 0; x < SIZE; x++) {
            float dx = (x + .5f) / SIZE - .5f, dy = (y + .5f) / SIZE - .5f,
                  r = std::sqrt(dx * dx + dy * dy);
            float ring =
                std::clamp((.46f - r) * 32, 0.f, 1.f) * std::clamp((r - .32f) * 32, 0.f, 1.f);
            float dot = std::clamp((.10f - r) * 32, 0.f, 1.f);
            size_t offset = (y * SIZE + x) * 4;
            pixels[offset] = 230;
            pixels[offset + 1] = 250;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = std::lround(std::max(ring, dot) * 255);
        }
    glBindTexture(GL_TEXTURE_2D, images[index].image);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, SIZE, SIZE, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    glFlush();
    auto release = structure<XrSwapchainImageReleaseInfo>(XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
    check(xrReleaseSwapchainImage(swapchain, &release), "release pointer");
}
XrCompositionLayerQuad CursorSwapchain::layer(XrSpace space, XrPosef pose) const {
    auto result = structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
    result.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT |
                        XR_COMPOSITION_LAYER_UNPREMULTIPLIED_ALPHA_BIT;
    result.space = space;
    result.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
    result.pose = pose;
    result.size = {.028f, .028f};
    result.subImage.swapchain = swapchain;
    result.subImage.imageRect.extent = {SIZE, SIZE};
    return result;
}
} // namespace office
