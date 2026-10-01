#pragma once
#include "bridge_state.h"
#include "controller_renderer.h"
#include "xr_input.h"
#include <GLES3/gl3.h>

namespace office {
/** Controllers, rays and comfort blink use the current predicted pose, at 90 Hz. */
class InputRenderer {
  public:
    ~InputRenderer();
    void initialize(bool multiview, bool srgbFramebuffer, AAssetManager *assets);
    void update(const InputFrame &frame, const ControlState &state, XrPosef panelPose,
                bool panelVisible);
    /**
     * After update: a bit per hand (1 left, 2 right) whose controller model is not drawn this
     * frame, because an attached object (the gun, SceneRenderer::attachedHands) is in that hand.
     */
    void hideControllers(unsigned hands) { controllers.hide(hands); }
    /** Controllers, rays, the teleport arc. Depth-tested, so after PanelCutout::punch they show
     * in front of the workspace panel exactly where they are nearer than it. */
    void render(const Matrix &left, const Matrix &right);
    /**
     * The comfort fade over everything drawn so far. Color only: the alpha a PanelCutout punched
     * stays 0, so the workspace panel beneath is not faded (as when it was composited on top).
     */
    void renderFade(float fade);

  private:
    struct Vertex {
        float x, y, z, r, g, b;
    };
    GLuint program = 0, fadeProgram = 0, vao = 0, vbo = 0;
    GLint matrixUniform = -1, fadeUniform = -1;
    bool stereo = false;
    ControllerRenderer controllers;
    std::vector<Vertex> vertices;
    void triangle(XrVector3f a, XrVector3f b, XrVector3f c, XrVector3f color);
    void bone(XrVector3f a, XrVector3f b, float radius, XrVector3f color);
    void sphere(XrVector3f center, float radius, XrVector3f color);
};
} // namespace office
