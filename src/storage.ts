import type { DecodedPayload, PendingForm, SnapshotLastError } from './types';
import {
  clearStore,
  hasIndexedDB,
  openDatabase,
  requestToPromise,
  SNAPSHOTS_STORE,
} from './storageIdb';

interface SnapshotRecord {
  snapshotId: string;
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  createdAt: number;
  expiresAt: number;
  lastError?: SnapshotLastError;
  chunks: Blob[];
  totalChunks: number;
  chunkSize: number;
  totalBytes: number;
  fullChecksum: string;
  uploadId?: string;
  uploadedChunkIndices?: number[];
}

export interface SnapshotUploadProgress {
  uploadId?: string;
  uploadedChunkIndices?: number[];
  totalChunks?: number;
  chunkSize?: number;
  fullChecksum?: string;
}

export interface CreateSnapshotInput {
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  chunks: Blob[];
  chunkSize: number;
  totalBytes: number;
  fullChecksum: string;
  ttlMs: number;
}

const memorySnapshots = new Map<string, SnapshotRecord>();
let lastCreatedAt = 0;

export async function createSnapshot(input: CreateSnapshotInput): Promise<string> {
  await purgeExpiredSnapshots();

  const now = Date.now();
  const snapshotId = createSnapshotId();

  await putSnapshot({
    snapshotId,
    targetUrl: input.targetUrl,
    method: input.method,
    headers: { ...input.headers },
    contentType: input.contentType,
    createdAt: nextCreatedAt(now),
    expiresAt: now + input.ttlMs,
    chunks: input.chunks,
    totalChunks: input.chunks.length,
    chunkSize: input.chunkSize,
    totalBytes: input.totalBytes,
    fullChecksum: input.fullChecksum,
  });

  return snapshotId;
}

export async function getPendingForms(): Promise<PendingForm[]> {
  await purgeExpiredSnapshots();
  const records = await getAllSnapshots();
  return records.sort((a, b) => b.createdAt - a.createdAt).map(toPendingForm);
}

export async function restoreForm(snapshotId: string): Promise<PendingForm | null> {
  await purgeExpiredSnapshots();
  const record = await getSnapshot(snapshotId);
  return record === undefined ? null : toPendingForm(record);
}

export async function deletePendingForm(snapshotId: string): Promise<void> {
  await deleteSnapshot(snapshotId);
}

export async function clearAllPending(): Promise<void> {
  if (!hasIndexedDB()) {
    memorySnapshots.clear();
    return;
  }

  const db = await openDatabase();
  await clearStore(db, SNAPSHOTS_STORE);
}

export async function recordSnapshotError(
  snapshotId: string,
  lastError: SnapshotLastError,
): Promise<void> {
  const record = await getSnapshot(snapshotId);
  if (record !== undefined) await putSnapshot({ ...record, lastError });
}

export async function recordSnapshotUploadProgress(
  snapshotId: string,
  patch: SnapshotUploadProgress,
): Promise<void> {
  const record = await getSnapshot(snapshotId);
  if (record !== undefined) await putSnapshot({ ...record, ...patch });
}

export async function readSnapshotUploadProgress(
  snapshotId: string,
): Promise<SnapshotUploadProgress | undefined> {
  const record = await getSnapshot(snapshotId);
  if (record === undefined) return undefined;

  return {
    uploadId: record.uploadId,
    uploadedChunkIndices: record.uploadedChunkIndices,
    totalChunks: record.totalChunks,
    chunkSize: record.chunkSize,
    fullChecksum: record.fullChecksum,
  };
}

/** Internal: reads the raw Blob of a snapshot (chunks reassembled). Used by
 * the resume path to re-slice and re-upload without re-serializing, which
 * would change FormData boundaries. */
export async function readSnapshotBlob(snapshotId: string): Promise<Blob | null> {
  const record = await getSnapshot(snapshotId);
  if (record === undefined) return null;
  return new Blob(record.chunks, { type: record.contentType });
}

async function decodeBlob(blob: Blob, contentType: string): Promise<DecodedPayload> {
  const main = contentType.split(';', 1)[0]!.trim().toLowerCase();

  if (main === 'multipart/form-data') {
    const data = await new Response(blob, { headers: { 'Content-Type': contentType } }).formData();
    return { kind: 'formData', contentType, data };
  }

  if (main === 'application/json') {
    return { kind: 'json', contentType, data: JSON.parse(await blob.text()) };
  }

  if (main.startsWith('text/')) {
    return { kind: 'text', contentType, data: await blob.text() };
  }

  return { kind: 'blob', contentType, data: blob };
}

async function purgeExpiredSnapshots(now = Date.now()): Promise<void> {
  const records = await getAllSnapshots();
  await Promise.all(
    records
      .filter(record => record.expiresAt <= now)
      .map(record => deleteSnapshot(record.snapshotId)),
  );
}

async function putSnapshot(record: SnapshotRecord): Promise<void> {
  if (!hasIndexedDB()) {
    memorySnapshots.set(record.snapshotId, record);
    return;
  }

  const db = await openDatabase();
  await requestToPromise(
    db.transaction(SNAPSHOTS_STORE, 'readwrite').objectStore(SNAPSHOTS_STORE).put(record),
  );
}

async function getSnapshot(snapshotId: string): Promise<SnapshotRecord | undefined> {
  if (!hasIndexedDB()) return memorySnapshots.get(snapshotId);

  const db = await openDatabase();
  return requestToPromise<SnapshotRecord | undefined>(
    db.transaction(SNAPSHOTS_STORE, 'readonly').objectStore(SNAPSHOTS_STORE).get(snapshotId),
  );
}

async function getAllSnapshots(): Promise<SnapshotRecord[]> {
  if (!hasIndexedDB()) return Array.from(memorySnapshots.values());

  const db = await openDatabase();
  return requestToPromise<SnapshotRecord[]>(
    db.transaction(SNAPSHOTS_STORE, 'readonly').objectStore(SNAPSHOTS_STORE).getAll(),
  );
}

async function deleteSnapshot(snapshotId: string): Promise<void> {
  if (!hasIndexedDB()) {
    memorySnapshots.delete(snapshotId);
    return;
  }

  const db = await openDatabase();
  await requestToPromise(
    db.transaction(SNAPSHOTS_STORE, 'readwrite').objectStore(SNAPSHOTS_STORE).delete(snapshotId),
  );
}

function toPendingForm(record: SnapshotRecord): PendingForm {
  const chunks = record.chunks;
  const contentType = record.contentType;
  return {
    snapshotId: record.snapshotId,
    targetUrl: record.targetUrl,
    method: record.method,
    headers: { ...record.headers },
    contentType: record.contentType,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    lastError: record.lastError,
    totalChunks: record.totalChunks,
    chunkSize: record.chunkSize,
    totalBytes: record.totalBytes,
    getPayload: () => decodeBlob(new Blob(chunks, { type: contentType }), contentType),
  };
}

function nextCreatedAt(now: number): number {
  lastCreatedAt = Math.max(now, lastCreatedAt + 1);
  return lastCreatedAt;
}

function createSnapshotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'snapshot_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

if (typeof window !== 'undefined') {
  void purgeExpiredSnapshots().catch(() => undefined);
}
