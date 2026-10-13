/**
 * A tiny per-instance TTL cache.
 *
 * Measured against the live portal, live pages cost ~600-1000ms each
 * (attendance, marks, exam schedule). Answering two related questions in a row
 * re-fetched the same page both times, so the second question paid full price
 * for identical data.
 *
 * A short TTL makes repeats effectively instant while still picking up updates
 * quickly enough for real use — marks are published on faculty timetables, not
 * per second. It is deliberately NOT used for pages that change within a
 * session (timetable, semesters, grade history): those are cached for the
 * whole session instead, which is strictly safer.
 *
 * Per-instance on purpose: a VtopClient belongs to one user, so there is no
 * cross-user leakage risk.
 */

interface Entry<T> {
  value: T;
  expires: number;
}

export class TtlCache<T = string> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): T {
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  /**
   * Return the cached value, or run `load` and cache it. Concurrent callers
   * share one in-flight load rather than all hitting VTOP — without this,
   * asking two questions at once would still double the requests.
   */
  async fetch(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<T>;
    const p = load().then((v) => this.set(key, v));
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  private inflight = new Map<string, Promise<T>>();

  /** Drop everything (used on logout / session expiry). */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}

/**
 * TTL for live-but-stable pages. Long enough to make a follow-up question
 * instant, short enough that an explicit "have my marks changed yet?" still
 * sees new data.
 */
export function liveCacheTtlMs(): number {
  const raw = process.env.VTOP_LIVE_CACHE_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60_000;
  // 0 or negative disables the cache. A negative value is a misconfiguration,
  // but "disabled" is the safer reading than silently caching for some
  // unintended duration.
  return n > 0 ? n : 0;
}