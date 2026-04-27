import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/checksum';
import { sliceBlob } from '../src/chunker';
import {
  clearAllPending,
  createSnapshot,
  deletePendingForm,
  getPendingForms,
  recordSnapshotError,
  restoreForm,
} from '../src/storage';
import { serialize } from '../src/serialize';

async function makeSnapshot(overrides: Partial<Parameters<typeof createSnapshot>[0]> = {}) {
  const blob = overrides.chunks
    ? new Blob(overrides.chunks)
    : new Blob([JSON.stringify({ a: 1 })], { type: 'application/json' });
  const chunkSize = overrides.chunkSize ?? 1024 * 1024;
  const chunks = overrides.chunks ?? sliceBlob(blob, chunkSize);
  return createSnapshot({
    targetUrl: '/api/test',
    method: 'POST',
    headers: {},
    contentType: 'application/json',
    chunks,
    chunkSize,
    totalBytes: blob.size,
    fullChecksum: await sha256Hex(blob),
    ttlMs: 24 * 60 * 60 * 1000,
    ...overrides,
  });
}

describe('snapshot storage', () => {
  beforeEach(async () => {
    await clearAllPending();
  });

  it('stores and reassembles the payload from chunks', async () => {
    const blob = new Blob(['hello world'], { type: 'text/plain' });
    const chunks = sliceBlob(blob, 4);
    const snapshotId = await createSnapshot({
      targetUrl: '/api/invoice',
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      contentType: 'text/plain',
      chunks,
      chunkSize: 4,
      totalBytes: blob.size,
      fullChecksum: await sha256Hex(blob),
      ttlMs: 24 * 60 * 60 * 1000,
    });

    const restored = await restoreForm(snapshotId);

    expect(restored?.snapshotId).toBe(snapshotId);
    expect(restored?.targetUrl).toBe('/api/invoice');
    expect(restored?.method).toBe('POST');
    expect(restored?.headers.Authorization).toBe('Bearer token');
    expect(restored?.totalChunks).toBe(chunks.length);
    expect(restored?.chunkSize).toBe(4);
    expect(restored?.totalBytes).toBe(blob.size);
    const decoded = await restored?.getPayload();
    expect(decoded?.kind).toBe('text');
    expect(decoded?.kind === 'text' ? decoded.data : null).toBe('hello world');
  });

  it('lists newest pending forms first', async () => {
    const older = await makeSnapshot({ targetUrl: '/api/older' });
    const newer = await makeSnapshot({ targetUrl: '/api/newer' });

    expect((await getPendingForms()).map(form => form.snapshotId)).toEqual([newer, older]);
  });

  it('records last error details', async () => {
    const snapshotId = await makeSnapshot();

    await recordSnapshotError(snapshotId, {
      code: 'target_failed',
      message: '422 Error',
      httpStatus: 422,
    });

    expect((await restoreForm(snapshotId))?.lastError).toEqual({
      code: 'target_failed',
      message: '422 Error',
      httpStatus: 422,
    });
  });

  it('deletes individual snapshots and clears all pending snapshots', async () => {
    const one = await makeSnapshot({ targetUrl: '/api/one' });
    await makeSnapshot({ targetUrl: '/api/two' });

    await deletePendingForm(one);
    expect(await restoreForm(one)).toBeNull();
    expect(await getPendingForms()).toHaveLength(1);

    await clearAllPending();
    expect(await getPendingForms()).toHaveLength(0);
  });

  it('expires stale snapshots when pending forms are read', async () => {
    await makeSnapshot({ ttlMs: -1 });
    expect(await getPendingForms()).toEqual([]);
  });

  describe('PendingForm.getPayload decoding', () => {
    async function snapshotFromData(data: Parameters<typeof serialize>[0]): Promise<string> {
      const { blob, contentType } = await serialize(data);
      return createSnapshot({
        targetUrl: '/api/x',
        method: 'POST',
        headers: {},
        contentType,
        chunks: [blob],
        chunkSize: blob.size || 1,
        totalBytes: blob.size,
        fullChecksum: 'sha256:test',
        ttlMs: 60_000,
      });
    }

    it('decodes multipart FormData back into FormData', async () => {
      const fd = new FormData();
      fd.append('invoice_id', '123');
      fd.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

      const id = await snapshotFromData(fd);
      const decoded = await (await restoreForm(id))?.getPayload();

      expect(decoded?.kind).toBe('formData');
      const form = decoded?.kind === 'formData' ? decoded.data : null;
      expect(form?.get('invoice_id')).toBe('123');
      expect(await (form?.get('file') as File).text()).toBe('hello');
    });

    it('decodes JSON back into a parsed object', async () => {
      const id = await snapshotFromData({ a: 1, b: [2, 3] });
      const decoded = await (await restoreForm(id))?.getPayload();

      expect(decoded?.kind).toBe('json');
      expect(decoded?.kind === 'json' ? decoded.data : null).toEqual({ a: 1, b: [2, 3] });
    });

    it('decodes text/* into a string', async () => {
      const id = await snapshotFromData('plain body');
      const decoded = await (await restoreForm(id))?.getPayload();

      expect(decoded?.kind).toBe('text');
      expect(decoded?.kind === 'text' ? decoded.data : null).toBe('plain body');
    });

    it('returns the raw Blob for unknown content types', async () => {
      const id = await snapshotFromData(new Blob([new Uint8Array([1, 2, 3])]));
      const decoded = await (await restoreForm(id))?.getPayload();

      expect(decoded?.kind).toBe('blob');
    });
  });
});
