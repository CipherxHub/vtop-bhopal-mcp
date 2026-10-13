/**
 * Optional cross-restart store for encrypted VTOP session blobs.
 *
 * By default the server keeps each user's authenticated VtopClient only in
 * memory (see http.ts client pool), so a redeploy or a free-tier spin-down
 * loses every session and users must log in (captcha) again. When REDIS_URL is
 * set, we additionally persist each session — encrypted with CONNECTOR_SECRET —
 * so a fresh process can rehydrate the cookies and skip the captcha+login as
 * long as VTOP still considers the session valid.
 *
 * The store only ever holds opaque ciphertext; it never sees credentials or
 * cookies in the clear. Entries are namespaced and given a TTL so dead sessions
 * expire on their own.
 */

/** One row of operator-facing usage stats, keyed by VTOP registration number. */
export interface UserStat {
  regNo: string;
  firstSeen: string;
  lastSeen: string;
  /** Fresh captcha+login events. */
  logins: number;
  /** Times an active session was resumed from the store (no fresh login). */
  reuses: number;
}

export interface SessionStore {
  /** Returns the stored ciphertext for a key, or null if absent. */
  get(key: string): Promise<string | null>;
  /** Stores ciphertext under a key with a time-to-live (seconds). */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Removes a key (e.g. on logout). */
  delete(key: string): Promise<void>;
  /** Every persisted session blob with its key, for the keepalive sweep. */
  listSessions(): Promise<{ key: string; blob: string }[]>;
  /**
   * Record activity for usage stats (first-seen set once; kept forever).
   * `kind` is "login" for a fresh captcha+login, or "reuse" when a persisted
   * session was resumed without logging in again.
   */
  recordUser(regNo: string, kind: "login" | "reuse"): Promise<void>;
  /** All recorded users, oldest first. */
  listUsers(): Promise<UserStat[]>;
  /** Short label for logs. */
  readonly kind: string;
}

const KEY_PREFIX = "vtopmcp:sess:";
// Index of live session keys so the keepalive sweep can enumerate sessions
// without a Redis keyspace SCAN.
const SESS_INDEX = "vtopmcp:sess:index";
// Usage-stats hashes (operator-facing), keyed by registration number. No TTL —
// kept forever. Atomic field ops (HSETNX/HINCRBY) avoid read-modify-write races.
const STATS_FIRST = "vtopmcp:users:first"; // regNo -> first-seen ISO
const STATS_LAST = "vtopmcp:users:last"; // regNo -> last-seen ISO
const STATS_LOGINS = "vtopmcp:users:logins"; // regNo -> fresh-login count
const STATS_REUSES = "vtopmcp:users:reuses"; // regNo -> session-resume count

/**
 * Redis-backed store. ioredis is loaded lazily (and is an optional dependency)
 * so the module is only required on deployments that actually set REDIS_URL.
 */
class RedisSessionStore implements SessionStore {
  readonly kind = "redis";
  private clientPromise: Promise<RedisLike> | null = null;

  constructor(private readonly url: string) {}

  private client(): Promise<RedisLike> {
    if (!this.clientPromise) {
      this.clientPromise = import("ioredis")
        .then((mod) => {
          const Redis = (mod.default ?? mod) as unknown as RedisCtor;
          const c = new Redis(this.url, { maxRetriesPerRequest: 2 });
          c.on("error", (e: unknown) =>
            console.error("VtopMCP: redis error:", e instanceof Error ? e.message : e),
          );
          return c;
        })
        .catch((e: unknown) => {
          this.clientPromise = null; // allow a later retry
          throw new Error(
            "REDIS_URL is set but the 'ioredis' package could not be loaded. " +
              "Install it (npm install ioredis) to enable session persistence. " +
              (e instanceof Error ? e.message : String(e)),
          );
        });
    }
    return this.clientPromise;
  }

  async get(key: string): Promise<string | null> {
    const c = await this.client();
    return c.get(KEY_PREFIX + key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const c = await this.client();
    await c.set(KEY_PREFIX + key, value, "EX", Math.max(1, Math.floor(ttlSeconds)));
    await c.sadd(SESS_INDEX, key);
  }

  async delete(key: string): Promise<void> {
    const c = await this.client();
    await c.del(KEY_PREFIX + key);
    await c.srem(SESS_INDEX, key);
  }

  async listSessions(): Promise<{ key: string; blob: string }[]> {
    const c = await this.client();
    const keys = await c.smembers(SESS_INDEX);
    const out: { key: string; blob: string }[] = [];
    for (const key of keys) {
      const blob = await c.get(KEY_PREFIX + key);
      if (blob) out.push({ key, blob });
      else await c.srem(SESS_INDEX, key); // expired/gone — prune the index
    }
    return out;
  }

  async recordUser(regNo: string, kind: "login" | "reuse"): Promise<void> {
    if (!regNo) return;
    const c = await this.client();
    const now = new Date().toISOString();
    await c.hsetnx(STATS_FIRST, regNo, now); // only the first time ever seen
    await c.hset(STATS_LAST, regNo, now);
    await c.hincrby(kind === "login" ? STATS_LOGINS : STATS_REUSES, regNo, 1);
  }

  async listUsers(): Promise<UserStat[]> {
    const c = await this.client();
    const [first, last, logins, reuses] = await Promise.all([
      c.hgetall(STATS_FIRST),
      c.hgetall(STATS_LAST),
      c.hgetall(STATS_LOGINS),
      c.hgetall(STATS_REUSES),
    ]);
    return Object.keys(first)
      .map((regNo) => ({
        regNo,
        firstSeen: first[regNo] ?? "",
        lastSeen: last[regNo] ?? "",
        logins: Number(logins[regNo] ?? 0),
        reuses: Number(reuses[regNo] ?? 0),
      }))
      .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  }
}

// Minimal structural types for the bits of ioredis we use (avoids a hard
// type-dependency on the optional package).
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  on(event: "error", listener: (err: unknown) => void): void;
}
interface RedisCtor {
  new (url: string, opts?: { maxRetriesPerRequest?: number }): RedisLike;
}

let resolved: SessionStore | null | undefined;

/**
 * The configured session store, or null when persistence is disabled (no
 * REDIS_URL). Memoized; safe to call repeatedly.
 */
export function getSessionStore(): SessionStore | null {
  if (resolved !== undefined) return resolved;
  const url = process.env.REDIS_URL?.trim();
  resolved = url ? new RedisSessionStore(url) : null;
  if (resolved) {
    console.error("VtopMCP: session persistence ON (redis) — sessions survive restarts.");
  }
  return resolved;
}
