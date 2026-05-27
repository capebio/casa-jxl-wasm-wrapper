export function formatLoadProgress({ loadedCount, totalCount }) {
    return `Loaded ${loadedCount}/${totalCount} files...`;
}

export function formatLoadFileStatus({ currentIndex, totalCount, fileName }) {
    return `Loading ${currentIndex}/${totalCount}: ${fileName}`;
}

export function formatBenchmarkProgress({ percent, size, quality, effort, completedFiles, totalFiles }) {
    return `${percent}% - ${size}px q=${quality} e=${effort} (files ${completedFiles}/${totalFiles})`;
}

export function formatBenchmarkFileStatus({ completedFiles, totalFiles, fileName }) {
    return `Files ${completedFiles}/${totalFiles} complete - ${fileName}`;
}
