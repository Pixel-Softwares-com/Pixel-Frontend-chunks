import { sha256Hex } from './checksum';
import { sliceBlob } from './chunker';
import { Profiler } from './profiler';
import { resolveUrl } from './resolveUrl';
import { sendChunked, sendDirect, type ChunkedSendOptions } from './sendChunked';
import { serialize } from './serialize';
import { createSnapshot, readSnapshotBlob, restoreForm } from './storage';
import { finalizeResponse, preserveSnapshotOnError } from './snapshotOutcome';
import { createFetchTransport } from './transports/fetch';
import { type Transport, type TransportResponse } from './transport';
import type { SendData, SendOptions } from './types';

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

interface ResolvedSend extends SendOptions {
  chunkSize: number;
  chunkThresholdBytes: number;
  maxFormDataEntries: number;
  concurrency: number;
  retries: number;
  retryDelay: number;
  prefix: string;
  saveSnapshot: boolean;
  snapshotTTL: number;
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

  const merged: ResolvedSend = { ...DEFAULTS, ...options };
  const method = options.method ?? 'POST';
  const userHeaders = options.headers ?? {};
  const resolvedUrl = resolveUrl(url, options.baseUrl);

  profiler.start('total');
  let outcome: 'ok' | 'failed' = 'failed';

  const { blob, contentType, formDataEntryCount } = await resolvePayload(
    data,
    merged.resumeSnapshotId,
  );
  const chunks = sliceBlob(blob, merged.chunkSize);
  const fullChecksum = await sha256Hex(blob);

  const snapshotId = await ensureSnapshot(
    merged,
    resolvedUrl,
    method,
    userHeaders,
    contentType,
    chunks,
    blob.size,
    fullChecksum,
  );

  const chunked: ChunkedSendOptions = {
    chunkSize: merged.chunkSize,
    concurrency: merged.concurrency,
    retries: merged.retries,
    retryDelay: merged.retryDelay,
    prefix: merged.prefix,
    signal: options.signal,
    onProgress: options.onProgress,
    transport: options.transport ?? getDefaultTransport(),
    profiler,
  };

  try {
    const response = merged.useChunk === false || !shouldChunk(blob.size, formDataEntryCount, merged)
      ? await sendDirect<T>(resolvedUrl, method, userHeaders, blob, contentType, chunked)
      : await sendChunked<T>(
          resolvedUrl,
          method,
          userHeaders,
          chunks,
          blob.size,
          contentType,
          fullChecksum,
          chunked,
          snapshotId,
        );

    const finalized = await finalizeResponse(response, snapshotId, options.trackErrors);
    outcome = 'ok';
    return finalized;
  } catch (err) {
    throw await preserveSnapshotOnError(err, snapshotId, options.trackErrors);
  } finally {
    profiler.end('total', { sizeBytes: blob.size, outcome });
    profiler.flush();
  }
}

async function resolvePayload(
  data: SendData,
  resumeSnapshotId: string | undefined,
): Promise<{ blob: Blob; contentType: string; formDataEntryCount: number | null }> {
  if (resumeSnapshotId) {
    const [blob, form] = await Promise.all([
      readSnapshotBlob(resumeSnapshotId),
      restoreForm(resumeSnapshotId),
    ]);
    if (blob && form) {
      return { blob, contentType: form.contentType, formDataEntryCount: null };
    }
  }
  return serialize(data);
}

async function ensureSnapshot(
  merged: ResolvedSend,
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  contentType: string,
  chunks: Blob[],
  totalBytes: number,
  fullChecksum: string,
): Promise<string | undefined> {
  if (merged.resumeSnapshotId) return merged.resumeSnapshotId;
  if (!merged.saveSnapshot) return undefined;

  return createSnapshot({
    targetUrl,
    method,
    headers,
    contentType,
    chunks,
    chunkSize: merged.chunkSize,
    totalBytes,
    fullChecksum,
    ttlMs: merged.snapshotTTL,
  });
}
