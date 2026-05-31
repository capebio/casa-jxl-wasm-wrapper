/**
 * Shared File Picker for the Benchmark Suite
 *
 * Goals:
 * - Consistent behavior across all pages
 * - Supports single vs multiple files
 * - Drag & drop + click
 * - Optional memory: remembers last used files (metadata always, full bytes via IDB when requested)
 * - Easy integration with disabled state + workflow guidance
 *
 * Usage:
 *   const picker = createFilePicker({
 *     input: document.getElementById('source-input'),
 *     dropZone: document.getElementById('source-drop'),
 *     multiple: true,
 *     accept: '.orf,.ORF,.jxl',
 *     persistKey: 'jxl-preset-benchmark-files',   // enables memory
 *     onFiles: (files) => { ... }
 *   });
 *
 *   picker.setDisabled(true, "Load required first");
 */

const DB_NAME = 'jxl-file-picker-memory';
const DB_STORE = 'lastFiles';

let _dbPromise = null;

function openMemoryDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function saveLastFiles(key, files) {
  if (!key || !files?.length) return;
  try {
    const db = await openMemoryDb();
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);

    // Store metadata + actual bytes for the most recent selection
    const records = await Promise.all(files.map(async (f) => {
      const buf = await f.arrayBuffer();
      return {
        name: f.name,
        size: f.size,
        type: f.type,
        lastUsed: Date.now(),
        bytes: buf
      };
    }));

    store.put(records, key);
  } catch (e) {
    console.warn('[jxl-file-picker] Failed to persist files:', e);
  }
}

async function loadLastFiles(key) {
  if (!key) return null;
  try {
    const db = await openMemoryDb();
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const records = await new Promise(r => {
      const req = store.get(key);
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
    if (!records?.length) return null;

    // Reconstruct File objects
    return records.map(rec => {
      const blob = new Blob([rec.bytes], { type: rec.type || 'application/octet-stream' });
      return new File([blob], rec.name, { type: rec.type, lastModified: rec.lastUsed });
    });
  } catch (e) {
    console.warn('[jxl-file-picker] Failed to load persisted files:', e);
    return null;
  }
}

/**
 * Creates a unified file picker.
 */
export function createFilePicker({
  input,
  dropZone,
  multiple = false,
  accept = '',
  persistKey = null,
  onFiles = null,
  onError = null
} = {}) {
  if (!input) {
    console.error('[jxl-file-picker] input element is required');
    return null;
  }

  input.multiple = !!multiple;
  if (accept) input.accept = accept;

  let lastFiles = [];

  function notify(files) {
    lastFiles = files;
    if (typeof onFiles === 'function') {
      try { onFiles(files); } catch (e) { console.error(e); }
    }
    if (persistKey && files.length) {
      saveLastFiles(persistKey, files);
    }
  }

  async function handleFileList(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const filtered = accept
      ? files.filter(f => {
          const exts = accept.toLowerCase().split(',').map(s => s.trim().replace('*', ''));
          return exts.some(ext => f.name.toLowerCase().endsWith(ext.replace('.', '')) || f.type.includes(ext.replace('.', '')));
        })
      : files;

    if (!filtered.length) {
      const msg = `No supported files. Accepted: ${accept || 'any'}`;
      if (typeof onError === 'function') onError(msg);
      else alert(msg);
      return;
    }

    notify(filtered);
  }

  // Click / change
  input.addEventListener('change', (e) => {
    handleFileList(e.target.files);
    // Reset so the same file can be picked again
    input.value = '';
  });

  // Drag & drop
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList?.add('is-drop-target');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList?.remove('is-drop-target');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList?.remove('is-drop-target');
      handleFileList(e.dataTransfer.files);
    });

    // Make the drop zone trigger the input on click.
    // BUT: if the dropZone is a <label for="theInput">, the browser already opens
    // the dialog natively. Calling input.click() again causes the "opens straight back"
    // symptom the user reported. Detect and skip the synthetic click in that case.
    const isNativeLabel = dropZone.tagName === 'LABEL' &&
                          dropZone.getAttribute('for') === input.id;
    if (!isNativeLabel) {
      dropZone.addEventListener('click', (e) => {
        if (e.target !== input) {
          input.click();
        }
      });
    }
  }

  // Public API
  return {
    open() {
      input.click();
    },

    clear() {
      lastFiles = [];
      input.value = '';
    },

    getLastFiles() {
      return [...lastFiles];
    },

    async loadLastPersisted() {
      if (!persistKey) return [];
      const files = await loadLastFiles(persistKey);
      if (files?.length) {
        notify(files);
      }
      return files || [];
    },

    setDisabled(disabled, message = '') {
      input.disabled = !!disabled;
      if (dropZone) {
        if (disabled) {
          dropZone.style.pointerEvents = 'none';
          dropZone.style.opacity = '0.5';
          if (message) dropZone.title = message;
        } else {
          dropZone.style.pointerEvents = '';
          dropZone.style.opacity = '';
          dropZone.title = '';
        }
      }
    }
  };
}

// Convenience: attach to common patterns used in the suite
export function attachStandardPicker(config) {
  return createFilePicker(config);
}