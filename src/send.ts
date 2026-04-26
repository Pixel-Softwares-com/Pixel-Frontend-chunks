import { sha256Hex } from './checksum';
import { sliceBlob } from './chunker';
import { UploadError } from './errors';
import { Profiler } from './profiler';
import { serialize } from './serialize';
import { createSnapshot, deletePendingForm, recordSnapshotError } from './storage';
import { createFetchTransport } from './transports/fetch';
import { isTransportOk, type Transport, type TransportResponse } from './transport';
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
  transport: Transport;
  profiler: Profiler;
}

let defaultTransport: Transport | null = null;

export function getDefaultTransport(): Transport {
  defaultTransport ??= createFetchTransport();
  return defaultTransport;
}

export function setDefaultTransport(transport: Transport | null): void {
  defaultTransport = transport;
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

export async function send<T = unknown>(
  url: string,
  data: SendData,
  options: SendOptions = {},
): Promise<TransportResponse<T>> {
  const profiler = new Profiler({
    enabled: Boolean(options.profile) || typeof options.onProfile === 'function',
    traceId: options.traceId,
    onProfile: options.onProfile,
    printTable: Boolean(options.profile) && typeof options.onProfile !== 'function',
  });

  const merged: ResolvedSendOptions = {
    ...DEFAULTS,
    ...options,
    transport: options.transport ?? getDefaultTransport(),
    profiler,
  };
  const method = options.method ?? 'POST';
  const userHeaders = options.headers ?? {};

  profiler.start('total');
  let outcome: 'ok' | 'failed' = 'failed';

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
      ? await sendDirect<T>(url, method, userHeaders, blob, contentType, merged)
      : await sendChunked<T>(url, method, userHeaders, blob, contentType, merged);

    const finalized = await finalizeResponse(response, snapshotId);
    outcome = 'ok';
    return finalized;
  } catch (err) {
    throw await preserveSnapshotOnError(err, snapshotId);
  } finally {
    profiler.end('total', { sizeBytes: blob.size, outcome });
    profiler.flush();
  }
}

async function sendDirect<T>(
  url: string,
  method: string,
  userHeaders: Record<string, string>,
  blob: Blob,
  contentType: string,
  options: ResolvedSendOptions,
): Promise<TransportResponse<T>> {
  return options.transport.request<T>({
    url,
    method,
    headers: {
      ...userHeaders,
      'Content-Type': contentType,
    },
    body: blob,
    signal: options.signal,
    onUploadProgress: options.onProgress,
  });
}

async function sendChunked<T>(
  url: string,
  method: string,
  userHeaders: Record<string, string>,
  blob: Blob,
  contentType: string,
  options: ResolvedSendOptions,
): Promise<TransportResponse<T>> {
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
    transport: options.transport,
    profiler: options.profiler,
  };

  const { uploadId } = await startSession(startBody, uploaderOptions);
  await uploadChunks(uploadId, chunks, uploaderOptions);
  return (await completeSession(uploadId, uploaderOptions)) as TransportResponse<T>;
}

async function finalizeResponse<T>(
  response: TransportResponse<T>,
  snapshotId: string | undefined,
): Promise<TransportResponse<T>> {
  if (isTransportOk(response)) {
    if (snapshotId !== undefined) await deletePendingForm(snapshotId);
    return response;
  }

  const error = errorFromResponse(response, snapshotId);
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

function errorFromResponse(
  response: TransportResponse,
  snapshotId: string | undefined,
): UploadError {
  let code: UploadErrorCode = 'target_failed';
  let message = `${response.status} ${response.statusText || 'Error'}`;

  const data = response.data as { error?: { code?: string; message?: string } } | null | undefined;
  if (data && typeof data === 'object' && data.error) {
    if (data.error.code) code = data.error.code as UploadErrorCode;
    if (data.error.message) message = data.error.message;
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
