const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >>> 4];
    out += HEX[b & 0x0f];
  }
  return out;
}

export async function sha256Hex(input: Blob | ArrayBuffer | ArrayBufferView): Promise<string> {
  let buffer: ArrayBuffer;
  if (input instanceof Blob) {
    buffer = await input.arrayBuffer();
  } else if (input instanceof ArrayBuffer) {
    buffer = input;
  } else {
    buffer = input.buffer.slice(
      input.byteOffset,
      input.byteOffset + input.byteLength,
    ) as ArrayBuffer;
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return 'sha256:' + bytesToHex(new Uint8Array(digest));
}
