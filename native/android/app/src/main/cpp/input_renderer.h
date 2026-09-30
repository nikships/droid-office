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
    void render(const Matrix &left, const Matrix &right, float fade);

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
