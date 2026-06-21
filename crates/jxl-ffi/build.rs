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
//! and `/O2 /Ob2` forced because cmake-rs drops MSVC's default `/O2` under the
//! ClangCL multi-config generator (the libjxl "0.11 ~30x regression").
//!
//! The vendored libjxl is built optimized (RelWithDebInfo) regardless of Cargo's
//! profile — it is third-party code we never step into, and a Debug build of it
//! cripples encode/decode for the whole `cargo test` inner loop. Set
//! `JXL_FFI_DEBUG_LIBJXL=1` to match Cargo's profile (Debug) instead.

use std::env;
use std::path::PathBuf;

/// Best-effort lookup of an executable on `PATH` (honours Windows `PATHEXT`).
/// Returns the resolved path if found. Used to make the sccache launcher a
/// pure no-op when sccache isn't installed.
fn which_on_path(exe: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    // On Windows, also try the executable extensions (sccache → sccache.exe).
    let exts: Vec<String> = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    for dir in env::split_paths(&path) {
        let direct = dir.join(exe);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            let cand = dir.join(format!("{exe}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

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
        .define("JPEGXL_BUNDLE_LIBPNG", "OFF")
        // JPEG↔JXL lossless transcode (AddJPEGFrame / SetJPEGBuffer / jpeg_data).
        // No jxl-ffi consumer uses it: the only JPEG-transcode path in this repo
        // is web/bridge.cpp's WASM build, which does NOT link jxl-ffi. Turning it
        // OFF drops decode_to_jpeg.cc + enc_jpeg_data.cc + the jpeg_data subtree
        // from the static lib (a build-time-only reduction; the public decode/
        // encode symbols we DO use are unaffected). libjxl's own CI builds with
        // this OFF, so it is a supported configuration. If any consumer ever
        // calls JxlEncoderAddJPEGFrame / JxlDecoderSetJPEGBuffer, flip this back.
        .define("JPEGXL_ENABLE_TRANSCODE_JPEG", "OFF");

    // sccache compiler-cache launcher (optional, guarded). When `sccache` is on
    // PATH, route libjxl's C/C++ compiles through it so object files are cached
    // and SHARED across the many sibling git worktrees / clean rebuilds. No-op
    // when sccache is absent (the common case here) — we never inject a launcher
    // that doesn't exist, so the build cannot break from this. sccache is NOT
    // currently installed; installing it would make repeated libjxl rebuilds
    // (minutes each, cold) near-instant on a cache hit.
    if which_on_path("sccache").is_some() {
        cfg.define("CMAKE_C_COMPILER_LAUNCHER", "sccache")
            .define("CMAKE_CXX_COMPILER_LAUNCHER", "sccache");
        println!("cargo:warning=jxl-ffi: routing libjxl compiles through sccache");
    }

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

    // Always build the vendored libjxl optimized, regardless of Cargo's PROFILE.
    // libjxl is third-party BSD code we never step into; a Debug build of it makes
    // encode/decode dramatically slower and drags down every `cargo test`.
    // RelWithDebInfo applies /O2 while keeping symbols for crash backtraces, and
    // pairs cleanly with the MultiThreaded (release) CRT selected below. Opt back
    // into a profile-matched (Debug) libjxl with JXL_FFI_DEBUG_LIBJXL=1 when you
    // need to step into the codec itself.
    let optimize_libjxl = env::var_os("JXL_FFI_DEBUG_LIBJXL").is_none();
    if optimize_libjxl {
        cfg.profile("RelWithDebInfo");
    }

    // NOTE: ThinLTO/IPO (CMAKE_INTERPROCEDURAL_OPTIMIZATION=ON) was evaluated and
    // dropped. It LINKS fine — lld-link consumes the ThinLTO-bitcode static
    // archives into the Rust binary without error — and it preserves bit-exact
    // codec output. But on the i7-10850H it delivered no measurable enc/dec win
    // (interleaved, thermal-cancelled A/B: ~0% / marginally negative, far below
    // the ≥5% gate) while making clean libjxl builds slower. Not worth shipping.
    // Re-evaluate only if libjxl's hot path becomes cross-TU-inlining-bound.

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
        if optimize_libjxl {
            // cmake-rs drops MSVC's default /O2 under the ClangCL multi-config
            // generator (the libjxl "0.11 ~30x regression"); force it back. /Ob2
            // also upgrades RelWithDebInfo's default /Ob1 to full inlining.
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
    // Toggling the codec optimization level must reconfigure + rebuild libjxl.
    println!("cargo:rerun-if-env-changed=JXL_FFI_DEBUG_LIBJXL");
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
        // Build hygiene — trims the generated bindings.rs and bindgen's work with
        // no change to the FFI surface. Bindings regenerate from the same headers
        // the static lib is compiled from, so the layout_tests are tautological
        // here (they'd only catch a bindgen codegen bug) yet compile a pile of
        // __bindgen_test_layout_* fns on every build. generate_comments(false)
        // skips clang doc-comment parsing; merge_extern_blocks coalesces the
        // extern "C" blocks for a slightly cheaper compile of the generated file.
        .layout_tests(false)
        .generate_comments(false)
        .merge_extern_blocks(true)
        // The bindings are machine-read (`include!`d, never opened by a human),
        // so running rustfmt over them is wasted work. Formatter::None skips the
        // rustfmt subprocess entirely (bindgen's default is Formatter::Rustfmt),
        // trimming one process spawn off every bindgen run with no FFI change.
        .formatter(bindgen::Formatter::None)
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
