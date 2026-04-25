import { describe, expect, it } from 'vitest';
import { serialize } from '../src/serialize';

describe('serialize', () => {
  it('serializes a string as text/plain', async () => {
    const r = await serialize('hello');
    expect(r.contentType).toBe('text/plain;charset=utf-8');
    expect(await r.blob.text()).toBe('hello');
    expect(r.formDataEntryCount).toBeNull();
  });

  it('serializes a plain object as JSON', async () => {
    const r = await serialize({ a: 1, b: 'two' });
    expect(r.contentType).toBe('application/json');
    expect(JSON.parse(await r.blob.text())).toEqual({ a: 1, b: 'two' });
    expect(r.formDataEntryCount).toBeNull();
  });

  it('serializes an array as JSON', async () => {
    const r = await serialize([1, 2, 3]);
    expect(r.contentType).toBe('application/json');
    expect(JSON.parse(await r.blob.text())).toEqual([1, 2, 3]);
  });

  it('serializes a Blob and preserves its type', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const r = await serialize(blob);
    expect(r.contentType).toBe('image/png');
    expect(r.blob).toBe(blob);
    expect(r.formDataEntryCount).toBeNull();
  });

  it('serializes a typeless Blob with a default content type', async () => {
    const r = await serialize(new Blob(['x']));
    expect(r.contentType).toBe('application/octet-stream');
  });

  it('serializes an ArrayBuffer', async () => {
    const buf = new TextEncoder().encode('abc').buffer;
    const r = await serialize(buf);
    expect(r.contentType).toBe('application/octet-stream');
    expect(await r.blob.text()).toBe('abc');
  });

  it('serializes a Uint8Array', async () => {
    const r = await serialize(new TextEncoder().encode('xyz'));
    expect(r.contentType).toBe('application/octet-stream');
    expect(await r.blob.text()).toBe('xyz');
  });

  it('serializes FormData with multipart content type and counts entries', async () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    fd.append('c', new Blob(['xyz']), 'c.txt');
    const r = await serialize(fd);
    expect(r.contentType).toMatch(/^multipart\/form-data;\s*boundary=/);
    expect(r.formDataEntryCount).toBe(3);
    expect(r.blob.size).toBeGreaterThan(0);
  });
});
