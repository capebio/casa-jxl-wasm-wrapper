export function createGalleryLightbox({ framesByFile }) {
  let state = null;
  let maxFrameIndexVisited = 0;

  return {
    open(fileId, frameIndex) {
      state = { fileId, frameIndex };
      maxFrameIndexVisited = frameIndex;
    },
    current() {
      return state;
    },
    handleKey(ev) {
      if (!state) return;
      const frames = framesByFile.get(state.fileId) ?? [];
      if (frames.length === 0) return;

      if (ev.ctrlKey && ev.key === 'ArrowRight') {
        const ids = [...framesByFile.keys()];
        const nextFile = ids[(ids.indexOf(state.fileId) + 1) % ids.length];
        const nextFrames = framesByFile.get(nextFile) ?? [];
        const clampedIndex = Math.min(maxFrameIndexVisited, Math.max(0, nextFrames.length - 1));
        state = { fileId: nextFile, frameIndex: clampedIndex };
        maxFrameIndexVisited = Math.max(maxFrameIndexVisited, clampedIndex);
        return;
      }

      if (ev.ctrlKey && ev.key === 'ArrowLeft') {
        const ids = [...framesByFile.keys()];
        const nextFile = ids[(ids.indexOf(state.fileId) - 1 + ids.length) % ids.length];
        const nextFrames = framesByFile.get(nextFile) ?? [];
        const clampedIndex = Math.min(maxFrameIndexVisited, Math.max(0, nextFrames.length - 1));
        state = { fileId: nextFile, frameIndex: clampedIndex };
        maxFrameIndexVisited = Math.max(maxFrameIndexVisited, clampedIndex);
        return;
      }

      if (ev.key === 'ArrowRight') {
        state = { fileId: state.fileId, frameIndex: (state.frameIndex + 1) % frames.length };
        maxFrameIndexVisited = Math.max(maxFrameIndexVisited, state.frameIndex);
      } else if (ev.key === 'ArrowLeft') {
        state = { fileId: state.fileId, frameIndex: (state.frameIndex - 1 + frames.length) % frames.length };
        maxFrameIndexVisited = Math.max(maxFrameIndexVisited, state.frameIndex);
      }
    },
  };
}
