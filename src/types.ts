import type { ProfileEntry } from './profiler';
import type { Transport } from './transport';

export type ErrorClassification = number | 'network' | 'cors' | 'timeout' | 'abort';

export type TrackErrorsOption = 'all' | Array<number | 'network' | 'cors' | 'timeout'>;

export const DEFAULT_TRACKED_ERRORS: ReadonlyArray<number | 'network' | 'cors' | 'timeout'> = [
  408,
  429,
  500,
  502,
  503,
  504,
  'network',
  'cors',
  'timeout',
];

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  signal?: AbortSignal;

  chunkSize?: number;
  chunkThresholdBytes?: number;
  maxFormDataEntries?: number;
  concurrency?: number;
  retries?: number;
  retryDelay?: number;

  prefix?: string;

  saveSnapshot?: boolean;
  snapshotTTL?: number;

  resumeSnapshotId?: string;

  trackErrors?: TrackErrorsOption;

  onProgress?: (sent: number, total: number) => void;

  transport?: Transport;

  profile?: boolean;
  onProfile?: (entries: ProfileEntry[]) => void;
  traceId?: string;
}

export type SendData =
  | FormData
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | string
  | Record<string, unknown>
  | unknown[];

export type UploadErrorCode =
  | 'chunk_failed'
  | 'target_failed'
  | 'aborted'
  | 'start_failed'
  | 'checksum_mismatch'
  | 'unsupported_wire_version'
  | 'invalid_target_url'
  | 'payload_too_large'
  | 'too_many_chunks'
  | 'chunk_checksum_mismatch'
  | 'full_checksum_mismatch'
  | 'incomplete'
  | 'session_not_found'
  | 'session_expired'
  | 'rate_limited';

export interface SerializedPayload {
  blob: Blob;
  contentType: string;
  formDataEntryCount: number | null;
}

export interface StartRequestBody {
  targetUrl: string;
  method: string;
  contentType: string;
  totalBytes: number;
  totalChunks: number;
  chunkSize: number;
  checksum: string;
  headers: Record<string, string>;
}

export interface StartResponseBody {
  uploadId: string;
  expiresAt: string;
}

export interface SnapshotLastError {
  code: string;
  message: string;
  httpStatus?: number;
}

export interface PendingForm {
  snapshotId: string;
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  createdAt: Date;
  expiresAt: Date;
  lastError?: SnapshotLastError;
  fields: Record<string, string>;
  files: Record<string, File>;
}
