#pragma once
#include <GLES3/gl3.h>
#include <openxr/openxr.h>

namespace office {
/** A small compositor reticle stays sharp and follows each panel ray at the display rate. */
class CursorSwapchain {
  public:
    ~CursorSwapchain();
    void initialize(XrSession session, GLenum format);
    XrCompositionLayerQuad layer(XrSpace space, XrPosef pose) const;

  private:
    XrSwapchain swapchain = XR_NULL_HANDLE;
    static constexpr int SIZE = 64;
};
} // namespace office
