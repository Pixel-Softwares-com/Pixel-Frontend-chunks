export function resolveUrl(url: string, baseUrl: string | undefined): string {
  if (/^https?:\/\//i.test(url)) return url;

  const root = baseUrl ?? originOrUndefined();
  if (root === undefined) return url;

  try {
    return new URL(url, root).toString();
  } catch {
    return url;
  }
}

function originOrUndefined(): string | undefined {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin;
  }
  return undefined;
}
