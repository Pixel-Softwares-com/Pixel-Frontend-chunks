import { UploadError } from './errors';
import { DEFAULTS, send } from './send';
import type { TransportResponseType } from './transport';
import type { SendData, SendOptions } from './types';
import { createAxiosTransport, type AxiosLikeInstance } from './transports/axios';

export interface AxiosStaticLike {
  create(config?: { baseURL?: string }): AxiosLikeInstance;
  getUri(config: AxiosAdapterRequestConfig): string;
}

export interface AxiosHeadersLike {
  toJSON?: () => Record<string, string>;
}

export interface AxiosAdapterRequestConfig extends Omit<SendOptions, 'headers' | 'onProgress'> {
  url?: string;
  baseURL?: string;
  method?: string;
  headers?: Record<string, string> | AxiosHeadersLike;
  data?: unknown;
  responseType?: TransportResponseType;
  validateStatus?: ((status: number) => boolean) | null;
  onUploadProgress?: (event: { loaded: number; total?: number }) => void;
}

export interface AxiosAdapterResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: AxiosAdapterRequestConfig;
  request?: unknown;
}

export interface AxiosAdapterError extends Error {
  isAxiosError: true;
  config: AxiosAdapterRequestConfig;
  response?: AxiosAdapterResponse;
  cause?: unknown;
}

export type AxiosAdapter = (config: AxiosAdapterRequestConfig) => Promise<AxiosAdapterResponse>;

export function createChunkedAxiosAdapter(
  axios: AxiosStaticLike,
  defaults: SendOptions = {},
): AxiosAdapter {
  const transports = new Map<string, ReturnType<typeof createAxiosTransport>>();

  const getTransport = (baseURL = '') => {
    let transport = transports.get(baseURL);
    if (transport === undefined) {
      transport = createAxiosTransport(axios.create({ baseURL }));
      transports.set(baseURL, transport);
    }
    return transport;
  };

  return async function chunkedAxiosAdapter(config) {
    const sendOptions = resolveSendOptions(defaults, config);
    const method = (config.method || 'get').toUpperCase();
    const headers = normalizeRequestHeaders(config.headers);
    const signal = config.signal ?? defaults.signal;
    const transport = config.transport ?? defaults.transport ?? getTransport(config.baseURL);
    const url = buildRequestUrl(axios, config);

    try {
      const tr =
        config.data === undefined || config.data === null
          ? await transport.request({
              url,
              method,
              headers,
              body: null,
              signal,
              responseType: config.responseType,
            })
          : await send(url, config.data as SendData, {
              ...sendOptions,
              method,
              headers,
              signal,
              onProgress: config.onUploadProgress
                ? (loaded, total) => config.onUploadProgress?.({ loaded, total })
                : defaults.onProgress,
              transport,
            });

      const response = toAxiosResponse(tr, config);
      const validate = config.validateStatus || ((status: number) => status >= 200 && status < 300);
      if (!validate(tr.status)) {
        throw toAxiosError(`Request failed with status code ${tr.status}`, config, response);
      }
      return response;
    } catch (err) {
      if (isAxiosError(err)) throw err;
      if (err instanceof UploadError) {
        throw toAxiosError(
          err.message,
          config,
          err.response ? toAxiosResponse(err.response, config) : undefined,
          err,
        );
      }
      throw err;
    }
  };
}

function resolveSendOptions(defaults: SendOptions, config: AxiosAdapterRequestConfig): SendOptions {
  return {
    chunkSize: config.chunkSize ?? defaults.chunkSize ?? DEFAULTS.chunkSize,
    chunkThresholdBytes: config.chunkThresholdBytes ?? defaults.chunkThresholdBytes ?? DEFAULTS.chunkThresholdBytes,
    maxFormDataEntries: config.maxFormDataEntries ?? defaults.maxFormDataEntries ?? DEFAULTS.maxFormDataEntries,
    concurrency: config.concurrency ?? defaults.concurrency ?? DEFAULTS.concurrency,
    retries: config.retries ?? defaults.retries ?? DEFAULTS.retries,
    retryDelay: config.retryDelay ?? defaults.retryDelay ?? DEFAULTS.retryDelay,
    prefix: config.prefix ?? defaults.prefix ?? DEFAULTS.prefix,
    saveSnapshot: config.saveSnapshot ?? defaults.saveSnapshot ?? DEFAULTS.saveSnapshot,
    snapshotTTL: config.snapshotTTL ?? defaults.snapshotTTL ?? DEFAULTS.snapshotTTL,
  };
}

function buildRequestUrl(axios: AxiosStaticLike, config: AxiosAdapterRequestConfig): string {
  const url = axios.getUri(config);
  const { baseURL } = config;
  if (!baseURL) return url;

  const relative = stripBaseUrl(url, baseURL);
  return ensureLeadingSlash(relative);
}

function stripBaseUrl(url: string, baseURL: string): string {
  try {
    const parsedUrl = new URL(url, baseURL);
    const parsedBase = new URL(baseURL);
    if (parsedUrl.origin === parsedBase.origin) {
      return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    }
  } catch {
    // Fall back to string handling below for non-standard adapter inputs.
  }

  return url;
}

function ensureLeadingSlash(url: string): string {
  if (/^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)) return url;
  return url.startsWith('/') ? url : `/${url}`;
}

function normalizeRequestHeaders(headers: AxiosAdapterRequestConfig['headers'] = {}): Record<string, string> {
  if (typeof headers !== 'object' || headers === null) return {};
  if ('toJSON' in headers && typeof headers.toJSON === 'function') {
    return stringifyHeaders(headers.toJSON());
  }
  return stringifyHeaders(headers as Record<string, unknown>);
}

function stringifyHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function normalizeResponseHeaders(headers: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function toAxiosResponse<T>(
  response: { data: T; status: number; statusText: string; headers: Record<string, unknown>; raw?: unknown },
  config: AxiosAdapterRequestConfig,
): AxiosAdapterResponse<T> {
  return {
    data: response.data,
    status: response.status,
    statusText: response.statusText,
    headers: normalizeResponseHeaders(response.headers),
    config,
    request: response.raw,
  };
}

function toAxiosError(
  message: string,
  config: AxiosAdapterRequestConfig,
  response?: AxiosAdapterResponse,
  cause?: unknown,
): AxiosAdapterError {
  const error = new Error(message) as AxiosAdapterError;
  error.isAxiosError = true;
  error.config = config;
  if (response !== undefined) error.response = response;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isAxiosError(err: unknown): err is AxiosAdapterError {
  return typeof err === 'object' && err !== null && (err as { isAxiosError?: unknown }).isAxiosError === true;
}
