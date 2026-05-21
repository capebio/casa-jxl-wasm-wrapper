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
      "cflags_cc": [
        "-fno-exceptions"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ]
    }
  ]
}
