import type { TransportResponse } from './transport';
import type {
  ErrorClassification,
  SnapshotLastError,
  TrackErrorsOption,
  UploadErrorCode,
} from './types';
import { DEFAULT_TRACKED_ERRORS } from './types';

export interface UploadErrorOptions {
  snapshotId?: string;
  response?: TransportResponse;
  chunkIndex?: number;
  classification?: ErrorClassification;
  cause?: unknown;
}

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly snapshotId?: string;
  readonly response?: TransportResponse;
  readonly chunkIndex?: number;
  readonly classification?: ErrorClassification;

  constructor(code: UploadErrorCode, message: string, options: UploadErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UploadError';
    this.code = code;
    if (options.snapshotId !== undefined) this.snapshotId = options.snapshotId;
    if (options.response !== undefined) this.response = options.response;
    if (options.chunkIndex !== undefined) this.chunkIndex = options.chunkIndex;
    if (options.classification !== undefined) this.classification = options.classification;
  }
}

export function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === 'AbortError' || e.name === 'CanceledError') return true;
  if (e.code === 'ERR_CANCELED') return true;
  return false;
}

export function classifyTransportError(err: unknown): ErrorClassification {
  if (isAbortError(err)) return 'abort';

  if (err !== null && typeof err === 'object') {
    const e = err as { name?: unknown; code?: unknown };

    if (e.name === 'TimeoutError') return 'timeout';
    if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return 'timeout';

    const isNetworkLike =
      e.code === 'ERR_NETWORK' ||
      e.name === 'TypeError' ||
      err instanceof TypeError;

    if (isNetworkLike) {
      const onLine =
        typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
          ? navigator.onLine
          : true;
      return onLine ? 'cors' : 'network';
    }
  }

  return 'network';
}

export function shouldTrackError(
  classification: ErrorClassification | undefined,
  trackErrors: TrackErrorsOption | undefined,
): boolean {
  if (classification === undefined) return false;

  if (trackErrors === 'all') return true;
  if (classification === 'abort') return false;

  if (trackErrors === undefined) {
    return DEFAULT_TRACKED_ERRORS.includes(
      classification as number | 'network' | 'cors' | 'timeout',
    );
  }

  if (classification === 'network' || classification === 'cors') return true;

  return trackErrors.includes(classification as number | 'network' | 'cors' | 'timeout');
}

export function uploadErrorFromResponse(
  fallbackCode: UploadErrorCode,
  response: TransportResponse,
  context: { snapshotId?: string; chunkIndex?: number } = {},
): UploadError {
  let code: UploadErrorCode = fallbackCode;
  let message = `${response.status} ${response.statusText || 'Error'}`;

  const data = response.data as { error?: { code?: string; message?: string } } | null | undefined;
  if (data?.error) {
    if (data.error.code) code = data.error.code as UploadErrorCode;
    if (data.error.message) message = data.error.message;
  }

  return new UploadError(code, message, {
    response,
    classification: response.status,
    ...context,
  });
}

export function toUploadError(err: unknown, snapshotId?: string): UploadError {
  if (err instanceof UploadError) {
    const classification: ErrorClassification | undefined =
      err.classification ?? (err.response ? err.response.status : classifyTransportError(err.cause));
    return new UploadError(err.code, err.message, {
      snapshotId,
      response: err.response,
      chunkIndex: err.chunkIndex,
      classification,
      cause: err,
    });
  }

  const classification = classifyTransportError(err);
  const code: UploadErrorCode = classification === 'abort' ? 'aborted' : 'target_failed';
  return new UploadError(code, String((err as Error)?.message ?? err), {
    snapshotId,
    classification,
    cause: err,
  });
}

export function lastErrorFromUploadError(error: UploadError): SnapshotLastError {
  return {
    code: error.code,
    message: error.message,
    ...(error.response !== undefined ? { httpStatus: error.response.status } : {}),
  };
}
