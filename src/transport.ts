export type TransportResponseType = 'json' | 'text' | 'blob' | 'arraybuffer';

export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Blob | FormData | string | null;
  signal?: AbortSignal;
  onUploadProgress?: (sent: number, total: number) => void;
  responseType?: TransportResponseType;
}

export interface TransportResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  raw?: unknown;
}

export interface Transport {
  request<T = unknown>(req: TransportRequest): Promise<TransportResponse<T>>;
}

export function isTransportOk(response: { status: number }): boolean {
  return response.status >= 200 && response.status < 300;
}
