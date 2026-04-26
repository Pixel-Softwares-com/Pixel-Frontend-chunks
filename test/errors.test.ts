import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyTransportError,
  isAbortError,
  shouldTrackError,
  UploadError,
} from '../src/errors';

const onLineDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(globalThis.navigator) as object,
  'onLine',
) ?? Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');

function setOnLine(value: boolean): void {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  if (onLineDescriptor) {
    Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor);
  }
  vi.restoreAllMocks();
});

describe('isAbortError', () => {
  it('detects DOMException AbortError by name', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
  });

  it('detects axios CanceledError by name', () => {
    expect(isAbortError({ name: 'CanceledError' })).toBe(true);
  });

  it('detects axios ERR_CANCELED code', () => {
    expect(isAbortError({ code: 'ERR_CANCELED' })).toBe(true);
  });

  it('returns false for plain TypeError', () => {
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('returns false for null/undefined/primitive', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('abort')).toBe(false);
  });
});

describe('classifyTransportError', () => {
  it('classifies AbortError as abort', () => {
    expect(classifyTransportError({ name: 'AbortError' })).toBe('abort');
  });

  it('classifies TimeoutError as timeout', () => {
    expect(classifyTransportError({ name: 'TimeoutError' })).toBe('timeout');
  });

  it('classifies axios ECONNABORTED as timeout', () => {
    expect(classifyTransportError({ code: 'ECONNABORTED' })).toBe('timeout');
  });

  it('classifies axios ETIMEDOUT as timeout', () => {
    expect(classifyTransportError({ code: 'ETIMEDOUT' })).toBe('timeout');
  });

  it('classifies TypeError as network when offline', () => {
    setOnLine(false);
    expect(classifyTransportError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('classifies TypeError as cors when online', () => {
    setOnLine(true);
    expect(classifyTransportError(new TypeError('Failed to fetch'))).toBe('cors');
  });

  it('classifies axios ERR_NETWORK as network when offline', () => {
    setOnLine(false);
    expect(classifyTransportError({ code: 'ERR_NETWORK' })).toBe('network');
  });

  it('classifies axios ERR_NETWORK as cors when online', () => {
    setOnLine(true);
    expect(classifyTransportError({ code: 'ERR_NETWORK' })).toBe('cors');
  });
});

describe('shouldTrackError', () => {
  it('never tracks abort even with all', () => {
    expect(shouldTrackError('abort', 'all')).toBe(false);
    expect(shouldTrackError('abort', undefined)).toBe(false);
    expect(shouldTrackError('abort', [500])).toBe(false);
  });

  it('default whitelist includes 408/429/5xx/network/cors/timeout', () => {
    expect(shouldTrackError(408, undefined)).toBe(true);
    expect(shouldTrackError(429, undefined)).toBe(true);
    expect(shouldTrackError(500, undefined)).toBe(true);
    expect(shouldTrackError(502, undefined)).toBe(true);
    expect(shouldTrackError(503, undefined)).toBe(true);
    expect(shouldTrackError(504, undefined)).toBe(true);
    expect(shouldTrackError('network', undefined)).toBe(true);
    expect(shouldTrackError('cors', undefined)).toBe(true);
    expect(shouldTrackError('timeout', undefined)).toBe(true);
  });

  it('default whitelist excludes 4xx other than 408/429', () => {
    expect(shouldTrackError(400, undefined)).toBe(false);
    expect(shouldTrackError(401, undefined)).toBe(false);
    expect(shouldTrackError(403, undefined)).toBe(false);
    expect(shouldTrackError(404, undefined)).toBe(false);
  });

  it('all tracks any non-abort classification', () => {
    expect(shouldTrackError(401, 'all')).toBe(true);
    expect(shouldTrackError(404, 'all')).toBe(true);
    expect(shouldTrackError('network', 'all')).toBe(true);
    expect(shouldTrackError('cors', 'all')).toBe(true);
  });

  it('custom array tracks listed codes plus network/cors automatically', () => {
    const opt = [401, 403] as const;
    expect(shouldTrackError(401, [...opt])).toBe(true);
    expect(shouldTrackError(403, [...opt])).toBe(true);
    expect(shouldTrackError('network', [...opt])).toBe(true);
    expect(shouldTrackError('cors', [...opt])).toBe(true);
    expect(shouldTrackError(500, [...opt])).toBe(false);
    expect(shouldTrackError('timeout', [...opt])).toBe(false);
  });

  it('returns false for undefined classification', () => {
    expect(shouldTrackError(undefined, 'all')).toBe(false);
    expect(shouldTrackError(undefined, undefined)).toBe(false);
  });
});

describe('UploadError', () => {
  it('preserves classification field', () => {
    const err = new UploadError('target_failed', 'boom', { classification: 500 });
    expect(err.classification).toBe(500);
  });

  it('preserves abort classification', () => {
    const err = new UploadError('aborted', 'cancelled', { classification: 'abort' });
    expect(err.classification).toBe('abort');
  });

  it('omits classification when not provided', () => {
    const err = new UploadError('target_failed', 'boom');
    expect(err.classification).toBeUndefined();
  });
});
