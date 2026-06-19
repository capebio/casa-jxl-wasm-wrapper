//! Build script for `jxl-ffi`.
//!
//! Two jobs, in order:
//!   1. Build BSD-3 libjxl (static) from the in-repo source at
//!      `LIBJXL_SOURCE_DIR` (`external/libjxl`), then emit the static link
//!      line.  `LIBJXL_SOURCE_DIR` is a plain environment variable configured
//!      in `.cargo/config.toml [env]`.  It is *not* a Cargo `DEP_*`
//!      propagation variable (those are emitted by a dependency's build script
//!      via `cargo:metadata=KEY=VALUE` and forwarded automatically by Cargo).
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
        env::var("LIBJXL_SOURCE_DIR")
            .expect("LIBJXL_SOURCE_DIR must point at external/libjxl (set in .cargo/config.toml)"),
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

    // Prefer Cargo's NUM_JOBS (set by `-j N`) so explicit parallelism flags are
    // honoured. Fall back to available_parallelism() only when Cargo doesn't
    // provide the value (e.g. direct cmake invocation outside of cargo).
    let parallelism = env::var("NUM_JOBS")
        .ok()
        .or_else(|| {
            std::thread::available_parallelism()
                .ok()
                .map(|p| p.to_string())
        });
    if let Some(jobs) = parallelism {
        cfg.env("CMAKE_BUILD_PARALLEL_LEVEL", jobs);
    }

    let is_release = env::var("PROFILE").as_deref() == Ok("release");
    // Use CARGO_CFG_TARGET_* (target triple) not cfg!(windows) (host) for cross-compilation.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_vendor = env::var("CARGO_CFG_TARGET_VENDOR").unwrap_or_default();

    if target_os == "windows" {
        cfg.generator_toolset("ClangCL")
            .define(
                "CMAKE_VS_GLOBALS",
                "UseMultiToolTask=true;EnforceProcessCountAcrossBuilds=true",
            )
            .define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreaded")
            // Satisfies cmake's compile-time CRT probe; not linked into our libs.
            .define("CMAKE_EXE_LINKER_FLAGS", "MSVCRTD.lib")
            .cflag("/Zl")
            .cxxflag("/Zl");
        if is_release {
            cfg.cflag("/O2").cflag("/Ob2").cxxflag("/O2").cxxflag("/Ob2");
        }
    }

    let prefix = cfg.build();

    let lib_dir = {
        // On multilib Linux both `lib/` and `lib64/` may exist, but static
        // archives land in only one of them.  Check for the actual library
        // file rather than directory existence to pick the right one.
        let lib_name = if target_os == "windows" { "jxl.lib" } else { "libjxl.a" };
        let l = prefix.join("lib");
        let l64 = prefix.join("lib64");
        if l.join(lib_name).exists() {
            l
        } else if l64.join(lib_name).exists() {
            l64
        } else if l.exists() {
            // Fallback: directory exists but sentinel file not found
            // (e.g. shared-only build or unusual install layout).
            l
        } else {
            l64
        }
    };
    assert!(
        lib_dir.exists(),
        "cmake install produced neither lib/ nor lib64/ under {} — \
         check that cmake install ran successfully",
        prefix.display()
    );
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
    if target_os == "linux" {
        println!("cargo:rustc-link-lib=stdc++");
    } else if target_vendor == "apple" || target_os == "freebsd" {
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
    println!("cargo:rerun-if-env-changed=LIBJXL_SOURCE_DIR");
    // Re-run when the libjxl submodule HEAD changes. In a git submodule the
    // `.git` entry is a plain file (pointing into the superproject gitdir);
    // Cargo tracks it as a file, so `git submodule update` bumps its mtime
    // and triggers a rebuild + bindgen re-run.
    println!(
        "cargo:rerun-if-changed={}",
        source.join(".git").display()
    );
    // Re-run when key source subtrees change so cmake rebuilds on CMakeLists.txt
    // changes and bindgen regenerates on header edits.
    for subpath in &["CMakeLists.txt", "lib/include", "lib/jxl", "lib/threads"] {
        println!(
            "cargo:rerun-if-changed={}",
            source.join(subpath).display()
        );
    }
    // Explicitly track each public header so bindgen re-runs after a submodule
    // update that touches headers. cargo:rerun-if-changed on a directory only
    // watches the directory entry itself, not its contents recursively.
    let jxl_include = source.join("lib").join("include").join("jxl");
    if jxl_include.exists() {
        if let Ok(entries) = std::fs::read_dir(&jxl_include) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("h") {
                    println!("cargo:rerun-if-changed={}", p.display());
                }
            }
        }
    }

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
        .expect(
            "bindgen failed to generate libjxl bindings — \
             ensure libclang is available (set LIBCLANG_PATH to your LLVM bin dir, \
             e.g. C:\\Program Files\\LLVM\\bin) and that LIBJXL_SOURCE_DIR is configured \
             in .cargo/config.toml",
        );

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out.join("bindings.rs"))
        .expect("failed to write bindings.rs");
}
