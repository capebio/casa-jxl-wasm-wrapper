{
  "targets": [
    {
      "target_name": "jxl_native",
      "sources": [
        "src/native.cc"
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "include_dirs": [
        "<!(node -p \"process.env.JXL_NATIVE_INCLUDE_DIR || ''\")"
      ],
      "cflags_cc": [
        "-fno-exceptions"
      ],
      "conditions": [
        [
          "OS!='win'",
          {
            "cflags_cc": [
              "<!@(pkg-config --cflags libjxl 2>/dev/null || true)"
            ],
            "libraries": [
              "<!@(pkg-config --libs libjxl 2>/dev/null || true)"
            ]
          }
        ],
        [
          "OS!='win' and '<!(node -p \"process.env.JXL_NATIVE_LIB_DIR ? 1 : 0\")'=='1'",
          {
            "libraries": [
              "<!(node -p \"'-L' + process.env.JXL_NATIVE_LIB_DIR\")",
              "-ljxl",
              "-ljxl_threads"
            ]
          }
        ],
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ],
        [
          "OS=='win' and '<!(node -p \"process.env.JXL_NATIVE_LIB_DIR ? 1 : 0\")'=='1'",
          {
            "defines": [
              "JXL_STATIC_DEFINE",
              "JXL_THREADS_STATIC_DEFINE"
            ],
            "library_dirs": [
              "<!(node -p \"process.env.JXL_NATIVE_LIB_DIR\")"
            ],
            "libraries": [
              "jxl.lib",
              "jxl_threads.lib",
              "jxl_cms.lib",
              "hwy.lib",
              "brotlienc.lib",
              "brotlidec.lib",
              "brotlicommon.lib"
            ]
          }
        ]
      ]
    }
  ]
}
