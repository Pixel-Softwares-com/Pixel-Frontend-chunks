export const WIRE_VERSION = '1';
export const VERSION_HEADER = 'X-Pixel-Request-Chunks-Version';

export function joinUrl(prefix: string, path: string): string {
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return trimmed + path;
}
