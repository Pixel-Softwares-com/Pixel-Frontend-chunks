import type { SendData, SerializedPayload } from './types';

export async function serialize(
  data: SendData,
  options: { useFormData?: boolean } = {},
): Promise<SerializedPayload> {
  if (options.useFormData === false) {
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      blob: new Blob([json], { type: 'application/json' }),
      contentType: 'application/json',
      formDataEntryCount: null,
    };
  }

  const formData = data as FormData;
  const response = new Response(formData);
  const contentType = response.headers.get('Content-Type')!;
  const blob = await response.blob();
  let count = 0;
  for (const _ of formData.keys()) count++;
  return { blob, contentType, formDataEntryCount: count };
}
