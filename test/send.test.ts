import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadError } from '../src/errors';
import { send, shouldChunk } from '../src/send';
import { clearAllPending, getPendingForms } from '../src/storage';

describe('shouldChunk', () => {
  const opts = { chunkThresholdBytes: 2 * 1024 * 1024, maxFormDataEntries: 5000 };

  it('false for small non-form payload', () => {
    expect(shouldChunk(1024, null, opts)).toBe(false);
  });

  it('true when bytes exceed threshold', () => {
    expect(shouldChunk(3 * 1024 * 1024, null, opts)).toBe(true);
  });

  it('true when FormData entries exceed max', () => {
    expect(shouldChunk(100, 6000, opts)).toBe(true);
  });

  it('false when FormData entries equal max and bytes under threshold', () => {
    expect(shouldChunk(100, 5000, opts)).toBe(false);
  });

  it('boundary: false at exactly chunkThresholdBytes (strictly greater triggers)', () => {
    expect(shouldChunk(2 * 1024 * 1024, null, opts)).toBe(false);
    expect(shouldChunk(2 * 1024 * 1024 + 1, null, opts)).toBe(true);
  });
});

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

describe('send (decision routing)', () => {
  beforeEach(async () => {
    await clearAllPending();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearAllPending();
  });

  it('uses normal fetch for small payloads', async () => {
    const { calls, fn } = makeFetchMock(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fn;

    const r = await send('/api/test', { hello: 'world' });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/test');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('forwards user-supplied method and headers on the normal path', async () => {
    const { calls, fn } = makeFetchMock(() => new Response('ok', { status: 200 }));
    globalThis.fetch = fn;

    await send('/api/test', 'body', { method: 'PUT', headers: { 'X-Foo': 'bar' } });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(calls[0]!.init.method).toBe('PUT');
    expect(headers.get('X-Foo')).toBe('bar');
  });

  it('uses chunk-transport flow when over byte threshold', async () => {
    const { calls, fn } = makeFetchMock(call => {
      if (call.url.endsWith('/chunk-transport/start')) {
        return new Response(
          JSON.stringify({ uploadId: 'abc', expiresAt: '2099-01-01T00:00:00Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (call.url.endsWith('/chunk-transport/complete')) {
        return new Response(JSON.stringify({ done: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    const big = new Blob([new Uint8Array(3 * 1024 * 1024)]);
    const r = await send('/api/upload', big, { chunkSize: 1024 * 1024 });

    expect(r.status).toBe(200);
    const urls = calls.map(c => c.url);
    expect(urls.filter(u => u.endsWith('/chunk-transport/start'))).toHaveLength(1);
    expect(urls.filter(u => u.endsWith('/chunk-transport/chunk'))).toHaveLength(3);
    expect(urls.filter(u => u.endsWith('/chunk-transport/complete'))).toHaveLength(1);

    const startCall = calls.find(c => c.url.endsWith('/chunk-transport/start'))!;
    const startBody = JSON.parse(startCall.init.body as string);
    expect(startBody.targetUrl).toBe('/api/upload');
    expect(startBody.totalBytes).toBe(3 * 1024 * 1024);
    expect(startBody.totalChunks).toBe(3);
    expect(startBody.chunkSize).toBe(1024 * 1024);
    expect(startBody.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    const startHeaders = new Headers(startCall.init.headers as HeadersInit);
    expect(startHeaders.get('X-Pixel-Request-Chunks-Version')).toBe('1');
  });

  it('uses chunk-transport flow when FormData entries exceed limit', async () => {
    const { calls, fn } = makeFetchMock(call => {
      if (call.url.endsWith('/chunk-transport/start')) {
        return new Response(
          JSON.stringify({ uploadId: 'abc', expiresAt: '2099-01-01T00:00:00Z' }),
          { status: 200 },
        );
      }
      if (call.url.endsWith('/chunk-transport/complete')) {
        return new Response('ok', { status: 200 });
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    const fd = new FormData();
    for (let i = 0; i < 6000; i++) fd.append(`k${i}`, 'v');

    await send('/api/bulk', fd, { maxFormDataEntries: 5000 });
    expect(calls.some(c => c.url.endsWith('/chunk-transport/start'))).toBe(true);
  });

  it('reports progress as chunks upload', async () => {
    const { fn } = makeFetchMock(call => {
      if (call.url.endsWith('/chunk-transport/start')) {
        return new Response(
          JSON.stringify({ uploadId: 'abc', expiresAt: '2099-01-01T00:00:00Z' }),
          { status: 200 },
        );
      }
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fn;

    const events: Array<[number, number]> = [];
    const big = new Blob([new Uint8Array(3 * 1024 * 1024)]);
    await send('/api/upload', big, {
      chunkSize: 1024 * 1024,
      concurrency: 1,
      onProgress: (sent, total) => events.push([sent, total]),
    });

    expect(events.length).toBe(3);
    expect(events[events.length - 1]).toEqual([3 * 1024 * 1024, 3 * 1024 * 1024]);
  });

  it('deletes the snapshot after a successful response', async () => {
    const { fn } = makeFetchMock(() => new Response('ok', { status: 200 }));
    globalThis.fetch = fn;

    await send('/api/test', { hello: 'world' });

    await expect(getPendingForms()).resolves.toEqual([]);
  });

  it('preserves the snapshot and exposes snapshotId when the target response fails', async () => {
    const { fn } = makeFetchMock(
      () => new Response(JSON.stringify({ message: 'invalid' }), { status: 500 }),
    );
    globalThis.fetch = fn;

    let caught: unknown;
    try {
      await send('/api/test', { invoice_id: 123 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UploadError);
    const error = caught as UploadError;
    expect(error.code).toBe('target_failed');
    expect(error.response?.status).toBe(500);
    expect(error.classification).toBe(500);
    expect(error.snapshotId).toBeTruthy();

    const pending = await getPendingForms();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.snapshotId).toBe(error.snapshotId);
    expect(pending[0]!.targetUrl).toBe('/api/test');
    expect(pending[0]!.fields.json).toBe(JSON.stringify({ invoice_id: 123 }));
    expect(pending[0]!.lastError).toEqual({
      code: 'target_failed',
      message: '500 Error',
      httpStatus: 500,
    });
  });

  it('does not record lastError for non-whitelisted status (default)', async () => {
    const { fn } = makeFetchMock(
      () => new Response(JSON.stringify({ message: 'invalid' }), { status: 422 }),
    );
    globalThis.fetch = fn;

    let caught: unknown;
    try {
      await send('/api/test', { invoice_id: 123 });
    } catch (err) {
      caught = err;
    }

    const error = caught as UploadError;
    expect(error.classification).toBe(422);
    expect(error.snapshotId).toBeTruthy();

    const pending = await getPendingForms();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.lastError).toBeUndefined();
  });

  it('records lastError for any status when trackErrors is "all"', async () => {
    const { fn } = makeFetchMock(
      () => new Response('bad', { status: 422 }),
    );
    globalThis.fetch = fn;

    let caught: unknown;
    try {
      await send('/api/test', { invoice_id: 123 }, { trackErrors: 'all' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UploadError);

    const pending = await getPendingForms();
    expect(pending[0]!.lastError).toEqual({
      code: 'target_failed',
      message: '422 Error',
      httpStatus: 422,
    });
  });

  it('records lastError when status is in custom trackErrors list', async () => {
    const { fn } = makeFetchMock(
      () => new Response('forbidden', { status: 403 }),
    );
    globalThis.fetch = fn;

    try {
      await send('/api/test', { x: 1 }, { trackErrors: [401, 403] });
    } catch {
      /* expected */
    }

    const pending = await getPendingForms();
    expect(pending[0]!.lastError?.httpStatus).toBe(403);
  });

  it('does not record lastError for aborted uploads even with trackErrors "all"', async () => {
    const controller = new AbortController();
    const { fn } = makeFetchMock(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    globalThis.fetch = fn;

    let caught: unknown;
    try {
      await send('/api/test', { x: 1 }, { trackErrors: 'all', signal: controller.signal });
    } catch (err) {
      caught = err;
    }

    const error = caught as UploadError;
    expect(error.classification).toBe('abort');
    expect(error.code).toBe('aborted');

    const pending = await getPendingForms();
    expect(pending[0]!.lastError).toBeUndefined();
  });

  it('does not create a snapshot when saveSnapshot is false', async () => {
    const { fn } = makeFetchMock(() => new Response('ok', { status: 200 }));
    globalThis.fetch = fn;

    await send('/api/test', { hello: 'world' }, { saveSnapshot: false });

    await expect(getPendingForms()).resolves.toEqual([]);
  });
});
