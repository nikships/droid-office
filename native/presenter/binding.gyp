{
  "targets": [
    {
      "target_name": "presenter",
      "sources": ["src/presenter.mm", "src/metal_view.mm", "src/input_view.mm", "src/input_bridge.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "14.0",
            "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc"],
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
          },
          "link_settings": {
            "libraries": [
              "-framework AppKit",
              "-framework QuartzCore",
              "-framework Metal",
              "-framework GameController",
              "-framework ApplicationServices",
              "-framework IOSurface",
              "-framework CoreVideo"
            ]
          }
        }]
      ]
    }
  ]
}
