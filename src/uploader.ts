import { classifyTransportError, UploadError, uploadErrorFromResponse } from './errors';
import { uploadChunkWithRetry, type ChunkRequestOptions } from './chunkUploader';
import { Profiler } from './profiler';
import type { Transport, TransportResponse } from './transport';
import { isTransportOk } from './transport';
import type { StartRequestBody, StartResponseBody } from './types';
import { joinUrl, VERSION_HEADER, WIRE_VERSION } from './uploaderProtocol';

export { VERSION_HEADER, WIRE_VERSION };

export interface UploaderOptions extends ChunkRequestOptions {
  concurrency: number;
  onChunkUploaded?: (bytes: number, index: number) => void;
  skipIndices?: ReadonlySet<number>;
  profiler?: Profiler;
}

export interface SessionStatus {
  alive: boolean;
  uploadedChunks?: number[];
  totalChunks?: number;
  expiresAt?: string;
}

export async function checkSession(
  uploadId: string,
  options: UploaderOptions,
): Promise<SessionStatus> {
  const response = await options.transport.request<SessionStatus>({
    url: joinUrl(options.prefix, '/status/' + encodeURIComponent(uploadId)),
    method: 'GET',
    headers: {
      Accept: 'application/json',
      [VERSION_HEADER]: WIRE_VERSION,
    },
    body: null,
    signal: options.signal,
    responseType: 'json',
  });

  if (!isTransportOk(response) || !response.data) return { alive: false };
  return response.data;
}

export async function startSession(
  body: StartRequestBody,
  options: UploaderOptions,
): Promise<StartResponseBody> {
  options.profiler?.start('start');
  let response: TransportResponse<StartResponseBody>;
  try {
    response = await options.transport.request<StartResponseBody>({
      url: joinUrl(options.prefix, '/start'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [VERSION_HEADER]: WIRE_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal,
      responseType: 'json',
    });
  } finally {
    options.profiler?.end('start', { totalBytes: body.totalBytes, totalChunks: body.totalChunks });
  }

  if (!isTransportOk(response)) {
    throw uploadErrorFromResponse('start_failed', response);
  }

  if (response.data?.uploadId) {
    options.profiler?.setUploadId(response.data.uploadId);
  }

  return response.data;
}

export async function uploadChunks(
  uploadId: string,
  chunks: Blob[],
  options: UploaderOptions,
): Promise<void> {
  if (chunks.length === 0) return;

  options.profiler?.start('total.upload');

  const totalBytes = chunks.reduce((sum, c) => sum + c.size, 0);
  const workerCount = Math.max(1, Math.min(options.concurrency, chunks.length));
  let cursor = 0;
  let firstError: unknown = null;

  const worker = async (): Promise<void> => {
    while (firstError === null) {
      if (options.signal?.aborted) {
        firstError = new UploadError('aborted', 'Upload aborted', { classification: 'abort' });
        return;
      }
      const i = cursor++;
      if (i >= chunks.length) return;
      if (options.skipIndices?.has(i)) {
        options.onChunkUploaded?.(chunks[i]!.size, i);
        continue;
      }
      try {
        await runChunk(uploadId, i, chunks[i]!, options);
        options.onChunkUploaded?.(chunks[i]!.size, i);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    options.profiler?.end('total.upload', {
      uploadId,
      totalChunks: chunks.length,
      sizeBytes: totalBytes,
      concurrency: workerCount,
      outcome: firstError === null ? 'ok' : 'failed',
    });
  }

  if (firstError !== null) {
    if (firstError instanceof UploadError) throw firstError;
    throw new UploadError('chunk_failed', String((firstError as Error)?.message ?? firstError), {
      cause: firstError,
      classification: classifyTransportError(firstError),
    });
  }
}

export async function completeSession(
  uploadId: string,
  options: UploaderOptions,
): Promise<TransportResponse> {
  options.profiler?.start('complete.duration');
  let status: number | undefined;
  let outcome: 'ok' | 'failed' = 'failed';
  try {
    const response = await options.transport.request({
      url: joinUrl(options.prefix, '/complete'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [VERSION_HEADER]: WIRE_VERSION,
      },
      body: JSON.stringify({ uploadId }),
      signal: options.signal,
    });
    status = response.status;
    outcome = isTransportOk(response) ? 'ok' : 'failed';
    return response;
  } finally {
    options.profiler?.end('complete.duration', { uploadId, status, outcome });
  }
}

async function runChunk(
  uploadId: string,
  index: number,
  chunk: Blob,
  options: UploaderOptions,
): Promise<void> {
  const phase = 'chunk.upload';
  const trackKey = `${phase}#${index}`;
  options.profiler?.start(phase, trackKey);

  let outcome: 'ok' | 'duplicate' | 'failed' | 'aborted' = 'failed';
  let attempts = 0;
  let status: number | undefined;

  try {
    const report = await uploadChunkWithRetry(uploadId, index, chunk, options);
    outcome = report.outcome;
    attempts = report.attempts;
    status = report.status;
  } catch (err) {
    if (err instanceof UploadError && err.code === 'aborted') outcome = 'aborted';
    throw err;
  } finally {
    options.profiler?.end(
      phase,
      { uploadId, chunkIndex: index, sizeBytes: chunk.size, attempts, status, outcome },
      trackKey,
    );
  }
}
