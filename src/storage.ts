import type { PendingForm, SendData, SnapshotLastError } from './types';
import {
  clearStore,
  hasIndexedDB,
  openDatabase,
  requestToPromise,
  SNAPSHOTS_STORE,
  UPLOADS_STORE,
} from './storageIdb';
import { createSnapshotId, extractPayload } from './storagePayload';

interface SnapshotRecord {
  snapshotId: string;
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  createdAt: number;
  expiresAt: number;
  lastError?: SnapshotLastError;
  fields: Record<string, string>;
  files: Record<string, File>;
  uploadId?: string;
  uploadedChunkIndices?: number[];
  totalChunks?: number;
  chunkSize?: number;
  fullChecksum?: string;
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
  data: SendData;
  ttlMs: number;
}

const memorySnapshots = new Map<string, SnapshotRecord>();
let lastCreatedAt = 0;

export async function createSnapshot(input: CreateSnapshotInput): Promise<string> {
  await purgeExpiredSnapshots();

  const now = Date.now();
  const snapshotId = createSnapshotId();
  const { fields, files } = extractPayload(input.data);

  await putSnapshot({
    snapshotId,
    targetUrl: input.targetUrl,
    method: input.method,
    headers: { ...input.headers },
    contentType: input.contentType,
    createdAt: nextCreatedAt(now),
    expiresAt: now + input.ttlMs,
    fields,
    files,
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
  await Promise.all([
    clearStore(db, SNAPSHOTS_STORE),
    clearStore(db, UPLOADS_STORE),
  ]);
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
  return {
    ...record,
    headers: { ...record.headers },
    fields: { ...record.fields },
    files: { ...record.files },
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
  };
}

function nextCreatedAt(now: number): number {
  lastCreatedAt = Math.max(now, lastCreatedAt + 1);
  return lastCreatedAt;
}

if (typeof window !== 'undefined') {
  void purgeExpiredSnapshots().catch(() => undefined);
}
