import type { Transport, TransportRequest, TransportResponse, TransportResponseType } from '../transport';

export interface FetchTransportOptions {
  fetchImpl?: typeof fetch;
}

export function createFetchTransport(options: FetchTransportOptions = {}): Transport {
  const explicitFetch = options.fetchImpl;

  return {
    async request<T>(req: TransportRequest): Promise<TransportResponse<T>> {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        body: req.body as BodyInit | null,
        signal: req.signal,
      };

      const fetchImpl = explicitFetch ?? globalThis.fetch;
      const response = await fetchImpl(req.url, init);
      const data = (await readBody(response, req.responseType)) as T;

      return {
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        data,
        raw: response,
      };
    },
  };
}

async function readBody(response: Response, responseType?: TransportResponseType): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;

  if (responseType === 'blob') return response.blob();
  if (responseType === 'arraybuffer') return response.arrayBuffer();
  if (responseType === 'text') return response.text();

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const text = await response.text();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return response.text();
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
