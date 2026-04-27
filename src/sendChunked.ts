import { createProgressFlusher } from './progressFlusher';
import {
  readSnapshotUploadProgress,
  recordSnapshotUploadProgress,
} from './storage';
import { type Transport, type TransportResponse } from './transport';
import {
  checkSession,
  completeSession,
  startSession,
  uploadChunks,
  type SessionStatus,
  type UploaderOptions,
} from './uploader';
import type { Profiler } from './profiler';
import type { StartRequestBody } from './types';

export interface ChunkedSendOptions {
  chunkSize: number;
  concurrency: number;
  retries: number;
  retryDelay: number;
  prefix: string;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
  transport: Transport;
  profiler: Profiler;
}

export async function sendDirect<T>(
  url: string,
  method: string,
  userHeaders: Record<string, string>,
  blob: Blob,
  contentType: string,
  options: ChunkedSendOptions,
): Promise<TransportResponse<T>> {
  return options.transport.request<T>({
    url,
    method,
    headers: { ...userHeaders, 'Content-Type': contentType },
    body: blob,
    signal: options.signal,
    onUploadProgress: options.onProgress,
  });
}

export async function sendChunked<T>(
  url: string,
  method: string,
  userHeaders: Record<string, string>,
  chunks: Blob[],
  totalBytes: number,
  contentType: string,
  fullChecksum: string,
  options: ChunkedSendOptions,
  snapshotId: string | undefined,
): Promise<TransportResponse<T>> {
  const startBody: StartRequestBody = {
    targetUrl: url,
    method,
    contentType,
    totalBytes,
    totalChunks: chunks.length,
    chunkSize: options.chunkSize,
    checksum: fullChecksum,
    headers: userHeaders,
  };

  const baseUploaderOptions: UploaderOptions = {
    prefix: options.prefix,
    concurrency: options.concurrency,
    retries: options.retries,
    retryDelay: options.retryDelay,
    signal: options.signal,
    transport: options.transport,
    profiler: options.profiler,
  };

  const { uploadId, resumed } = await resolveUploadSession(
    snapshotId,
    chunks.length,
    options.chunkSize,
    startBody,
    baseUploaderOptions,
  );

  const uploadedSet = new Set<number>(resumed);
  const skippedBytes = sumSkippedBytes(chunks, uploadedSet);
  let sentBytes = skippedBytes;

  if (snapshotId !== undefined) {
    await recordSnapshotUploadProgress(snapshotId, {
      uploadId,
      totalChunks: chunks.length,
      chunkSize: options.chunkSize,
      fullChecksum,
      uploadedChunkIndices: Array.from(uploadedSet).sort((a, b) => a - b),
    });
  }

  if (options.onProgress && skippedBytes > 0) {
    options.onProgress(skippedBytes, totalBytes);
  }

  const flusher = snapshotId !== undefined
    ? createProgressFlusher(snapshotId, uploadedSet)
    : undefined;

  const onChunkUploaded = (bytes: number, index: number): void => {
    if (uploadedSet.has(index)) return;
    uploadedSet.add(index);
    sentBytes += bytes;
    options.onProgress?.(sentBytes, totalBytes);
    flusher?.schedule();
  };

  const uploaderOptions: UploaderOptions = {
    ...baseUploaderOptions,
    onChunkUploaded,
    skipIndices: uploadedSet.size > 0 ? new Set(uploadedSet) : undefined,
  };

  try {
    await uploadChunks(uploadId, chunks, uploaderOptions);
    await flusher?.flush();
    return (await completeSession(uploadId, baseUploaderOptions)) as TransportResponse<T>;
  } catch (err) {
    await flusher?.flush();
    throw err;
  }
}

async function resolveUploadSession(
  snapshotId: string | undefined,
  totalChunks: number,
  chunkSize: number,
  startBody: StartRequestBody,
  uploaderOptions: UploaderOptions,
): Promise<{ uploadId: string; resumed: number[] }> {
  const resumed = await tryResume(snapshotId, totalChunks, chunkSize, uploaderOptions);
  if (resumed !== null) return resumed;

  const { uploadId } = await startSession(startBody, uploaderOptions);
  return { uploadId, resumed: [] };
}

async function tryResume(
  snapshotId: string | undefined,
  totalChunks: number,
  chunkSize: number,
  uploaderOptions: UploaderOptions,
): Promise<{ uploadId: string; resumed: number[] } | null> {
  if (snapshotId === undefined) return null;

  const prior = await readSnapshotUploadProgress(snapshotId);
  if (
    !prior?.uploadId ||
    prior.totalChunks !== totalChunks ||
    prior.chunkSize !== chunkSize
  ) {
    return null;
  }

  const status: SessionStatus = await checkSession(prior.uploadId, uploaderOptions).catch(
    () => ({ alive: false }),
  );
  if (!status.alive) return null;

  return {
    uploadId: prior.uploadId,
    resumed: status.uploadedChunks ?? prior.uploadedChunkIndices ?? [],
  };
}

function sumSkippedBytes(chunks: Blob[], skip: ReadonlySet<number>): number {
  let total = 0;
  for (const i of skip) {
    if (i >= 0 && i < chunks.length) total += chunks[i]!.size;
  }
  return total;
}
