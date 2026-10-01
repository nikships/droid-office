// OpenXR call helpers shared by the session (office_xr.cpp) and its world renderers, in their own
// namespace so `function` never meets std::function; each file takes them with using-declarations.
#pragma once
#include <openxr/openxr.h>

#include <stdexcept>
#include <string>

namespace office::xr {

/** Throws for a failed call, naming the operation and the XrResult. */
inline void check(XrResult result, const char *operation) {
    if (XR_FAILED(result))
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}

/** An instance function, or an exception when the runtime has none. */
template <class T> T function(XrInstance instance, const char *name) {
    PFN_xrVoidFunction value = nullptr;
    check(xrGetInstanceProcAddr(instance, name, &value), name);
    return reinterpret_cast<T>(value);
}

/** nullptr instead of an exception, for features with a fallback. */
template <class T> T optionalFunction(XrInstance instance, const char *name) {
    PFN_xrVoidFunction value = nullptr;
    return XR_SUCCEEDED(xrGetInstanceProcAddr(instance, name, &value)) ? reinterpret_cast<T>(value)
                                                                       : nullptr;
}

} // namespace office::xr
