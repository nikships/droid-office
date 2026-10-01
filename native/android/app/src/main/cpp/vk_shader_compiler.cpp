#include "vk_shader_compiler.h"

#include <shaderc/shaderc.hpp>

namespace office::vkscene {

struct ShaderCompiler::Impl {
    shaderc::Compiler compiler;
    shaderc::CompileOptions options;
};

ShaderCompiler::ShaderCompiler() : impl_(std::make_unique<Impl>()) {
    // The shader suite's glslc flags: --target-env=vulkan1.1 -Werror, no optimisation (the driver
    // optimises when it creates the pipeline; skipping spirv-opt keeps the worker's time short).
    impl_->options.SetTargetEnvironment(shaderc_target_env_vulkan, shaderc_env_version_vulkan_1_1);
    impl_->options.SetSourceLanguage(shaderc_source_language_glsl);
    impl_->options.SetOptimizationLevel(shaderc_optimization_level_zero);
    impl_->options.SetWarningsAsErrors();
}

ShaderCompiler::~ShaderCompiler() = default;

bool ShaderCompiler::compile(const std::string &source, bool vertex, const std::string &name,
                             std::vector<uint32_t> &spirv, std::string &error) {
    if (!impl_->compiler.IsValid()) {
        error = "shaderc compiler is not valid";
        return false;
    }
    const shaderc::SpvCompilationResult result = impl_->compiler.CompileGlslToSpv(
        source.data(), source.size(),
        vertex ? shaderc_glsl_vertex_shader : shaderc_glsl_fragment_shader, name.c_str(), "main",
        impl_->options);
    if (result.GetCompilationStatus() != shaderc_compilation_status_success) {
        error = result.GetErrorMessage();
        if (error.empty())
            error = "shaderc status " + std::to_string(int(result.GetCompilationStatus()));
        return false;
    }
    spirv.assign(result.cbegin(), result.cend());
    return true;
}

} // namespace office::vkscene
