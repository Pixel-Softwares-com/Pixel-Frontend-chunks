import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/checksum';
import { sliceBlob } from '../src/chunker';
import { send } from '../src/send';
import {
  clearAllPending,
  createSnapshot,
  getPendingForms,
  readSnapshotUploadProgress,
  recordSnapshotUploadProgress,
} from '../src/storage';

async function snapshotForBlob(blob: Blob, chunkSize: number, targetUrl = '/api/upload'): Promise<string> {
  return createSnapshot({
    targetUrl,
    method: 'POST',
    headers: {},
    contentType: 'application/octet-stream',
    chunks: sliceBlob(blob, chunkSize),
    chunkSize,
    totalBytes: blob.size,
    fullChecksum: await sha256Hex(blob),
    ttlMs: 24 * 60 * 60 * 1000,
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;

function makeFetchMock(handler: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
  fn: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fn };
}

describe('resume', () => {
  beforeEach(async () => {
    await clearAllPending();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearAllPending();
  });

  it('records uploadId and progress into the snapshot during a chunked send that fails mid-flight', async () => {
    const { fn } = makeFetchMock(call => {
      if (call.url.endsWith('/chunk-transport/start')) {
        return new Response(
          JSON.stringify({ uploadId: 'session-A', expiresAt: '2099-01-01T00:00:00Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (call.url.includes('/chunk-transport/chunk')) {
        const body = call.init.body as FormData;
        const idx = Number(body.get('chunkIndex'));
        if (idx === 0) {
          return new Response(JSON.stringify({ received: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: { code: 'chunk_failed' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    const big = new Blob([new Uint8Array(3 * 1024 * 1024)]);
    let snapshotIdFromError: string | undefined;
    try {
      await send('/api/upload', big, {
        chunkSize: 1024 * 1024,
        concurrency: 1,
        retries: 0,
        trackErrors: 'all',
      });
    } catch (err) {
      snapshotIdFromError = (err as { snapshotId?: string }).snapshotId;
    }

    expect(snapshotIdFromError).toBeTruthy();
    const progress = await readSnapshotUploadProgress(snapshotIdFromError!);
    expect(progress?.uploadId).toBe('session-A');
    expect(progress?.totalChunks).toBe(3);
    expect(progress?.chunkSize).toBe(1024 * 1024);
    expect(progress?.uploadedChunkIndices).toContain(0);
    expect(progress?.fullChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('queries /status, reuses the uploadId, and skips already-uploaded chunks when resumed', async () => {
    const blob = new Blob([new Uint8Array(3 * 1024 * 1024)]);
    const fullChecksum = await sha256Hex(blob);

    const snapshotId = await snapshotForBlob(blob, 1024 * 1024);
    await recordSnapshotUploadProgress(snapshotId, {
      uploadId: 'session-A',
      uploadedChunkIndices: [0],
      totalChunks: 3,
      chunkSize: 1024 * 1024,
      fullChecksum,
    });

    const { calls, fn } = makeFetchMock(call => {
      if (call.url.includes('/chunk-transport/status/session-A')) {
        return new Response(
          JSON.stringify({
            alive: true,
            uploadedChunks: [0],
            totalChunks: 3,
            expiresAt: '2099-01-01T00:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (call.url.endsWith('/chunk-transport/start')) {
        throw new Error('start should not be called when resuming a live session');
      }
      if (call.url.includes('/chunk-transport/chunk')) {
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call.url.endsWith('/chunk-transport/complete')) {
        const body = JSON.parse(call.init.body as string);
        expect(body.uploadId).toBe('session-A');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    const events: Array<[number, number]> = [];
    const response = await send('/api/upload', blob, {
      chunkSize: 1024 * 1024,
      concurrency: 1,
      resumeSnapshotId: snapshotId,
      onProgress: (sent, total) => events.push([sent, total]),
    });

    expect(response.status).toBe(200);

    const statusCalls = calls.filter(c => c.url.includes('/chunk-transport/status/'));
    expect(statusCalls).toHaveLength(1);

    const startCalls = calls.filter(c => c.url.endsWith('/chunk-transport/start'));
    expect(startCalls).toHaveLength(0);

    const chunkCalls = calls.filter(c => c.url.endsWith('/chunk-transport/chunk'));
    expect(chunkCalls).toHaveLength(2);
    const sentIndices = chunkCalls
      .map(c => Number((c.init.body as FormData).get('chunkIndex')))
      .sort((a, b) => a - b);
    expect(sentIndices).toEqual([1, 2]);

    expect(events[0]).toEqual([1024 * 1024, 3 * 1024 * 1024]);
    expect(events[events.length - 1]).toEqual([3 * 1024 * 1024, 3 * 1024 * 1024]);

    await expect(getPendingForms()).resolves.toEqual([]);
  });

  it('starts a fresh session when /status reports alive:false', async () => {
    const blob = new Blob([new Uint8Array(3 * 1024 * 1024)]);
    const fullChecksum = await sha256Hex(blob);

    const snapshotId = await snapshotForBlob(blob, 1024 * 1024);
    await recordSnapshotUploadProgress(snapshotId, {
      uploadId: 'session-DEAD',
      uploadedChunkIndices: [0],
      totalChunks: 3,
      chunkSize: 1024 * 1024,
      fullChecksum,
    });

    const { calls, fn } = makeFetchMock(call => {
      if (call.url.includes('/chunk-transport/status/session-DEAD')) {
        return new Response(JSON.stringify({ alive: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call.url.endsWith('/chunk-transport/start')) {
        return new Response(
          JSON.stringify({ uploadId: 'session-NEW', expiresAt: '2099-01-01T00:00:00Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (call.url.includes('/chunk-transport/chunk')) {
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call.url.endsWith('/chunk-transport/complete')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    await send('/api/upload', blob, {
      chunkSize: 1024 * 1024,
      concurrency: 1,
      resumeSnapshotId: snapshotId,
    });

    const startCalls = calls.filter(c => c.url.endsWith('/chunk-transport/start'));
    expect(startCalls).toHaveLength(1);

    const chunkCalls = calls.filter(c => c.url.endsWith('/chunk-transport/chunk'));
    expect(chunkCalls).toHaveLength(3);

    const completeCall = calls.find(c => c.url.endsWith('/chunk-transport/complete'))!;
    expect(JSON.parse(completeCall.init.body as string).uploadId).toBe('session-NEW');
  });

  it('does not query /status when there is no prior uploadId in the snapshot', async () => {
    const { calls, fn } = makeFetchMock(call => {
      if (call.url.endsWith('/chunk-transport/start')) {
        return new Response(
          JSON.stringify({ uploadId: 'session-FRESH', expiresAt: '2099-01-01T00:00:00Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (call.url.includes('/chunk-transport/chunk')) {
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (call.url.endsWith('/chunk-transport/complete')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    const blob = new Blob([new Uint8Array(2 * 1024 * 1024)]);
    await send('/api/upload', blob, { chunkSize: 1024 * 1024, concurrency: 1 });

    const statusCalls = calls.filter(c => c.url.includes('/chunk-transport/status/'));
    expect(statusCalls).toHaveLength(0);
  });
});
