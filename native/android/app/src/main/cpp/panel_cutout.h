// The workspace panel is a compositor quad with its own sharp text sampling. Submitted over the
// world layer it covered everything, including the player's own controllers, rays and held gun
// (reaching toward the keyboard, the hands disappeared behind it). While the panel is open the
// display loop submits it beneath the world layer instead, and the world layer cuts a hole where
// the panel is (alpha 0): the world never covers the panel, and what the player holds in front of
// it does. GL only, no OpenXR or Android types, so the host GLES suite runs the device code.
#pragma once
#include <GLES3/gl3.h>

namespace office {

/**
 * How far inside the panel's edges the hole stops. The compositor reprojects the world layer and
 * the panel quad separately; a hole slightly smaller than the quad keeps that from opening a black
 * seam at the panel's edge (the world covers its outermost few millimetres instead).
 */
constexpr float kPanelCutoutInset = .004f;

/**
 * Draws into the bound eye framebuffer (and viewport), in this order for a frame with the panel
 * open: SceneDrawSet::World, punch(), SceneDrawSet::Attached, the controllers and rays, then
 * seal() when the screen layer is drawn, then the comfort fade with alpha writes off. The world
 * layer is then submitted with XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT over the panel.
 * `views` are column-major LOCAL_FLOOR view-projection matrices (one, or two for multiview) and
 * `corners` the hole in LOCAL_FLOOR: bottom-left, bottom-right, top-left, top-right
 * (panelCutoutCorners). Both leave depth test on with LEQUAL and writes on, blend off, the full
 * color mask, depth range 0..1, no program or vertex array bound.
 */
class PanelCutout {
  public:
    ~PanelCutout();
    /** GL thread, context current. Throws when the program does not compile or link. */
    void initialize(bool multiview);
    /**
     * Alpha 1 everywhere (blending and the controllers' translucent parts may have lowered it),
     * then inside the hole color and alpha 0 and the panel's own depth, over whatever the world
     * drew there, nearer or not. Everything drawn afterwards with the depth test shows in front of
     * the panel where it is nearer than the panel and stays hidden behind it otherwise.
     */
    void punch(const float views[2][16], const float corners[4][3]);
    /**
     * Inside the hole, the near plane's depth (color untouched): the screen layer, which tests
     * against this depth, then draws no world screen over the panel or the hands in front of it.
     */
    void seal(const float views[2][16], const float corners[4][3]);

  private:
    void quad(const float views[2][16], const float corners[4][3]);
    GLuint program = 0, vao = 0;
    GLint viewsUniform = -1, cornersUniform = -1, fullUniform = -1, colorUniform = -1;
    bool stereo = false;
};

} // namespace office
