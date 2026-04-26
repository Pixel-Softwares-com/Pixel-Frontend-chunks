import { sha256Hex } from './checksum';
import { classifyTransportError, UploadError, uploadErrorFromResponse } from './errors';
import type { Transport, TransportResponse } from './transport';
import { isTransportOk } from './transport';
import { VERSION_HEADER, WIRE_VERSION } from './uploaderProtocol';

export interface ChunkRequestOptions {
  prefix: string;
  retries: number;
  retryDelay: number;
  signal?: AbortSignal;
  transport: Transport;
}

type Terminal = 'ok' | 'duplicate';

type AttemptResult =
  | { kind: 'success'; outcome: Terminal; status: number }
  | { kind: 'fatal'; error: UploadError; status?: number }
  | { kind: 'retry'; error: UploadError; status?: number };

export interface ChunkUploadReport {
  outcome: Terminal;
  attempts: number;
  status?: number;
}

/**
 * Upload one chunk with exponential-backoff retries. Throws UploadError on
 * unrecoverable failures (including aborts). Returns a report describing
 * the outcome — used by the caller for profiling.
 */
export async function uploadChunkWithRetry(
  uploadId: string,
  index: number,
  chunk: Blob,
  options: ChunkRequestOptions,
): Promise<ChunkUploadReport> {
  const checksum = await sha256Hex(chunk);
  let delay = options.retryDelay;

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw abortError(index);

    const result = await attemptOnce(uploadId, index, chunk, checksum, options);

    if (result.kind === 'success') {
      return { outcome: result.outcome, attempts: attempt + 1, status: result.status };
    }
    if (result.kind === 'fatal' || attempt >= options.retries) {
      throw result.error;
    }

    await sleep(delay);
    delay *= 2;
  }
}

async function attemptOnce(
  uploadId: string,
  index: number,
  chunk: Blob,
  checksum: string,
  options: ChunkRequestOptions,
): Promise<AttemptResult> {
  try {
    const response = await options.transport.request({
      url: joinUrl(options.prefix, '/chunk'),
      method: 'POST',
      headers: {
        Accept: 'application/json',
        [VERSION_HEADER]: WIRE_VERSION,
      },
      body: buildForm(uploadId, index, chunk, checksum),
      signal: options.signal,
      responseType: 'json',
    });
    return classifyResponse(response, index);
  } catch (err) {
    return classifyNetworkError(err, index, options.retries);
  }
}

function classifyResponse(response: TransportResponse, index: number): AttemptResult {
  if (isTransportOk(response)) {
    return { kind: 'success', outcome: 'ok', status: response.status };
  }
  if (response.status === 409) {
    return { kind: 'success', outcome: 'duplicate', status: response.status };
  }

  const isRetryable =
    response.status >= 500 || response.status === 408 || response.status === 429;
  const error = uploadErrorFromResponse('chunk_failed', response, { chunkIndex: index });

  return {
    kind: isRetryable ? 'retry' : 'fatal',
    error,
    status: response.status,
  };
}

function classifyNetworkError(err: unknown, index: number, retries: number): AttemptResult {
  const classification = classifyTransportError(err);
  if (classification === 'abort') {
    return {
      kind: 'fatal',
      error: new UploadError('aborted', 'Upload aborted', {
        chunkIndex: index,
        classification: 'abort',
        cause: err,
      }),
    };
  }
  return {
    kind: 'retry',
    error: new UploadError(
      'chunk_failed',
      `Chunk ${index} failed after ${retries} retries`,
      { chunkIndex: index, cause: err, classification },
    ),
  };
}

function abortError(index: number): UploadError {
  return new UploadError('aborted', 'Upload aborted', {
    chunkIndex: index,
    classification: 'abort',
  });
}

function buildForm(uploadId: string, index: number, chunk: Blob, checksum: string): FormData {
  const form = new FormData();
  form.append('uploadId', uploadId);
  form.append('chunkIndex', String(index));
  form.append('chunkChecksum', checksum);
  form.append('chunk', chunk, `chunk_${index}`);
  return form;
}

function joinUrl(prefix: string, path: string): string {
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return trimmed + path;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
