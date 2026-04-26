import type { SendData } from './types';

export interface SnapshotPayload {
  fields: Record<string, string>;
  files: Record<string, File>;
}

export function extractPayload(data: SendData): SnapshotPayload {
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    return extractFromFormData(data);
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return { fields: {}, files: { payload: toFile(data, getFileName(data, 'payload')) } };
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return {
      fields: {},
      files: { payload: toFile(new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'payload.bin') },
    };
  }

  if (typeof data === 'string') {
    return { fields: { body: data }, files: {} };
  }

  return { fields: { json: JSON.stringify(data) }, files: {} };
}

function extractFromFormData(data: FormData): SnapshotPayload {
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

function toFile(blob: Blob, name: string): File {
  if (typeof File !== 'undefined' && blob instanceof File) return blob;
  if (typeof File !== 'undefined') {
    return new File([blob], name, {
      type: blob.type || 'application/octet-stream',
      lastModified: Date.now(),
    });
  }
  return blob as File;
}

function getFileName(blob: Blob, fallback: string): string {
  const name = (blob as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : fallback;
}

export function createSnapshotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'snapshot_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
}
