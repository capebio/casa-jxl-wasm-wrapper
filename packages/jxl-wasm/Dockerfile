ARG EMSDK_IMAGE=docker.io/emscripten/emsdk:3.1.27
FROM ${EMSDK_IMAGE}

SHELL ["/bin/bash", "-lc"]

ARG LIBJXL_COMMIT=332feb17d17311c748445f7ee75c4fb55cc38530
ARG LIBJXL_TAG=v0.11.2
ARG LIBJXL_REPO=https://github.com/libjxl/libjxl.git
ARG PGO=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ccache \
    cmake \
    git \
    ninja-build \
    perl \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# build.mjs defaults workDir to /tmp/jxl-wasm-work via os.tmpdir() inside container.
# Keep pinned libjxl source here so ensureLibjxlSource() can short-circuit clone+submodules.
RUN git clone --recursive --shallow-submodules --depth 1 --branch "${LIBJXL_TAG}" \
      "${LIBJXL_REPO}" /tmp/jxl-wasm-work/libjxl \
  && test "$(git -C /tmp/jxl-wasm-work/libjxl rev-parse HEAD)" = "${LIBJXL_COMMIT}" \
  && bash -lc "cd /tmp/jxl-wasm-work/libjxl && ./deps.sh"

# System libraries built on-demand by emcc (pre-building can fail on latest emsdk)

RUN emcc --version \
  && git config --global --add safe.directory '*'

WORKDIR /work/jxl-wasm

ENV LIBJXL_COMMIT=${LIBJXL_COMMIT}
ENV LIBJXL_TAG=${LIBJXL_TAG}
ENV LIBJXL_REPO=${LIBJXL_REPO}
ENV EM_COMPILER_WRAPPER=ccache
ENV CCACHE_DIR=/work/jxl-wasm/.ccache
ENV CCACHE_MAXSIZE=5G
ENV EMCC_SKIP_SANITY_CHECK=1

# PGO contract:
# - pass 1 builds enc:simd with -fprofile-generate plus Node+RawFS support, then pgo-train.mjs runs headless.
# - llvm-profdata merge emits /work/jxl-wasm/packages/jxl-wasm/dist/jxl.profdata.
# - pass 2 rebuilds enc:simd with -fprofile-use=jxl.profdata.
RUN mkdir -p /profiles
