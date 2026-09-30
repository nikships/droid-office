#pragma once

#include <GLES3/gl3.h>
#include <algorithm>
#include <array>

namespace office {
/** Debug-build, one-shot check that tile-MSAA depth is usable after the world FBO unbinds.
 * It runs before the first sharp screen pass, never in steady-state performance samples.
 */
class DepthProbe {
  public:
    ~DepthProbe() {
        if (program)
            glDeleteProgram(program);
        if (framebuffer)
            glDeleteFramebuffers(1, &framebuffer);
        if (color)
            glDeleteTextures(1, &color);
        if (vao)
            glDeleteVertexArrays(1, &vao);
    }

    bool initialize(bool arrayTexture) {
        const char *vertex = "#version 300 es\n"
                             "void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);"
                             "gl_Position=vec4(p*2.0-1.0,0,1);}";
        const char *fragmentArray =
            "#version 300 es\nprecision highp float;"
            "uniform highp sampler2DArray uDepth;out vec4 color;"
            "void main(){float d=texture(uDepth,vec3(gl_FragCoord.xy/16.0,0)).r;"
            "color=vec4(clamp((1.0-d)*32.0,0.0,1.0),d>0.0?1.0:0.0,0,1);}";
        const char *fragment2d = "#version 300 es\nprecision highp float;"
                                 "uniform highp sampler2D uDepth;out vec4 color;"
                                 "void main(){float d=texture(uDepth,gl_FragCoord.xy/16.0).r;"
                                 "color=vec4(clamp((1.0-d)*32.0,0.0,1.0),d>0.0?1.0:0.0,0,1);}";
        auto compile = [](GLenum type, const char *source) {
            GLuint shader = glCreateShader(type);
            glShaderSource(shader, 1, &source, nullptr);
            glCompileShader(shader);
            GLint valid = 0;
            glGetShaderiv(shader, GL_COMPILE_STATUS, &valid);
            if (!valid) {
                glDeleteShader(shader);
                return GLuint(0);
            }
            return shader;
        };
        GLuint vs = compile(GL_VERTEX_SHADER, vertex);
        GLuint fs = compile(GL_FRAGMENT_SHADER, arrayTexture ? fragmentArray : fragment2d);
        if (!vs || !fs) {
            if (vs)
                glDeleteShader(vs);
            if (fs)
                glDeleteShader(fs);
            return false;
        }
        program = glCreateProgram();
        glAttachShader(program, vs);
        glAttachShader(program, fs);
        glLinkProgram(program);
        glDeleteShader(vs);
        glDeleteShader(fs);
        GLint linked = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &linked);
        if (!linked)
            return false;
        glGenVertexArrays(1, &vao);
        glGenTextures(1, &color);
        glBindTexture(GL_TEXTURE_2D, color);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, 16, 16);
        glGenFramebuffers(1, &framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
        bool valid = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        return valid;
    }

    struct Result {
        int covered = 0, zero = 0, maximum = 0;
        GLenum error = 0;
    };
    Result sample(GLuint depth, bool arrayTexture) {
        GLint previousViewport[4];
        glGetIntegerv(GL_VIEWPORT, previousViewport);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glViewport(0, 0, 16, 16);
        glDisable(GL_DEPTH_TEST);
        glDepthMask(GL_FALSE);
        glDisable(GL_BLEND);
        glDisable(GL_CULL_FACE);
        glDisable(GL_SCISSOR_TEST);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        glUseProgram(program);
        glBindVertexArray(vao);
        glActiveTexture(GL_TEXTURE5);
        glBindSampler(5, 0);
        GLenum target = arrayTexture ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
        glBindTexture(target, depth);
        glUniform1i(glGetUniformLocation(program, "uDepth"), 5);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        std::array<unsigned char, 16 * 16 * 4> pixels{};
        glReadPixels(0, 0, 16, 16, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        Result result;
        for (size_t i = 0; i < pixels.size(); i += 4) {
            result.covered += pixels[i] > 0 && pixels[i + 1] > 0;
            result.zero += pixels[i + 1] == 0;
            result.maximum = std::max(result.maximum, int(pixels[i]));
        }
        result.error = glGetError();
        glBindTexture(target, 0);
        glActiveTexture(GL_TEXTURE0);
        glBindVertexArray(0);
        glUseProgram(0);
        glDepthMask(GL_TRUE);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glViewport(previousViewport[0], previousViewport[1], previousViewport[2],
                   previousViewport[3]);
        return result;
    }

  private:
    GLuint program = 0, framebuffer = 0, color = 0, vao = 0;
};
} // namespace office
