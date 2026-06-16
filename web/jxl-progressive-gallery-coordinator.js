export function createGalleryCoordinator({ files }) {
  const series = new Map();

  for (const file of files) {
    series.set(file.fileId, {
      file,
      frames: [],
      closed: false,
    });
  }

  let visibleCountCache = 0;
  let dirty = true;

  function getVisibleCount() {
    if (!dirty) return visibleCountCache;
    const entries = [...series.values()];
    
    // Get non-closed files
    const nonClosedFiles = entries.filter((entry) => !entry.closed);
    
    // Get closed files
    const closedFiles = entries.filter((entry) => entry.closed);
    
    let next;
    if (nonClosedFiles.length > 0) {
      // If there are non-closed files, cap at the minimum frame count across all non-closed files
      // But only if multiple files exist and they differ, otherwise show first frame
      const frameCounts = nonClosedFiles.map((e) => e.frames.length);
      const minFrames = Math.min(...frameCounts);
      
      // Cap at the slowest open file. When minFrames=0 we still return 1 so that
      // faster files expose their first frame — slice(0,1) on an empty frames array
      // produces [] via filter(Boolean), keeping the UI consistent.
      next = minFrames > 0 ? minFrames : 1;
    } else if (closedFiles.length > 0) {
      // If all files are closed, show all available frames
      const maxFrames = Math.max(...closedFiles.map((e) => e.frames.length));
      next = maxFrames;
    } else {
      next = 0;
    }
    visibleCountCache = next;
    dirty = false;
    return visibleCountCache;
  }

  function markDirty() { dirty = true; }

  return {
    registerFrame(fileId, frame) {
      const entry = series.get(fileId);
      if (!entry) return;
      entry.frames[frame.frameIndex] = frame;
      markDirty();
    },
    markFileClosed(fileId) {
      const entry = series.get(fileId);
      if (!entry) return;
      entry.closed = true;
      markDirty();
    },
    visibleFrames(fileId) {
      const entry = series.get(fileId);
      if (!entry) return [];
      const visibleCount = getVisibleCount();
      return entry.frames.slice(0, visibleCount).filter(Boolean);
    },
    nextFrameIndex(fileId, currentIndex) {
      const entry = series.get(fileId);
      if (!entry || entry.frames.length === 0) return 0;
      return (currentIndex + 1) % entry.frames.length;
    },
    prevFrameIndex(fileId, currentIndex) {
      const entry = series.get(fileId);
      if (!entry || entry.frames.length === 0) return 0;
      return (currentIndex - 1 + entry.frames.length) % entry.frames.length;
    },
    // Priority surface for concurrent stream / zoom-pan / AR focus (charter).
    // Returns current synced visible frontier per file as boost targets.
    getPriorityTargets() {
      const vis = getVisibleCount();
      return Array.from(series.entries()).map(([fileId, e]) => {
        const arrived = e.frames.length;
        const target = Math.max(0, Math.min(vis, arrived) - 1);
        return { fileId, frameIndex: target, reason: e.closed ? 'closed-max' : 'gallery-visible' };
      });
    },
    getFrame(fileId, index) {
      const entry = series.get(fileId);
      return entry ? entry.frames[index] : undefined;
    },
    hasFrame(fileId, index) {
      const entry = series.get(fileId);
      return !!(entry && entry.frames[index]);
    },
  };
}
