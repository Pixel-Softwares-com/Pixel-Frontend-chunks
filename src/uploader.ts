import { sha256Hex } from './checksum';
import { UploadError } from './errors';
import type { StartRequestBody, StartResponseBody, UploadErrorCode } from './types';

export const WIRE_VERSION = '1';
export const VERSION_HEADER = 'X-Pixel-Request-Chunks-Version';

export interface UploaderOptions {
  prefix: string;
  concurrency: number;
  retries: number;
  retryDelay: number;
  signal?: AbortSignal;
  onChunkUploaded?: (bytes: number) => void;
}

export async function startSession(
  body: StartRequestBody,
  options: UploaderOptions,
): Promise<StartResponseBody> {
  const response = await fetch(joinUrl(options.prefix, '/start'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      [VERSION_HEADER]: WIRE_VERSION,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    throw await errorFromResponse('start_failed', response);
  }

  return (await response.json()) as StartResponseBody;
}

export async function uploadChunks(
  uploadId: string,
  chunks: Blob[],
  options: UploaderOptions,
): Promise<void> {
  const total = chunks.length;
  if (total === 0) return;

  let cursor = 0;
  let firstError: unknown = null;

  const worker = async (): Promise<void> => {
    while (firstError === null) {
      if (options.signal?.aborted) {
        firstError = new UploadError('aborted', 'Upload aborted');
        return;
      }
      const i = cursor++;
      if (i >= total) return;
      try {
        await uploadOneChunkWithRetry(uploadId, i, chunks[i]!, options);
        options.onChunkUploaded?.(chunks[i]!.size);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (firstError !== null) {
    if (firstError instanceof UploadError) throw firstError;
    throw new UploadError('chunk_failed', String((firstError as Error)?.message ?? firstError), {
      cause: firstError,
    });
  }
}

async function uploadOneChunkWithRetry(
  uploadId: string,
  index: number,
  chunk: Blob,
  options: UploaderOptions,
): Promise<void> {
  const checksum = await sha256Hex(chunk);
  let attempt = 0;
  let delay = options.retryDelay;

  while (true) {
    if (options.signal?.aborted) {
      throw new UploadError('aborted', 'Upload aborted', { chunkIndex: index });
    }

    let response: Response | null = null;
    let networkError: unknown = null;

    try {
      const form = new FormData();
      form.append('uploadId', uploadId);
      form.append('chunkIndex', String(index));
      form.append('chunkChecksum', checksum);
      form.append('chunk', chunk, `chunk_${index}`);

      response = await fetch(joinUrl(options.prefix, '/chunk'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          [VERSION_HEADER]: WIRE_VERSION,
        },
        body: form,
        signal: options.signal,
      });
    } catch (err) {
      networkError = err;
    }

    if (response !== null) {
      // 200 = accepted, 409 = idempotent duplicate (already received) — both success.
      if (response.ok || response.status === 409) return;

      const isRetryable =
        response.status >= 500 || response.status === 408 || response.status === 429;

      if (!isRetryable || attempt >= options.retries) {
        throw await errorFromResponse('chunk_failed', response, index);
      }
    } else if (networkError !== null) {
      if (attempt >= options.retries) {
        throw new UploadError(
          'chunk_failed',
          `Chunk ${index} failed after ${options.retries} retries`,
          { chunkIndex: index, cause: networkError },
        );
      }
    }

    await sleep(delay);
    delay *= 2;
    attempt++;
  }
}

export async function completeSession(
  uploadId: string,
  options: UploaderOptions,
): Promise<Response> {
  return fetch(joinUrl(options.prefix, '/complete'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [VERSION_HEADER]: WIRE_VERSION,
    },
    body: JSON.stringify({ uploadId }),
    signal: options.signal,
  });
}

function joinUrl(prefix: string, path: string): string {
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return trimmed + path;
}

async function errorFromResponse(
  fallbackCode: UploadErrorCode,
  response: Response,
  chunkIndex?: number,
): Promise<UploadError> {
  let code: UploadErrorCode = fallbackCode;
  let message = `${response.status} ${response.statusText || 'Error'}`;
  try {
    const cloned = response.clone();
    const data = (await cloned.json()) as { error?: { code?: string; message?: string } };
    if (data?.error?.code) code = data.error.code as UploadErrorCode;
    if (data?.error?.message) message = data.error.message;
  } catch {
    // body not JSON or unreadable — keep fallback
  }
  return new UploadError(code, message, chunkIndex !== undefined ? { response, chunkIndex } : { response });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
