import type { Transport, TransportRequest, TransportResponse } from '../transport';

export interface AxiosLikeProgressEvent {
  loaded: number;
  total?: number;
}

export interface AxiosLikeRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  signal?: AbortSignal;
  responseType?: 'json' | 'text' | 'blob' | 'arraybuffer' | 'stream' | 'document';
  onUploadProgress?: (event: AxiosLikeProgressEvent) => void;
  validateStatus?: ((status: number) => boolean) | null;
}

export interface AxiosLikeResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string> | unknown;
  data: T;
  config?: unknown;
  request?: unknown;
}

export interface AxiosLikeInstance {
  request<T = unknown>(config: AxiosLikeRequestConfig): Promise<AxiosLikeResponse<T>>;
}

export function createAxiosTransport(instance: AxiosLikeInstance): Transport {
  return {
    async request<T>(req: TransportRequest): Promise<TransportResponse<T>> {
      const config: AxiosLikeRequestConfig = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        data: req.body ?? undefined,
        signal: req.signal,
        responseType: mapResponseType(req.responseType),
        validateStatus: () => true,
      };

      if (req.onUploadProgress !== undefined) {
        const cb = req.onUploadProgress;
        config.onUploadProgress = (e) => cb(e.loaded, e.total ?? 0);
      }

      const response = await instance.request<T>(config);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: normalizeAxiosHeaders(response.headers),
        data: response.data,
        raw: response,
      };
    },
  };
}

function mapResponseType(responseType: TransportRequest['responseType']): AxiosLikeRequestConfig['responseType'] {
  if (responseType === undefined) return 'json';
  return responseType;
}

function normalizeAxiosHeaders(headers: unknown): Record<string, string> {
  if (headers === null || headers === undefined) return {};
  if (typeof headers !== 'object') return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}
