import type { PendingForm, SendData, SnapshotLastError } from './types';

const DB_NAME = 'pixel-request-chunks';
const DB_VERSION = 1;
const SNAPSHOTS_STORE = 'snapshots';
const UPLOADS_STORE = 'uploads';

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
let dbPromise: Promise<IDBDatabase> | null = null;
let lastCreatedAt = 0;

export async function createSnapshot(input: CreateSnapshotInput): Promise<string> {
  await purgeExpiredSnapshots();

  const now = Date.now();
  const createdAt = nextCreatedAt(now);
  const snapshotId = createId();
  const { fields, files } = snapshotPayload(input.data);

  const record: SnapshotRecord = {
    snapshotId,
    targetUrl: input.targetUrl,
    method: input.method,
    headers: { ...input.headers },
    contentType: input.contentType,
    createdAt,
    expiresAt: now + input.ttlMs,
    fields,
    files,
  };

  await putSnapshot(record);

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
  if (record === undefined) return;

  await putSnapshot({ ...record, lastError });
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
  if (!hasIndexedDB()) {
    return memorySnapshots.get(snapshotId);
  }

  const db = await openDatabase();
  const record = await requestToPromise<SnapshotRecord | undefined>(
    db.transaction(SNAPSHOTS_STORE, 'readonly').objectStore(SNAPSHOTS_STORE).get(snapshotId),
  );

  return record;
}

async function getAllSnapshots(): Promise<SnapshotRecord[]> {
  if (!hasIndexedDB()) {
    return Array.from(memorySnapshots.values());
  }

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

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        db.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'snapshotId' });
      }
      if (!db.objectStoreNames.contains(UPLOADS_STORE)) {
        db.createObjectStore(UPLOADS_STORE, { keyPath: 'uploadId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'));
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
  return requestToPromise(
    db.transaction(storeName, 'readwrite').objectStore(storeName).clear(),
  ).then(() => undefined);
}

function snapshotPayload(data: SendData): {
  fields: Record<string, string>;
  files: Record<string, File>;
} {
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const fields: Record<string, string> = {};
    const files: Record<string, File> = {};

    for (const [name, value] of data.entries()) {
      if (typeof value === 'string') {
        fields[name] = value;
      } else {
        files[name] = toFile(value, getFileName(value, name));
      }
    }

    return { fields, files };
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return {
      fields: {},
      files: { payload: toFile(data, getFileName(data, 'payload')) },
    };
  }

  if (data instanceof ArrayBuffer) {
    return {
      fields: {},
      files: { payload: toFile(new Blob([data], { type: 'application/octet-stream' }), 'payload.bin') },
    };
  }

  if (ArrayBuffer.isView(data)) {
    return {
      fields: {},
      files: {
        payload: toFile(new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'payload.bin'),
      },
    };
  }

  if (typeof data === 'string') {
    return { fields: { body: data }, files: {} };
  }

  return { fields: { json: JSON.stringify(data) }, files: {} };
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

function toFile(blob: Blob, name: string): File {
  if (typeof File !== 'undefined' && blob instanceof File) {
    return blob;
  }

  if (typeof File !== 'undefined') {
    return new File([blob], name, {
      type: blob.type || 'application/octet-stream',
      lastModified: Date.now(),
    });
  }

  return blob as File;
}

function getFileName(blob: Blob, fallback: string): string {
  const maybeName = (blob as { name?: unknown }).name;
  return typeof maybeName === 'string' && maybeName.length > 0 ? maybeName : fallback;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'snapshot_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
}

function nextCreatedAt(now: number): number {
  lastCreatedAt = Math.max(now, lastCreatedAt + 1);

  return lastCreatedAt;
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

if (typeof window !== 'undefined') {
  void purgeExpiredSnapshots().catch(() => undefined);
}
