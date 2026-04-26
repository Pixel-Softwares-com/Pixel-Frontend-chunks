const DB_NAME = 'pixel-request-chunks';
const DB_VERSION = 1;
export const SNAPSHOTS_STORE = 'snapshots';
export const UPLOADS_STORE = 'uploads';

let dbPromise: Promise<IDBDatabase> | null = null;

export function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openDatabase(): Promise<IDBDatabase> {
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

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
  return requestToPromise(
    db.transaction(storeName, 'readwrite').objectStore(storeName).clear(),
  ).then(() => undefined);
}
