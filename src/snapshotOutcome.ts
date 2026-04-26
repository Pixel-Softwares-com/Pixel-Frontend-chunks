import {
  lastErrorFromUploadError,
  shouldTrackError,
  toUploadError,
  uploadErrorFromResponse,
  UploadError,
} from './errors';
import { deletePendingForm, recordSnapshotError } from './storage';
import { isTransportOk, type TransportResponse } from './transport';
import type { TrackErrorsOption } from './types';

/**
 * Inspect the transport response and either resolve cleanly (and clean up the
 * snapshot) or throw an UploadError with the snapshot persisted as a tracked
 * error. The snapshot is the user-visible record of a failed upload, so it
 * must accurately reflect the outcome regardless of whether the transport
 * reported success.
 */
export async function finalizeResponse<T>(
  response: TransportResponse<T>,
  snapshotId: string | undefined,
  trackErrors: TrackErrorsOption | undefined,
): Promise<TransportResponse<T>> {
  if (isTransportOk(response)) {
    if (snapshotId !== undefined) await deletePendingForm(snapshotId);
    return response;
  }

  const error = uploadErrorFromResponse('target_failed', response, { snapshotId });
  await persistErrorOutcome(error, snapshotId, trackErrors);
  throw error;
}

export async function preserveSnapshotOnError(
  err: unknown,
  snapshotId: string | undefined,
  trackErrors: TrackErrorsOption | undefined,
): Promise<UploadError> {
  const error = toUploadError(err, snapshotId);
  await persistErrorOutcome(error, snapshotId, trackErrors);
  return error;
}

async function persistErrorOutcome(
  error: UploadError,
  snapshotId: string | undefined,
  trackErrors: TrackErrorsOption | undefined,
): Promise<void> {
  if (snapshotId === undefined) return;

  if (shouldTrackError(error.classification, trackErrors)) {
    await recordSnapshotError(snapshotId, lastErrorFromUploadError(error));
  } else {
    await deletePendingForm(snapshotId);
  }
}
