import type { SendData, SerializedPayload } from './types';

export async function serialize(data: SendData): Promise<SerializedPayload> {
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    let count = 0;
    for (const _ of data.keys()) count++;
    const response = new Response(data);
    const contentType = response.headers.get('Content-Type') ?? 'multipart/form-data';
    const blob = await response.blob();
    return { blob, contentType, formDataEntryCount: count };
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return {
      blob: data,
      contentType: data.type || 'application/octet-stream',
      formDataEntryCount: null,
    };
  }

  if (data instanceof ArrayBuffer) {
    return {
      blob: new Blob([data], { type: 'application/octet-stream' }),
      contentType: 'application/octet-stream',
      formDataEntryCount: null,
    };
  }

  if (ArrayBuffer.isView(data)) {
    return {
      blob: new Blob([data as BlobPart], { type: 'application/octet-stream' }),
      contentType: 'application/octet-stream',
      formDataEntryCount: null,
    };
  }

  if (typeof data === 'string') {
    return {
      blob: new Blob([data], { type: 'text/plain;charset=utf-8' }),
      contentType: 'text/plain;charset=utf-8',
      formDataEntryCount: null,
    };
  }

  const json = JSON.stringify(data);
  return {
    blob: new Blob([json], { type: 'application/json' }),
    contentType: 'application/json',
    formDataEntryCount: null,
  };
}
