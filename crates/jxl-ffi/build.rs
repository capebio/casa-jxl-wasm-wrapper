//! Build script for `jxl-ffi`.
//!
//! Two jobs, in order:
//!   1. Build BSD-3 libjxl (static) from the in-repo source at `DEP_JXL_PATH`
//!      (`external/libjxl`), then emit the static link line.
//!   2. Run bindgen over the *installed* C headers (which include the
//!      cmake-generated `jxl_export.h` / `version.h`) → `$OUT_DIR/bindings.rs`.
//!
//! Native only. On `wasm32` the crate compiles to nothing (see `src/lib.rs`);
//! the build script short-circuits so cmake/bindgen never run.
//!
//! The Windows cmake configuration mirrors the known-good recipe for building
//! BSD libjxl under MSVC/ClangCL: static libs, MultiThreaded runtime, `/Zl` to
//! avoid baking a CRT choice into the archives (so they link into Rust's CRT),
//! and `/O2 /Ob2` forced on release because cmake-rs drops MSVC's default `/O2`
//! under the ClangCL multi-config generator (the libjxl "0.11 ~30x regression").

use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("wasm32") {
        // Native-only FFI. WASM JXL stays on web/pkg + bridge.cpp.
        return;
    }

    let source = PathBuf::from(
        env::var("DEP_JXL_PATH")
            .expect("DEP_JXL_PATH must point at external/libjxl (set in .cargo/config.toml)"),
    );
    assert!(
        source.join("CMakeLists.txt").exists(),
        "libjxl source not found at {} (CMakeLists.txt missing)",
        source.display()
    );

    // --- 1. Build static BSD libjxl -------------------------------------
    let mut cfg = cmake::Config::new(&source);
    cfg.define("BUILD_TESTING", "OFF")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("JPEGXL_ENABLE_TOOLS", "OFF")
        .define("JPEGXL_ENABLE_DOXYGEN", "OFF")
        .define("JPEGXL_ENABLE_MANPAGES", "OFF")
        .define("JPEGXL_ENABLE_BENCHMARK", "OFF")
        .define("JPEGXL_ENABLE_EXAMPLES", "OFF")
        .define("JPEGXL_ENABLE_JNI", "OFF")
        .define("JPEGXL_ENABLE_SJPEG", "OFF")
        .define("JPEGXL_ENABLE_OPENEXR", "OFF")
        .define("JPEGXL_ENABLE_JPEGLI", "OFF")
        .define("JPEGXL_BUNDLE_LIBPNG", "OFF");

    if let Ok(p) = std::thread::available_parallelism() {
        cfg.env("CMAKE_BUILD_PARALLEL_LEVEL", p.to_string());
    }

    let is_release = env::var("PROFILE").as_deref() == Ok("release");

    if cfg!(windows) {
        cfg.generator_toolset("ClangCL")
            .define(
                "CMAKE_VS_GLOBALS",
                "UseMultiToolTask=true;EnforceProcessCountAcrossBuilds=true",
            )
            .define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreaded")
            // Satisfies cmake's compile-time CRT probe; not linked into our libs.
            .define("CMAKE_EXE_LINKER_FLAGS", "MSVCRTD.lib")
            .cflag("/Zl");
        if is_release {
            cfg.cflag("/O2").cflag("/Ob2").cxxflag("/O2").cxxflag("/Ob2");
        }
    }

    let prefix = cfg.build();

    let lib_dir = {
        let l = prefix.join("lib");
        if l.exists() {
            l
        } else {
            prefix.join("lib64")
        }
    };
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    for lib in [
        "jxl",
        "jxl_cms",
        "jxl_threads",
        "hwy",
        "brotlidec",
        "brotlienc",
        "brotlicommon",
    ] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-lib=stdc++");
    } else if cfg!(any(target_vendor = "apple", target_os = "freebsd")) {
        println!("cargo:rustc-link-lib=c++");
    }

    // --- 2. bindgen over installed BSD headers --------------------------
    let include = prefix.join("include");
    assert!(
        include.join("jxl").join("encode.h").exists(),
        "installed headers not found at {} — cmake install incomplete",
        include.display()
    );

    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-env-changed=DEP_JXL_PATH");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("-I{}", include.display()))
        // Keep the binding surface to libjxl symbols only.
        .allowlist_function("Jxl.*")
        .allowlist_type("Jxl.*")
        .allowlist_var("JXL_.*")
        .allowlist_var("Jxl.*")
        // NewType keeps C enums FFI-safe (transparent integer) — no UB on an
        // unexpected status value returned from C, unlike a Rust `enum`.
        .default_enum_style(bindgen::EnumVariation::NewType {
            is_bitfield: false,
            is_global: false,
        })
        .generate()
        .expect("bindgen failed to generate libjxl bindings");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out.join("bindings.rs"))
        .expect("failed to write bindings.rs");
}
