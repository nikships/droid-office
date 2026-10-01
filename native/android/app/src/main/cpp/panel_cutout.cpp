#include "panel_cutout.h"

#include <stdexcept>
#include <string>

namespace office {
namespace {
GLuint compile(GLenum type, const std::string &code) {
    GLuint shader = glCreateShader(type);
    const char *source = code.c_str();
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint good = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
        glDeleteShader(shader);
        throw std::runtime_error(std::string("Panel cutout shader: ") + log);
    }
    return shader;
}
} // namespace

PanelCutout::~PanelCutout() {
    if (program)
        glDeleteProgram(program);
    if (vao)
        glDeleteVertexArrays(1, &vao);
}

void PanelCutout::initialize(bool multiview) {
    stereo = multiview;
    std::string prefix = "#version 300 es\n";
    if (stereo)
        prefix += "#extension GL_OVR_multiview2 : require\nlayout(num_views=2) in;\n";
    const std::string view = stereo ? "int(gl_ViewID_OVR)" : "0";
    // `full`: one triangle over the whole viewport; otherwise the hole as a 4-vertex strip.
    const GLuint vertex =
        compile(GL_VERTEX_SHADER,
                prefix +
                    "precision highp float;\nuniform mat4 views[2];\nuniform vec3 corners[4];\n"
                    "uniform bool full;\nvoid main(){\nif(full){vec2 "
                    "p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));"
                    "gl_Position=vec4(p*2.0-1.0,0,1);}\nelse gl_Position=views[" +
                    view + "]*vec4(corners[gl_VertexID],1);\n}\n");
    const GLuint fragment =
        compile(GL_FRAGMENT_SHADER, "#version 300 es\nprecision mediump float;\nuniform vec4 "
                                    "color;\nout vec4 pixel;\nvoid main(){pixel=color;}\n");
    program = glCreateProgram();
    glAttachShader(program, vertex);
    glAttachShader(program, fragment);
    glLinkProgram(program);
    glDeleteShader(vertex);
    glDeleteShader(fragment);
    GLint good = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetProgramInfoLog(program, sizeof(log), nullptr, log);
        glDeleteProgram(program);
        program = 0;
        throw std::runtime_error(std::string("Panel cutout program: ") + log);
    }
    viewsUniform = glGetUniformLocation(program, "views");
    cornersUniform = glGetUniformLocation(program, "corners");
    fullUniform = glGetUniformLocation(program, "full");
    colorUniform = glGetUniformLocation(program, "color");
    glGenVertexArrays(1, &vao);
}

void PanelCutout::quad(const float views[2][16], const float corners[4][3]) {
    glUniform1i(fullUniform, 0);
    glUniformMatrix4fv(viewsUniform, stereo ? 2 : 1, GL_FALSE, views[0]);
    glUniform3fv(cornersUniform, 4, corners[0]);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

void PanelCutout::punch(const float views[2][16], const float corners[4][3]) {
    glUseProgram(program);
    glBindVertexArray(vao);
    glDisable(GL_BLEND);
    glDisable(GL_CULL_FACE);
    glDisable(GL_DEPTH_TEST);
    // Alpha only: the world's colors stay, every pixel becomes opaque.
    glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_TRUE);
    glUniform1i(fullUniform, 1);
    glUniform4f(colorUniform, 0, 0, 0, 1);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    // The hole: transparent black (premultiplied) at the panel's depth, whatever was nearer.
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_ALWAYS);
    glDepthMask(GL_TRUE);
    glUniform4f(colorUniform, 0, 0, 0, 0);
    quad(views, corners);
    glDepthFunc(GL_LEQUAL);
    glBindVertexArray(0);
    glUseProgram(0);
}

void PanelCutout::seal(const float views[2][16], const float corners[4][3]) {
    glUseProgram(program);
    glBindVertexArray(vao);
    glDisable(GL_BLEND);
    glDisable(GL_CULL_FACE);
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_ALWAYS);
    glDepthMask(GL_TRUE);
    glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
    // The hole's own clipping, every depth written as the near plane's.
    glDepthRangef(0, 0);
    quad(views, corners);
    glDepthRangef(0, 1);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glDepthFunc(GL_LEQUAL);
    glBindVertexArray(0);
    glUseProgram(0);
}

} // namespace office
