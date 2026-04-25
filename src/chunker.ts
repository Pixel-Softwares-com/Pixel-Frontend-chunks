export function sliceBlob(blob: Blob, chunkSize: number): Blob[] {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive finite number');
  }

  if (blob.size === 0) {
    return [blob.slice(0, 0)];
  }

  const chunks: Blob[] = [];
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    chunks.push(blob.slice(offset, end));
    offset = end;
  }
  return chunks;
}
