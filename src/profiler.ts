/**
 * Lightweight phase profiler for chunk-transport flows (frontend).
 *
 * Semantics:
 *  - durationMs: wall-clock time for the phase (performance.now()).
 *  - sizeBytes / chunkIndex / status: optional context per phase.
 *
 * Phase naming mirrors the backend so traces can be correlated end-to-end:
 *  - chunk.upload[i]   — single chunk POST
 *  - total.upload      — all chunks (parallel workers included)
 *  - complete.duration — final POST /complete
 *  - total             — start → complete end-to-end
 *
 * Profiling is opt-in via SendOptions.profile.
 * - When `profile: true` and no callback: prints console.table at the end.
 * - When `onProfile` is provided: the callback receives the entries (regardless of `profile`).
 * - Every entry is also recorded as performance.mark/measure when available, so
 *   the DevTools Performance tab picks them up automatically.
 *
 * Failures inside the profiler must never break the upload flow.
 */

export interface ProfileEntry {
  phase: string;
  traceId: string;
  uploadId?: string;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  sizeBytes?: number;
  chunkIndex?: number;
  status?: number;
  outcome?: string;
  [key: string]: unknown;
}

export interface ProfilerOptions {
  enabled: boolean;
  traceId?: string;
  uploadId?: string;
  onProfile?: (entries: ProfileEntry[]) => void;
  printTable?: boolean;
}

export class Profiler {
  private readonly enabled: boolean;
  private readonly traceId: string;
  private uploadId?: string;
  private readonly onProfile?: (entries: ProfileEntry[]) => void;
  private readonly printTable: boolean;
  private readonly entries: ProfileEntry[] = [];
  private readonly active = new Map<string, number>();

  constructor(options: ProfilerOptions) {
    this.enabled = options.enabled;
    this.traceId = options.traceId ?? generateTraceId();
    this.uploadId = options.uploadId;
    this.onProfile = options.onProfile;
    this.printTable = options.printTable ?? true;
  }

  setUploadId(uploadId: string): void {
    this.uploadId = uploadId;
  }

  getTraceId(): string {
    return this.traceId;
  }

  start(phase: string, key?: string): void {
    if (!this.enabled) return;
    const now = nowMs();
    const trackKey = key ?? phase;
    this.active.set(trackKey, now);
    safeMark(`${trackKey}:start:${this.traceId}`);
  }

  end(
    phase: string,
    context: Omit<ProfileEntry, 'phase' | 'traceId' | 'durationMs' | 'startedAt' | 'endedAt'> = {},
    key?: string,
  ): void {
    if (!this.enabled) return;
    const trackKey = key ?? phase;
    const startedAt = this.active.get(trackKey);
    if (startedAt === undefined) return;
    this.active.delete(trackKey);

    const endedAt = nowMs();
    const entry: ProfileEntry = {
      phase,
      traceId: this.traceId,
      uploadId: (context.uploadId as string | undefined) ?? this.uploadId,
      durationMs: Math.round((endedAt - startedAt) * 100) / 100,
      startedAt: Math.round(startedAt),
      endedAt: Math.round(endedAt),
      ...context,
    };
    this.entries.push(entry);

    safeMark(`${trackKey}:end:${this.traceId}`);
    safeMeasure(
      `${trackKey}:${this.traceId}`,
      `${trackKey}:start:${this.traceId}`,
      `${trackKey}:end:${this.traceId}`,
    );
  }

  async measure<T>(phase: string, fn: () => Promise<T>, context?: Omit<ProfileEntry, 'phase' | 'traceId' | 'durationMs' | 'startedAt' | 'endedAt'>): Promise<T> {
    if (!this.enabled) return fn();
    this.start(phase);
    try {
      return await fn();
    } finally {
      this.end(phase, context);
    }
  }

  flush(): ProfileEntry[] {
    if (!this.enabled) return [];
    const snapshot = this.entries.slice();

    try {
      this.onProfile?.(snapshot);
    } catch {
      // Profiling callbacks must never break the upload flow.
    }

    if (this.printTable && !this.onProfile) {
      try {
        // eslint-disable-next-line no-console
        console.table(
          snapshot.map(e => ({
            phase: e.phase,
            durationMs: e.durationMs,
            sizeKB: typeof e.sizeBytes === 'number' ? Math.round(e.sizeBytes / 1024) : undefined,
            chunkIndex: e.chunkIndex,
            status: e.status,
            outcome: e.outcome,
          })),
        );
      } catch {
        // ignore
      }
    }

    return snapshot;
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function safeMark(name: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(name);
    }
  } catch {
    // ignore
  }
}

function safeMeasure(name: string, start: string, end: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      performance.measure(name, start, end);
    }
  } catch {
    // ignore
  }
}

function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'trace_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}
