import { describe, expect, it } from 'vitest';
import { createChunkedAxiosAdapter } from '../src/axiosAdapter';
import type { AxiosLikeInstance, AxiosLikeRequestConfig, AxiosLikeResponse } from '../src/transports/axios';

interface RecordedRequest extends AxiosLikeRequestConfig {
  baseURL?: string;
}

function createAxiosMock(handler: (config: RecordedRequest) => AxiosLikeResponse) {
  const requests: RecordedRequest[] = [];
  const axios = {
    create(config: { baseURL?: string } = {}): AxiosLikeInstance {
      return {
        async request<T>(requestConfig: AxiosLikeRequestConfig): Promise<AxiosLikeResponse<T>> {
          const request = { ...requestConfig, baseURL: config.baseURL };
          requests.push(request);
          return handler(request) as AxiosLikeResponse<T>;
        },
      };
    },
    getUri(config: { url?: string; baseURL?: string }): string {
      return config.url ?? '';
    },
  };

  return { axios, requests };
}

describe('createChunkedAxiosAdapter', () => {
  it('sends through a cached bare axios transport and returns an axios-shaped response', async () => {
    const { axios, requests } = createAxiosMock(() => ({
      status: 201,
      statusText: 'Created',
      headers: { 'X-Result': 'ok' },
      data: { ok: true },
    }));
    const adapter = createChunkedAxiosAdapter(axios, { saveSnapshot: false });

    const response = await adapter({
      baseURL: 'https://api.example.test',
      url: '/users',
      method: 'post',
      headers: { Authorization: 'Bearer token' },
      data: { name: 'Ada' },
    });

    expect(response.status).toBe(201);
    expect(response.headers['x-result']).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.baseURL).toBe('https://api.example.test');
    expect(requests[0]!.url).toBe('https://api.example.test/users');
    expect(requests[0]!.headers).toMatchObject({
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    });
  });

  it('uses the bare transport without a generated body for requests without data', async () => {
    const { axios, requests } = createAxiosMock(() => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { users: [] },
    }));
    const adapter = createChunkedAxiosAdapter(axios, { saveSnapshot: false });

    await adapter({
      baseURL: 'https://api.example.test',
      url: '/users',
      method: 'get',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.data).toBeUndefined();
    expect(requests[0]!.headers).toEqual({});
  });

  it('converts failed upload responses to axios-shaped errors', async () => {
    const { axios } = createAxiosMock(() => ({
      status: 422,
      statusText: 'Unprocessable Content',
      headers: { 'Content-Type': 'application/json' },
      data: { message: 'Invalid payload' },
    }));
    const adapter = createChunkedAxiosAdapter(axios, { saveSnapshot: false });

    await expect(
      adapter({
        baseURL: 'https://api.example.test',
        url: '/users',
        method: 'post',
        data: { name: '' },
      }),
    ).rejects.toMatchObject({
      isAxiosError: true,
      response: {
        status: 422,
        data: { message: 'Invalid payload' },
      },
    });
  });

  it('falls back to send defaults when adapter defaults are partial', async () => {
    const { axios, requests } = createAxiosMock((request) => {
      if (request.url?.endsWith('/chunk-transport/start')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: { uploadId: 'upload-1' },
        };
      }

      if (request.url?.endsWith('/chunk-transport/chunk')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: {},
        };
      }

      if (request.url?.endsWith('/chunk-transport/complete')) {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: { ok: true },
        };
      }

      return {
        status: 500,
        statusText: 'Unexpected',
        headers: {},
        data: {},
      };
    });
    const adapter = createChunkedAxiosAdapter(axios, {
      chunkThresholdBytes: 1,
      saveSnapshot: false,
    });

    const response = await adapter({
      baseURL: 'https://api.example.test',
      url: '/users',
      method: 'post',
      data: { name: 'Ada Lovelace' },
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(requests.map(request => request.url)).toEqual([
      '/chunk-transport/start',
      '/chunk-transport/chunk',
      '/chunk-transport/complete',
    ]);
  });
});
