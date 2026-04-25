import { sha256Hex } from './checksum';
import { sliceBlob } from './chunker';
import { UploadError } from './errors';
import { serialize } from './serialize';
import { createSnapshot, deletePendingForm, recordSnapshotError } from './storage';
import { completeSession, startSession, uploadChunks, type UploaderOptions } from './uploader';
import type { SendData, SendOptions, SnapshotLastError, StartRequestBody, UploadErrorCode } from './types';

export const DEFAULTS = {
  chunkSize: 1024 * 1024,
  chunkThresholdBytes: 2 * 1024 * 1024,
  maxFormDataEntries: 5000,
  concurrency: 3,
  retries: 3,
  retryDelay: 1000,
  prefix: '/chunk-transport',
  saveSnapshot: true,
  snapshotTTL: 24 * 60 * 60 * 1000,
} as const;

export interface ChunkDecisionInput {
  chunkThresholdBytes: number;
  maxFormDataEntries: number;
}

interface ResolvedSendOptions extends ChunkDecisionInput {
  chunkSize: number;
  concurrency: number;
  retries: number;
  retryDelay: number;
  prefix: string;
  saveSnapshot: boolean;
  snapshotTTL: number;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

export function shouldChunk(
  totalBytes: number,
  formDataEntryCount: number | null,
  options: ChunkDecisionInput,
): boolean {
  if (totalBytes > options.chunkThresholdBytes) return true;
  if (formDataEntryCount !== null && formDataEntryCount > options.maxFormDataEntries) return true;
  return false;
}

export async function send(
  url: string,
  data: SendData,
  options: SendOptions = {},
): Promise<Response> {
  const merged: ResolvedSendOptions = { ...DEFAULTS, ...options };
  const method = options.method ?? 'POST';
  const userHeaders = options.headers ?? {};

  const { blob, contentType, formDataEntryCount } = await serialize(data);
  const snapshotId = merged.saveSnapshot
    ? await createSnapshot({
        targetUrl: url,
        method,
        headers: userHeaders,
        contentType,
        data,
        ttlMs: merged.snapshotTTL,
      })
    : undefined;

  try {
    const response = !shouldChunk(blob.size, formDataEntryCount, merged)
      ? await fetch(url, {
          method,
          headers: {
            ...userHeaders,
            'Content-Type': contentType,
          },
          body: blob,
          signal: options.signal,
        })
      : await sendChunked(url, method, userHeaders, blob, contentType, merged);

    return finalizeResponse(response, snapshotId);
  } catch (err) {
    throw await preserveSnapshotOnError(err, snapshotId);
  }
}

async function sendChunked(
  url: string,
  method: string,
  userHeaders: Record<string, string>,
  blob: Blob,
  contentType: string,
  options: ResolvedSendOptions,
): Promise<Response> {
  const chunks = sliceBlob(blob, options.chunkSize);
  const fullChecksum = await sha256Hex(blob);

  const startBody: StartRequestBody = {
    targetUrl: url,
    method,
    contentType,
    totalBytes: blob.size,
    totalChunks: chunks.length,
    chunkSize: options.chunkSize,
    checksum: fullChecksum,
    headers: userHeaders,
  };

  let sentBytes = 0;
  const onProgress = options.onProgress;
  const onChunkUploaded = onProgress
    ? (bytes: number) => {
        sentBytes += bytes;
        onProgress(sentBytes, blob.size);
      }
    : undefined;

  const uploaderOptions: UploaderOptions = {
    prefix: options.prefix,
    concurrency: options.concurrency,
    retries: options.retries,
    retryDelay: options.retryDelay,
    signal: options.signal,
    onChunkUploaded,
  };

  const { uploadId } = await startSession(startBody, uploaderOptions);
  await uploadChunks(uploadId, chunks, uploaderOptions);
  return completeSession(uploadId, uploaderOptions);
}

async function finalizeResponse(response: Response, snapshotId: string | undefined): Promise<Response> {
  if (response.ok) {
    if (snapshotId !== undefined) await deletePendingForm(snapshotId);
    return response;
  }

  const error = await errorFromResponse(response, snapshotId);
  if (snapshotId !== undefined) {
    await recordSnapshotError(snapshotId, lastErrorFromUploadError(error));
  }

  throw error;
}

async function preserveSnapshotOnError(err: unknown, snapshotId: string | undefined): Promise<Error> {
  const error = toUploadError(err, snapshotId);
  if (snapshotId !== undefined) {
    await recordSnapshotError(snapshotId, lastErrorFromUploadError(error));
  }

  return error;
}

async function errorFromResponse(
  response: Response,
  snapshotId: string | undefined,
): Promise<UploadError> {
  let code: UploadErrorCode = 'target_failed';
  let message = `${response.status} ${response.statusText || 'Error'}`;

  try {
    const data = (await response.clone().json()) as { error?: { code?: string; message?: string } };
    if (data?.error?.code) code = data.error.code as UploadErrorCode;
    if (data?.error?.message) message = data.error.message;
  } catch {
    // Non-JSON target responses still preserve the snapshot with a generic target failure.
  }

  return new UploadError(code, message, { response, snapshotId });
}

function toUploadError(err: unknown, snapshotId: string | undefined): UploadError {
  if (err instanceof UploadError) {
    return new UploadError(err.code, err.message, {
      snapshotId,
      response: err.response,
      chunkIndex: err.chunkIndex,
      cause: err,
    });
  }

  return new UploadError('target_failed', String((err as Error)?.message ?? err), {
    snapshotId,
    cause: err,
  });
}

function lastErrorFromUploadError(error: UploadError): SnapshotLastError {
  return {
    code: error.code,
    message: error.message,
    ...(error.response !== undefined ? { httpStatus: error.response.status } : {}),
  };
}
