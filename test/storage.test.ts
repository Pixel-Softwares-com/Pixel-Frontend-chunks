import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllPending,
  createSnapshot,
  deletePendingForm,
  getPendingForms,
  recordSnapshotError,
  restoreForm,
} from '../src/storage';

describe('snapshot storage', () => {
  beforeEach(async () => {
    await clearAllPending();
  });

  it('stores and restores FormData fields and files', async () => {
    const form = new FormData();
    form.append('invoice_id', '123');
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

    const snapshotId = await createSnapshot({
      targetUrl: '/api/invoice',
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      contentType: 'multipart/form-data; boundary=test',
      data: form,
      ttlMs: 24 * 60 * 60 * 1000,
    });

    const restored = await restoreForm(snapshotId);

    expect(restored?.snapshotId).toBe(snapshotId);
    expect(restored?.targetUrl).toBe('/api/invoice');
    expect(restored?.method).toBe('POST');
    expect(restored?.headers.Authorization).toBe('Bearer token');
    expect(restored?.fields.invoice_id).toBe('123');
    expect(await restored?.files.file?.text()).toBe('hello');
  });

  it('lists newest pending forms first', async () => {
    const older = await createSnapshot({
      targetUrl: '/api/older',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      data: { a: 1 },
      ttlMs: 24 * 60 * 60 * 1000,
    });
    const newer = await createSnapshot({
      targetUrl: '/api/newer',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      data: { b: 2 },
      ttlMs: 24 * 60 * 60 * 1000,
    });

    expect((await getPendingForms()).map(form => form.snapshotId)).toEqual([newer, older]);
  });

  it('records last error details', async () => {
    const snapshotId = await createSnapshot({
      targetUrl: '/api/test',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      data: { a: 1 },
      ttlMs: 24 * 60 * 60 * 1000,
    });

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
    const one = await createSnapshot({
      targetUrl: '/api/one',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      data: { one: true },
      ttlMs: 24 * 60 * 60 * 1000,
    });
    await createSnapshot({
      targetUrl: '/api/two',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      data: { two: true },
      ttlMs: 24 * 60 * 60 * 1000,
    });

    await deletePendingForm(one);
    expect(await restoreForm(one)).toBeNull();
    expect(await getPendingForms()).toHaveLength(1);

    await clearAllPending();
    expect(await getPendingForms()).toHaveLength(0);
  });

  it('expires stale snapshots when pending forms are read', async () => {
    await createSnapshot({
      targetUrl: '/api/expired',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      data: { expired: true },
      ttlMs: -1,
    });

    expect(await getPendingForms()).toEqual([]);
  });
});
