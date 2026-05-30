# Using Docker and Emscripten

- Check Docker first with `docker info`. Docker CLI can be installed while the daemon is still unreachable.
- If Docker is unavailable but a local EMSDK exists, prefer a host-toolchain fallback instead of failing the root build.
- On Windows, resolve `EMSDK` explicitly when running `emcmake` / `em++`; do not assume the shell already has the right path.
- Keep the Docker image toolchain-only. Mount the repo and run the real build inside the container with a dedicated `--inside-docker` path.
- Treat a long Emscripten build as separate from daemon reachability. First confirm the daemon works, then wait on the compile.
