import type { UploadErrorCode } from './types';

export interface UploadErrorOptions {
  snapshotId?: string;
  response?: Response;
  chunkIndex?: number;
  cause?: unknown;
}

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly snapshotId?: string;
  readonly response?: Response;
  readonly chunkIndex?: number;

  constructor(code: UploadErrorCode, message: string, options: UploadErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UploadError';
    this.code = code;
    if (options.snapshotId !== undefined) this.snapshotId = options.snapshotId;
    if (options.response !== undefined) this.response = options.response;
    if (options.chunkIndex !== undefined) this.chunkIndex = options.chunkIndex;
  }
}
