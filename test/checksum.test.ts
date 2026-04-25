import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/checksum';

describe('sha256Hex', () => {
  it('hashes empty input', async () => {
    expect(await sha256Hex(new Blob([]))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes ASCII string blob', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches across Blob, ArrayBuffer, and Uint8Array for the same bytes', async () => {
    const bytes = new TextEncoder().encode('abc');
    const a = await sha256Hex(new Blob([bytes]));
    const b = await sha256Hex(bytes.buffer);
    const c = await sha256Hex(bytes);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('produces lowercase hex with sha256: prefix', async () => {
    const hash = await sha256Hex(new Blob(['anything']));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
