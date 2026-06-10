ARG EMSDK_IMAGE=ghcr.io/emscripten-core/emsdk:4.0.14
FROM ${EMSDK_IMAGE}

SHELL ["/bin/bash", "-lc"]

ARG LIBJXL_COMMIT=332feb17d17311c748445f7ee75c4fb55cc38530
ARG LIBJXL_REPO=https://github.com/libjxl/libjxl.git

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    git \
    ninja-build \
    perl \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work/jxl-wasm

ENV LIBJXL_COMMIT=${LIBJXL_COMMIT}
ENV LIBJXL_REPO=${LIBJXL_REPO}
