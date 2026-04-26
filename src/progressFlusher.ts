import { recordSnapshotUploadProgress } from './storage';

const FLUSH_AFTER_CHUNKS = 5;
const FLUSH_AFTER_MS = 500;

export interface ProgressFlusher {
  schedule(): void;
  flush(): Promise<void>;
}

/**
 * Buffers uploaded-chunk-index writes to the snapshot store so we don't hit
 * IndexedDB on every chunk. Flushes after FLUSH_AFTER_CHUNKS new chunks or
 * FLUSH_AFTER_MS, whichever comes first.
 */
export function createProgressFlusher(
  snapshotId: string,
  uploadedSet: Set<number>,
): ProgressFlusher {
  let pending = 0;
  let lastWriteAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const writeNow = (): void => {
    pending = 0;
    lastWriteAt = Date.now();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const indices = Array.from(uploadedSet).sort((a, b) => a - b);
    writing = writing
      .then(() => recordSnapshotUploadProgress(snapshotId, { uploadedChunkIndices: indices }))
      .catch(() => undefined);
  };

  return {
    schedule() {
      pending++;
      const elapsed = Date.now() - lastWriteAt;
      if (pending >= FLUSH_AFTER_CHUNKS || elapsed >= FLUSH_AFTER_MS) {
        writeNow();
        return;
      }
      if (timer === null) {
        timer = setTimeout(writeNow, FLUSH_AFTER_MS - elapsed);
      }
    },
    async flush() {
      if (pending > 0 || timer !== null) writeNow();
      await writing;
    },
  };
}
