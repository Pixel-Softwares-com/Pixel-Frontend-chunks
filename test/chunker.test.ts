import { describe, expect, it } from 'vitest';
import { sliceBlob } from '../src/chunker';

describe('sliceBlob', () => {
  it('splits an exact multiple of chunkSize', async () => {
    const chunks = sliceBlob(new Blob(['1234567890']), 5);
    expect(chunks).toHaveLength(2);
    expect(await chunks[0]!.text()).toBe('12345');
    expect(await chunks[1]!.text()).toBe('67890');
  });

  it('produces a smaller last chunk when size is not a multiple', () => {
    const chunks = sliceBlob(new Blob(['1234567']), 3);
    expect(chunks.map(c => c.size)).toEqual([3, 3, 1]);
  });

  it('returns one empty chunk for an empty blob', () => {
    const chunks = sliceBlob(new Blob([]), 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.size).toBe(0);
  });

  it('returns a single chunk when payload is smaller than chunkSize', () => {
    const chunks = sliceBlob(new Blob(['abc']), 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.size).toBe(3);
  });

  it('throws when chunkSize is not positive', () => {
    expect(() => sliceBlob(new Blob(['x']), 0)).toThrow();
    expect(() => sliceBlob(new Blob(['x']), -1)).toThrow();
    expect(() => sliceBlob(new Blob(['x']), Number.NaN)).toThrow();
  });
});
